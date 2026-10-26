'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createRegistryImporter, reviewRegistration } = require('../server/coverage-registration');
const { createFileCheckpoint } = require('../server/coverage-checkpoint');

test('existing-schema PostgreSQL 17 registration, isolation, recovery and rollback', { skip: !process.env.SETSCOPE_TEST_PG_CONFIG }, async t => {
  const config = JSON.parse(await fs.readFile(process.env.SETSCOPE_TEST_PG_CONFIG, 'utf8'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'postgres');
  const database = 'setscope_registry_restart_' + randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = new Pool({ ...config, max: 1 });
  const version = await admin.query('show server_version');
  assert.match(version.rows[0].server_version, /^17\./);
  await admin.query('create database ' + database);
  const pool = new Pool({ ...config, database, max: 2 });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-restart-receipts-'));
  const target = { host: config.host, database, role: config.user }, store = createFileCheckpoint(directory);
  const writer = createRegistryImporter({ pool, store, target });
  const input = n => Array.from({ length: n }, (_, i) => ({ symbol: 'S' + i, providerSymbol: 'S' + i + '.BK', market: 'SET',
    instrumentType: 'COMMON_STOCK', source: 'fixture://list', effectiveDate: '2026-10-25', rightsConfirmed: true,
    classificationConfirmed: true, rightsEvidence: 'fixture://licence', classificationEvidence: 'fixture://common' }));
  const plan = (n, runKey) => {
    const rows = input(n), r = reviewRegistration(rows);
    return { runKey, input: rows, reviewedInputKey: r.inputKey, approvedSymbols: rows.map(r => r.symbol),
      approval: { approved: true, operation: 'register', inputKey: r.inputKey, target, evidence: 'isolated fixture authorization' } };
  };
  const rollback = p => writer.rollback({ runKey: p.runKey, inputKey: p.reviewedInputKey,
    approval: { ...p.approval, operation: 'rollback' } });
  const snapshot = async () => (await pool.query('select row_to_json(c)::text as value from public.security_coverage c where symbol like \'L%\' order by symbol')).rows;
  try {
    await pool.query(await fs.readFile(path.join(__dirname, '../supabase/coverage.sql'), 'utf8'));
    await pool.query('create table public.user_watchlists(user_id uuid primary key,watchlists jsonb not null)');
    await pool.query(`insert into public.security_coverage(symbol,provider_symbol,active,status,symbol_verified,chart_ready)
      select 'L'||n,'LEGACY'||n||'.BK',false,'verified',true,true from generate_series(0,190) n`);
    const legacy = await snapshot();
    for (const total of [300, 400, 500, 1091]) await t.test('synthetic total ' + total + ': repeat import and rollback preserve 191 legacy rows', async () => {
      const p = plan(total - 191, 'scale_' + total), start = performance.now(), beforeMem = process.memoryUsage().heapUsed;
      const result = await writer.register(p);
      assert.equal(result.inserted, total - 191);
      const all = await pool.query('select count(*)::integer n from public.security_coverage');
      assert.equal(all.rows[0].n, total);
      assert.deepEqual(await snapshot(), legacy);
      const replay = await writer.register(p); assert.equal(replay.replayed, true);
      const repeated = await writer.register({ ...p, runKey: p.runKey + '_again' });
      assert.equal(repeated.inserted, 0); assert.equal(repeated.noChange, total - 191);
      assert.equal((await rollback(p)).removed, total - 191);
      assert.deepEqual(await snapshot(), legacy);
      t.diagnostic(JSON.stringify({ total, inserted: result.inserted, elapsedMs: Math.round(performance.now() - start), applicationHeapDeltaBytes: process.memoryUsage().heapUsed - beforeMem }));
    });
    await t.test('Watchlist references and mapping collision prevent registration', async () => {
      await pool.query('insert into public.user_watchlists values($1,$2::jsonb)', ['00000000-0000-4000-8000-000000000001', JSON.stringify([{ items: [{ symbol: 'S0' }] }])]);
      await assert.rejects(writer.register(plan(1, 'protected')), /Protected/);
      await pool.query('delete from public.user_watchlists');
      await pool.query("update public.security_coverage set provider_symbol='S0.BK' where symbol='L0'");
      await assert.rejects(writer.register(plan(1, 'collision')), /mapping/);
      await pool.query("update public.security_coverage set provider_symbol='LEGACY0.BK' where symbol='L0'");
      assert.deepEqual(await snapshot(), legacy);
    });
    await t.test('receipt write failure rolls the entire insert back', async () => {
      const failing = createRegistryImporter({ pool, target, store: { ...store, save: async (key, value) => {
        if (value.status === 'prepared') throw Error('fixture disk failure'); await store.save(key, value);
      } } });
      await assert.rejects(failing.register(plan(20, 'disk_failure')), /disk failure/);
      assert.equal((await pool.query("select count(*)::integer n from public.security_coverage where symbol like 'S%' ")).rows[0].n, 0);
    });
    await t.test('lost completion receipt requires read-only recovery, never blind replay', async () => {
      const p = plan(10, 'lost_completion');
      const failing = createRegistryImporter({ pool, target, store: { ...store, save: async (key, value) => {
        if (value.status === 'completed') throw Error('fixture receipt failure'); await store.save(key, value);
      } } });
      await assert.rejects(failing.register(p), /receipt failure/);
      await assert.rejects(writer.register(p), /recovery/);
      assert.equal((await writer.recover({ runKey: p.runKey, inputKey: p.reviewedInputKey })).status, 'committed');
      await writer.recover({ runKey: p.runKey, inputKey: p.reviewedInputKey, finalize: true, approval: { ...p.approval, operation: 'recover' } });
      assert.equal((await rollback(p)).removed, 10);
    });
    await t.test('lost rollback completion receipt is reconciled without another delete', async () => {
      const p = plan(2, 'lost_rollback_completion'); await writer.register(p);
      const failing = createRegistryImporter({ pool, target, store: { ...store, save: async (key, value) => {
        if (value.status === 'rolled_back') throw Error('fixture rollback receipt failure'); await store.save(key, value);
      } } });
      await assert.rejects(failing.rollback({ runKey: p.runKey, inputKey: p.reviewedInputKey, approval: { ...p.approval, operation: 'rollback' } }), /receipt failure/);
      assert.equal((await writer.recover({ runKey: p.runKey, inputKey: p.reviewedInputKey })).status, 'rolled_back');
      await writer.recover({ runKey: p.runKey, inputKey: p.reviewedInputKey, finalize: true, approval: { ...p.approval, operation: 'recover' } });
      const replay = await rollback(p); assert.equal(replay.replayed, true); assert.equal(replay.removed, 0);
      assert.deepEqual(await snapshot(), legacy);
    });
    await t.test('rollback refuses a newly verified or referenced row', async () => {
      const p = plan(1, 'changed'); await writer.register(p);
      await pool.query("update public.security_coverage set status='verified' where symbol='S0'");
      await assert.rejects(rollback(p), /changed/);
      assert.equal((await pool.query("select status from public.security_coverage where symbol='S0'")).rows[0].status, 'verified');
      await pool.query("update public.security_coverage set status='pending' where symbol='S0'");
      await pool.query('insert into public.user_watchlists values($1,$2::jsonb)', ['00000000-0000-4000-8000-000000000002', JSON.stringify([{ items: [{ symbol: 'S0' }] }])]);
      await assert.rejects(rollback(p), /Watchlist/);
      await pool.query('delete from public.user_watchlists');
      await rollback(p);
    });
    assert.deepEqual(await snapshot(), legacy);
    assert.equal((await pool.query('select count(*)::integer n from public.security_coverage')).rows[0].n, 191);
  } finally { await pool.end(); await admin.end(); }
});
