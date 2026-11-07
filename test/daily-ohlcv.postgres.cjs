'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { dailySource: fixtureDailySource, coverage } = require('./fixtures/daily-ohlcv.cjs');
const { latestSession } = require('../server/automation-policy');
const { fingerprint, retentionFloor } = require('../server/daily-ohlcv');
const { createPostgresDailyHistoryStore } = require('../server/daily-ohlcv-store');
const { createPostgresScreenerSnapshotStore } = require('../server/screener-postgres-store');
const { createScreenerSnapshotStore } = require('../server/screener-snapshot-store');
const { createScreenerService } = require('../server/screener-service');

const storageQueries = {
  history: 'select record_text, content_sha256 from screener_private.stock_ohlcv_daily order by provider_symbol, trading_date',
  snapshots: 'select payload_text, content_sha256 from screener_private.snapshots order by content_sha256',
  candidates: 'select payload_text, content_sha256 from screener_private.snapshot_candidates order by content_sha256',
  state: 'select * from screener_private.state where singleton'
};

async function storageImage(client) {
  const image = {};
  for (const [name, sql] of Object.entries(storageQueries)) image[name] = (await client.query(sql)).rows;
  return image;
}

async function rehearseRestore(source, target, file) {
  const reader = await source.connect();
  let original;
  try {
    await reader.query('begin isolation level repeatable read read only');
    original = await storageImage(reader);
    await reader.query('commit');
  } catch (error) {
    await reader.query('rollback');
    throw error;
  } finally { reader.release(); }
  await fs.writeFile(file, JSON.stringify(original), { flag: 'wx', mode: 0o600 });
  const archive = JSON.parse(await fs.readFile(file, 'utf8'));
  const writer = await target.connect();
  try {
    await writer.query('begin');
    for (const row of archive.history)
      await writer.query('insert into screener_private.stock_ohlcv_daily(record_text) values($1)', [row.record_text]);
    for (const row of archive.snapshots)
      await writer.query('insert into screener_private.snapshots(payload_text) values($1)', [row.payload_text]);
    for (const row of archive.candidates)
      await writer.query('insert into screener_private.snapshot_candidates(payload_text) values($1)', [row.payload_text]);
    const s = archive.state[0];
    await writer.query('update screener_private.state set history_revision=$1,snapshot_revision=$2,current_hash=$3,previous_hash=$4,cooldown_until=$5 where singleton',
      [s.history_revision, s.snapshot_revision, s.current_hash, s.previous_hash, s.cooldown_until]);
    assert.deepEqual(await storageImage(writer), original);
    await writer.query('commit');
  } catch (error) {
    await writer.query('rollback');
    throw error;
  } finally { writer.release(); }
}

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
  const restoreName = name + '_restore';
  const admin = new Pool({ ...config, max: 1 });
  let db, backend, restored, denied, temporary;
  try {
    assert.match((await admin.query('show server_version')).rows[0].server_version, /^17\./);
    await admin.query('create database ' + name);
    db = new Pool({ ...config, database: name, max: 3 });
    for (const role of ['anon', 'authenticated', 'service_role'])
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount)
        await admin.query('create role ' + role + ' nologin' + (role === 'service_role' ? ' bypassrls' : ''));
    const root = path.resolve(__dirname, '..');
    const proposal = await fs.readFile(path.join(root, 'supabase/proposals/v164_ohlcv_foundation.sql'), 'utf8');
    await db.query(proposal);
    backend = new Pool({ ...config, database: name, max: 3, options: '-c role=service_role' });
    const now = Date.now;
    const history = createPostgresDailyHistoryStore({ db: backend, now });
    const snapshots = createPostgresScreenerSnapshotStore({ db: backend });
    const source = dailySource();
    assert.equal((await history.upsert(source.records)).changed, 65);
    assert.equal((await history.upsert(source.records)).changed, 0);
    const unconfirmed = { ...source.records.at(-1), sourceFetchedAt: observedAt + 1,
      availableAt: null, complete: false, confirmationBasis: 'unconfirmed',
      confirmationProof: { regularStart: null, regularEnd: null, nextObservedAt: null } };
    assert.equal((await history.upsert([unconfirmed])).changed, 0);
    assert.equal((await history.readMany(['PTT'])).histories.get('PTT').at(-1).complete, true);
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


    const service = createScreenerService({ listCoverage: async () => [coverage('PTT'), { ...coverage('ZZZ'), active: false }], dailyHistoryStore: history,
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
    await assert.rejects(backend.query("select screener_private.publish_snapshot('',null)"), { code: '40001' });
    await assert.rejects(backend.query('select screener_private.rollback_snapshot(null)'), { code: '40001' });
    const state = async () => (await db.query(
      'select current_hash,previous_hash,snapshot_revision from screener_private.state where singleton'
    )).rows[0];
    const accepted = await state();
    let negativeCases = 0;
    async function rejectCandidate(candidate, label) {
      const payload = JSON.stringify(candidate);
      await backend.query('insert into screener_private.snapshot_candidates(payload_text) values($1) on conflict do nothing', [payload]);
      await assert.rejects(backend.query('select screener_private.publish_snapshot($1,$2::bigint)',
        [fingerprint(payload), accepted.snapshot_revision]), /INVALID_SNAPSHOT/, label);
      assert.deepEqual(await state(), accepted, label);
      negativeCases++;
    }
    for (const key of Object.keys(next.counts)) {
      for (const value of [null, String(next.counts[key]), 0.5, -1, undefined, next.counts[key] + 1]) {
        await rejectCandidate({ ...next, counts: { ...next.counts, [key]: value } }, key + '=' + value);
      }
    }
    for (const key of ['id', 'sessionDate', 'latestCompletedSessionDate', 'generatedAt', 'schemaVersion', 'state', 'rows', 'counts']) {
      for (const value of [null, undefined]) await rejectCandidate({ ...next, [key]: value }, key + '=' + value);
    }
    for (const row of [
      { ...next.rows[0], symbol: null },
      { ...next.rows[0], eligible: 'true' },
      { ...next.rows[0], state: 'STALE_SESSION' },
      { ...next.rows[0], confirmedBars: 1.5 },
      { ...next.rows[0], available: { ...next.rows[0].available, price: null } },
      { ...next.rows[0], sourceAsOf: null },
      { ...next.rows[0], price: { ...next.rows[0].price, close: null } }
    ]) await rejectCandidate({ ...next, rows: [row] }, 'invalid ready row');
    await rejectCandidate({ ...next, counts: { ...next.counts, registered: 2, eligible: 2, ready: 2 },
      rows: [next.rows[0], next.rows[0]] }, 'duplicate symbol with consistent counts');
    assert.equal((await snapshots.readPublished()).snapshot.id, next.id);

    const invalidPrevious = JSON.stringify({ ...first.snapshot, counts: { ...first.snapshot.counts, ready: null } });
    await db.query('insert into screener_private.snapshots(payload_text) values($1)', [invalidPrevious]);
    await db.query('update screener_private.state set previous_hash=$1,snapshot_revision=snapshot_revision+1 where singleton',
      [fingerprint(invalidPrevious)]);
    const corruptState = await state();
    await assert.rejects(snapshots.rollback(), /INVALID_SCREENER_SNAPSHOT/);
    await assert.rejects(backend.query('select screener_private.rollback_snapshot($1::bigint)', [corruptState.snapshot_revision]), /INVALID_SNAPSHOT/);
    assert.deepEqual(await state(), corruptState);
    await db.query('update screener_private.state set previous_hash=$1,snapshot_revision=snapshot_revision+1 where singleton',
      [accepted.previous_hash]);

    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-ws6d-'));
    await db.query('create view public.ws6d_snapshot_dependency as select snapshot_revision from screener_private.state');
    const beforeRecovery = await storageImage(db);
    const fileStore = createScreenerSnapshotStore(temporary);
    await fileStore.withLease(() => fileStore.publish(next));
    denied = new Pool({ ...config, database: name, max: 1, options: '-c role=authenticated' });
    const activate = store => createScreenerService({ snapshotStore: store, now: () => observedAt });
    await assert.rejects(activate(createPostgresScreenerSnapshotStore({ db: denied })).readSnapshot(), { code: '42501' });
    assert.equal((await activate(fileStore).readSnapshot()).snapshot.id, next.id);
    await backend.query(await fs.readFile(path.join(root, 'supabase/proposals/v164_ohlcv_foundation_rollback.sql'), 'utf8'));
    assert.deepEqual(await storageImage(db), beforeRecovery);
    assert.equal((await db.query('select snapshot_revision from public.ws6d_snapshot_dependency')).rows[0].snapshot_revision,
      beforeRecovery.state[0].snapshot_revision);

    await admin.query('create database ' + restoreName);
    restored = new Pool({ ...config, database: restoreName, max: 1 });
    await restored.query(proposal);
    await rehearseRestore(db, restored, path.join(temporary, 'isolated-backup.json'));
    const restoredSnapshots = createPostgresScreenerSnapshotStore({ db: restored });
    assert.equal((await restoredSnapshots.readPublished()).snapshot.id, next.id);
    await restoredSnapshots.rollback();
    assert.equal((await restoredSnapshots.readPublished()).snapshot.id, first.snapshot.id);
    assert.deepEqual((await storageImage(restored)).history, beforeRecovery.history);

    await snapshots.rollback();
    assert.equal((await snapshots.readPublished()).snapshot.id, first.snapshot.id);
    const recovered = await storageImage(db);
    assert.deepEqual(recovered.history, beforeRecovery.history);
    assert.deepEqual(recovered.snapshots, beforeRecovery.snapshots);
    assert.equal(recovered.state[0].current_hash, beforeRecovery.state[0].previous_hash);
    assert.equal(BigInt(recovered.state[0].snapshot_revision), BigInt(beforeRecovery.state[0].snapshot_revision) + 1n);
    assert.equal((await db.query('select snapshot_revision from public.ws6d_snapshot_dependency')).rows[0].snapshot_revision,
      recovered.state[0].snapshot_revision);
    t.diagnostic(JSON.stringify({ negativeCases, rejectedStateUnchanged: true, corruptPreviousRejected: true,
      applicationFallback: true, externalDependencyPreserved: true, backupRestore: true }));

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
    const rebuildStart = performance.now();
    const envelope = await readService.readSnapshot();
    const coldRebuildMs = Math.round(performance.now() - rebuildStart);
    const ingestionAndReadMs = Math.round(performance.now() - startedAt);
    assert.equal(envelope.availability.ready, 500);
    assert.equal(envelope.marketFreshness, 'CURRENT_SESSION');
    const publishStart = performance.now();
    await snapshots.publish(envelope.snapshot);
    const publish500Ms = Math.round(performance.now() - publishStart);
    const retained = (await history.readMany(['S000'], { asOf: observedAt })).histories.get('S000');
    const estimatedPayloadBytes = retained.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0) * registry.length;
    t.diagnostic(JSON.stringify({ postgres17: true, fixtureStocks: 500, storedCandles: metrics.candles, storageBytes: metrics.bytes,
      ingestionAndReadMs, coldRebuildMs, publish500Ms, retainedPerStock: retained.length, estimatedPayloadBytes, providerRequests: 0 }));
  } finally {
    await denied?.end();
    await restored?.end();
    await backend?.end();
    await db?.end();
    await admin.query('drop database if exists ' + restoreName);
    await admin.query('drop database if exists ' + name);
    await admin.end();
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
});
