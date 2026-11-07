'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dailySource: fixtureDailySource, coverage } = require('./fixtures/daily-ohlcv.cjs');
const { latestSession } = require('../server/automation-policy');
const { retentionFloor } = require('../server/daily-ohlcv');
const { createPostgresDailyHistoryStore } = require('../server/daily-ohlcv-store');
const { createPostgresScreenerSnapshotStore } = require('../server/screener-postgres-store');
const { createScreenerService } = require('../server/screener-service');

test('OHLCV and snapshots migrate, persist, isolate roles and rollback on isolated PostgreSQL 17', {
  skip: !process.env.SETSCOPE_SCREENER_TEST_PG
}, async t => {
  const { Pool } = require('pg');
  const observedAt = Date.now();
  const currentSession = latestSession(observedAt);
  assert.ok(currentSession, 'The isolated test needs the reviewed calendar for its current date');
  const dailySource = (symbol, options = {}) => fixtureDailySource(symbol, {
    last: currentSession, fetchedAt: observedAt, ...options
  });
  const config = JSON.parse(process.env.SETSCOPE_SCREENER_TEST_PG);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'postgres');
  const name = 'setscope_ohlcv_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ ...config, max: 1 });
  let db, backend;
  try {
    assert.match((await admin.query('show server_version')).rows[0].server_version, /^17\./);
    await admin.query('create database ' + name);
    db = new Pool({ ...config, database: name, max: 3 });
    for (const role of ['anon', 'authenticated', 'service_role'])
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount)
        await admin.query('create role ' + role + ' nologin' + (role === 'service_role' ? ' bypassrls' : ''));
    const root = path.resolve(__dirname, '..');
    await db.query(await fs.readFile(path.join(root, 'supabase/proposals/v164_ohlcv_foundation.sql'), 'utf8'));
    backend = new Pool({ ...config, database: name, max: 3, options: '-c role=service_role' });
    const now = Date.now;
    const history = createPostgresDailyHistoryStore({ db: backend, now });
    const snapshots = createPostgresScreenerSnapshotStore({ db: backend });
    const source = dailySource();
    assert.equal((await history.upsert(source.records)).changed, 65);
    assert.equal((await history.upsert(source.records)).changed, 0);
    const conflicting = { ...source.records.at(-1), open: source.records.at(-1).open + .1 };
    await assert.rejects(history.upsert([conflicting]), /DAILY_VERSION_CONFLICT/);
    await assert.rejects(backend.query('select screener_private.ingest_daily($1::jsonb)', [
      JSON.stringify([JSON.stringify(source.records.at(-1)), JSON.stringify(conflicting)])
    ]), /DAILY_BATCH_CONFLICT/);
    assert.equal((await history.readMany(['PTT'])).histories.get('PTT').length, 65);
    const invalid = { ...source.records.at(-1), volume: -1 };
    await assert.rejects(backend.query('select screener_private.ingest_daily($1::jsonb)', [
      JSON.stringify([JSON.stringify(invalid)])
    ]), /DAILY_CONTRACT/);
    await db.query('begin');
    await db.query('delete from screener_private.stock_ohlcv_daily');
    await db.query('rollback');
    assert.equal((await history.readMany(['PTT'])).histories.get('PTT').length, 65);


    const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], dailyHistoryStore: history,
      snapshotStore: snapshots, now: () => observedAt });
    const first = await service.readSnapshot();
    assert.equal(first.marketFreshness, 'CURRENT_SESSION');
    await snapshots.publish(first.snapshot);
    const restarted = createPostgresScreenerSnapshotStore({ db: backend });
    assert.equal((await restarted.readPublished()).snapshot.id, first.snapshot.id);
    const independentProcess = spawnSync(process.execPath, ['-e', `
      const { Pool } = require('pg');
      const { createPostgresDailyHistoryStore } = require('./server/daily-ohlcv-store');
      const { createPostgresScreenerSnapshotStore } = require('./server/screener-postgres-store');
      let input = '';
      process.stdin.on('data', part => { input += part; });
      process.stdin.on('end', async () => {
        const db = new Pool({ ...JSON.parse(input), max: 1 });
        try {
          const history = await createPostgresDailyHistoryStore({ db }).readMany(['PTT']);
          const published = await createPostgresScreenerSnapshotStore({ db }).readPublished();
          console.log(JSON.stringify({ bars: history.histories.get('PTT').length, id: published.snapshot.id }));
        } catch (error) { console.error(error.message); process.exitCode = 1; }
        finally { await db.end(); }
      });
    `], { cwd: root, input: JSON.stringify({ ...config, database: name, options: '-c role=service_role' }),
      encoding: 'utf8', timeout: 10000 });
    assert.equal(independentProcess.status, 0, independentProcess.stderr);
    assert.deepEqual(JSON.parse(independentProcess.stdout), { bars: 65, id: first.snapshot.id });
    await snapshots.withLease(async () => {
      await assert.rejects(restarted.withLease(() => { throw Error('A second writer must not run'); }), { code: 'EEXIST' });
      assert.equal((await restarted.readPublished()).snapshot.id, first.snapshot.id);
    });
    const nextService = createScreenerService({ listCoverage: async () => [coverage('PTT')], now: () => observedAt });
    const newer = dailySource('PTT', { base: 35 });
    nextService.rememberDailyHistory('PTT', newer.meta, newer.result);
    const next = (await nextService.readSnapshot()).snapshot;
    const revision = await snapshots.revision();
    await snapshots.publish(next, { expectedRevision: revision });
    await assert.rejects(snapshots.publish(first.snapshot, { expectedRevision: revision }), /SNAPSHOT_REVISION_CONFLICT/);
    assert.equal((await snapshots.readPublished()).snapshot.id, next.id);
    await snapshots.rollback();
    assert.equal((await snapshots.readPublished()).snapshot.id, first.snapshot.id);

    const beforeHistoryCleanup = (await snapshots.readPublished()).snapshot.id;
    const oldRecords = dailySource('OLD', { count: 300 }).records;
    const cutoff = retentionFloor(Date.now());
    const ingested = await history.upsert(oldRecords);
    assert.equal(ingested.expired, oldRecords.filter(row => row.tradingDate < cutoff).length);
    assert.equal((await backend.query('select min(trading_date) as oldest_trading_date from screener_private.stock_ohlcv_daily')).rows[0].oldest_trading_date >= cutoff, true);
    await history.cleanup();
    assert.equal((await snapshots.readPublished()).snapshot.id, beforeHistoryCleanup);

    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const reading = history.withReadLease(async reader => { entered(); await gate; return reader.readMany(['PTT']); });
    await started;
    let finished = false;
    const cleaning = history.cleanup().then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(finished, false);
    release();
    assert.equal((await reading).histories.get('PTT').length, 65);
    await cleaning;

    for (const role of ['anon', 'authenticated']) {
      const client = await db.connect();
      try {
        await client.query('set role ' + role);
        for (const table of ['stock_ohlcv_daily', 'snapshots', 'snapshot_candidates', 'state'])
          await assert.rejects(client.query('select * from screener_private.' + table), { code: '42501' });
        await assert.rejects(client.query('select screener_private.cleanup_daily()'), { code: '42501' });
      } finally { await client.query('reset role'); client.release(); }
    }
    const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
    const sourceRecords = dailySource('S000', { count: 300 }).records;
    const startedAt = performance.now();
    for (let offset = 0; offset < registry.length; offset += 20) {
      const records = registry.slice(offset, offset + 20).flatMap(row => sourceRecords.map(bar => ({
        ...bar, symbol: row.symbol, providerSymbol: row.provider_symbol,
        sourceMetadata: { ...bar.sourceMetadata, symbol: row.provider_symbol }
      })));
      await history.upsert(records);
    }
    const metrics = (await db.query("select count(*) candles,pg_total_relation_size('screener_private.stock_ohlcv_daily') bytes from screener_private.stock_ohlcv_daily")).rows[0];
    const readService = createScreenerService({ listCoverage: async () => registry, dailyHistoryStore: history, now: () => observedAt });
    const envelope = await readService.readSnapshot();
    assert.equal(envelope.availability.ready, 500);
    assert.equal(envelope.marketFreshness, 'CURRENT_SESSION');
    t.diagnostic(JSON.stringify({ postgres17: true, fixtureStocks: 500, storedCandles: metrics.candles, storageBytes: metrics.bytes,
      ingestionAndReadMs: Math.round(performance.now() - startedAt), providerRequests: 0 }));
    await db.query(await fs.readFile(path.join(root, 'supabase/proposals/v164_ohlcv_foundation_rollback.sql'), 'utf8'));
    assert.equal((await db.query("select to_regnamespace('screener_private') value")).rows[0].value, null);
  } finally {
    await backend?.end();
    await db?.end();
    await admin.query('drop database if exists ' + name);
    await admin.end();
  }
});
