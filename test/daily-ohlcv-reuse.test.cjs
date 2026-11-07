'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dailySource, observedAt, session, coverage } = require('./fixtures/daily-ohlcv.cjs');
const { retentionFloor, validateDailyRecord, historyEvidence } = require('../server/daily-ohlcv');
const { createMemoryDailyHistoryStore } = require('../server/daily-ohlcv-store');
const { createScreenerService } = require('../server/screener-service');

test('shared history contract retains provider OHLCV and the actual daily confirmation proof', () => {
  const source = dailySource();
  assert.equal(source.records.length, 65);
  const last = source.records.at(-1);
  assert.equal(last.schemaVersion, 'setscope-daily-1');
  assert.equal(last.providerSymbol, 'PTT.BK');
  assert.equal(last.sessionStatus, 'SESSION_VERIFIED');
  assert.equal(last.tradingDate, session);
  assert.equal(last.availableAt, source.result.history.at(-1).availableAt);
  assert.equal(last.sourceFetchedAt, observedAt);
  assert.equal(last.confirmationBasis, 'provider-session-end');
  for (const change of [
    { providerSymbol: 'CPALL.BK' }, { low: last.high + 1 }, { volume: -1 }, { timeZone: 'UTC' },
    { tradingDate: '2026-11-05' }, { sourceFetchedAt: observedAt + 1 }, { availableAt: last.time + 1 },
    { complete: false }, { ownerId: 'fixture-user' }
  ]) assert.throws(() => validateDailyRecord({ ...last, ...change }, observedAt));
});

test('history writes are idempotent, reject conflicting versions and support incremental changes', async () => {
  const store = createMemoryDailyHistoryStore({ now: () => observedAt + 60000 });
  const source = dailySource();
  const first = await store.upsert(source.records);
  assert.equal(first.changed, 65);
  const unconfirmed = { ...source.records.at(-1), sourceFetchedAt: observedAt + 1000,
    availableAt: null, complete: false, confirmationBasis: 'unconfirmed',
    confirmationProof: { regularStart: null, regularEnd: null, nextObservedAt: null } };
  assert.equal((await store.upsert([unconfirmed])).changed, 0);
  assert.equal((await store.readMany(['PTT'])).histories.get('PTT').at(-1).complete, true);
  assert.equal((await store.upsert(source.records)).changed, 0);
  assert.equal((await store.upsert([source.records[0], source.records[0]])).changed, 0);
  const bad = { ...source.records.at(-1), open: source.records.at(-1).close + .1 };
  await assert.rejects(store.upsert([bad]), /VERSION_CONFLICT/);
  const newer = dailySource('PTT', { fetchedAt: observedAt + 60000, base: 26 });
  assert.equal((await store.upsert(newer.records)).changed, 65);
  assert.equal((await store.upsert(source.records)).changed, 0);
  const { histories } = await store.readMany(['PTT'], { asOf: observedAt + 60000 });
  assert.equal(histories.get('PTT').length, 65);
  assert.equal(histories.get('PTT').at(-1).close, newer.records.at(-1).close);
  assert.equal((await store.readMany(['PTT'], { asOf: observedAt })).histories.get('PTT').length, 0);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const reading = store.withReadLease(async () => { entered(); await gate; });
  await started;
  const mutable = structuredClone(newer.records[0]);
  const queued = store.upsert([mutable]);
  mutable.symbol = 'CPALL';
  release();
  await reading;
  await queued;
  const isolated = await store.readMany(['PTT', 'CPALL'], { asOf: observedAt + 60000 });
  assert.equal(isolated.histories.get('PTT').length, 65);
  assert.equal(isolated.histories.get('CPALL').length, 0);
  assert.equal(isolated.guardBlocked.size, 0);
});

test('Screener reuses stored daily bars and Chart history with no provider fetch and no formula changes', async () => {
  const source = dailySource();
  const store = createMemoryDailyHistoryStore({ now: () => observedAt });
  await store.upsert(source.records);
  let reads = 0;
  const reader = { ...store, withReadLease: action => { reads++; return store.withReadLease(action); } };
  const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], dailyHistoryStore: reader, now: () => observedAt });
  const a = await service.readSnapshot();
  assert.equal(a.marketFreshness, 'CURRENT_SESSION');
  assert.equal(a.reuseSources.storedHistory, 1);
  const { computeTechnicalSeries, TECHNICAL_DEFAULTS } = await import('../client/domain.mjs');
  const technical = computeTechnicalSeries(source.result.history, TECHNICAL_DEFAULTS);
  const row = a.snapshot.rows[0];
  assert.equal(row.technical.ema20, technical.ema20.at(-1));
  assert.equal(row.technical.ema50, technical.ema50.at(-1));
  assert.equal(row.technical.rsi14, technical.rsi.at(-1));
  assert.equal(row.technical.macd, technical.macd.at(-1));
  assert.equal(row.technical.macdSignal, technical.signal.at(-1));
  assert.equal((await service.readSnapshot()).snapshot.id, a.snapshot.id);
  assert.equal(reads, 1);
  const chartOnly = createScreenerService({ listCoverage: async () => [coverage('PTT')],
    snapshotStore: { readPublished: async () => ({ snapshot: null }) }, now: () => observedAt });
  chartOnly.rememberDailyHistory('PTT', source.meta, source.result);
  const b = await chartOnly.readSnapshot();
  assert.equal(b.marketFreshness, 'CURRENT_SESSION');
  assert.equal(b.reuseSources.chartHistory, 1);
  assert.equal(b.snapshot.id, a.snapshot.id);
});

test('published snapshot takes precedence and missing/stale data preserve strict complete publication', async () => {
  const source = dailySource();
  const chart = createScreenerService({ listCoverage: async () => [coverage('PTT')], now: () => observedAt });
  chart.rememberDailyHistory('PTT', source.meta, source.result);
  const snapshot = (await chart.readSnapshot()).snapshot;
  const published = createScreenerService({
    snapshotStore: { readPublished: async () => ({ snapshot }) },
    listCoverage: () => { throw Error('A valid published snapshot needs no registry refresh'); },
    dailyHistoryStore: { revision: () => { throw Error('STORAGE_UNAVAILABLE'); },
      readMany: () => { throw Error('History read forbidden'); }, withReadLease: () => { throw Error('History read forbidden'); } },
    now: () => observedAt
  });
  assert.equal((await published.readSnapshot()).reuseSources.published, 1);
  const store = createMemoryDailyHistoryStore({ now: () => observedAt });
  await store.upsert(dailySource('PTT', { last: '2026-11-05' }).records);
  const missing = createScreenerService({ listCoverage: async () => [coverage('PTT'), coverage('CPALL')],
    dailyHistoryStore: store, snapshotStore: { readPublished: async () => ({ snapshot: null }) }, now: () => observedAt });
  const stale = await missing.readSnapshot();
  assert.equal(stale.marketFreshness, 'STALE');
  assert.equal(stale.snapshot, null);
  assert.equal(stale.availability.staleSession, 1);
  assert.equal(stale.availability.unavailable, 1);
  missing.rememberDailyHistory('PTT', source.meta, source.result);
  const partial = await missing.readSnapshot();
  assert.equal(partial.marketFreshness, 'UNAVAILABLE');
  assert.equal(partial.snapshot, null);
  assert.equal(partial.availability.ready, 1);
  assert.equal(partial.availability.unavailable, 1);
});

test('365 calendar-day retention uses Trading Date, blocks cleanup during reads and preserves snapshot data', async () => {
  let clock = observedAt;
  const store = createMemoryDailyHistoryStore({ now: () => clock });
  const source = dailySource('PTT', { count: 300 });
  const floor = retentionFloor(clock);
  assert.equal(floor, '2025-11-07');
  assert.equal(retentionFloor(Date.parse('2026-11-06T16:59:59Z')), '2025-11-07');
  assert.equal(retentionFloor(Date.parse('2026-11-06T17:00:00Z')), '2025-11-08');
  assert.equal(retentionFloor(Date.parse('2024-03-01T03:00:00Z')), '2023-03-03');
  const kept = source.records.filter(record => record.tradingDate >= floor);
  const ingest = await store.upsert(source.records);
  assert.equal(ingest.expired, 300 - kept.length);
  assert.equal((await store.readMany(['PTT'])).histories.get('PTT')[0].tradingDate, floor);
  const evidence = historyEvidence(kept, 'PTT', clock);
  const { computeTechnicalSeries, TECHNICAL_DEFAULTS } = await import('../client/domain.mjs');
  assert.ok(Number.isFinite(computeTechnicalSeries(evidence.bars, TECHNICAL_DEFAULTS).ema200.at(-1)));
  const short = dailySource('AOT', { count: 100 });
  assert.equal(computeTechnicalSeries(short.result.history, TECHNICAL_DEFAULTS).ema200.at(-1), null);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const reading = store.withReadLease(async reader => {
    entered(); await gate;
    return (await reader.readMany(['PTT'], { asOf: observedAt })).histories.get('PTT').length;
  });
  await started;
  clock += 7 * 86400000;
  let cleaned = false;
  const cleanup = store.cleanup().then(value => { cleaned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, false);
  release();
  assert.equal(await reading, kept.length);
  assert.ok(await cleanup > 0);
  assert.ok((await store.readMany(['PTT'])).histories.get('PTT').every(record => record.tradingDate >= retentionFloor(clock)));
});

test('explicit backfill reuses Chart evidence and newer history invalidates the memory snapshot cache', async () => {
  const store = createMemoryDailyHistoryStore({ now: () => observedAt });
  const source = dailySource();
  const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], dailyHistoryStore: store, now: () => observedAt });
  assert.equal((await service.readSnapshot()).marketFreshness, 'UNAVAILABLE');
  service.rememberDailyHistory('PTT', source.meta, source.result);
  assert.equal((await service.readSnapshot()).marketFreshness, 'CURRENT_SESSION');
  assert.equal((await service.backfillExistingHistory()).changed, 65);
  assert.equal((await service.backfillExistingHistory()).changed, 0);
  assert.equal((await service.readSnapshot()).reuseSources.storedHistory, 1);
});

test('500-stock, 300-trading-bar simulation applies 365-day retention and preserves EMA200 evidence', async t => {
  const source = dailySource('S000', { count: 300 });
  const store = createMemoryDailyHistoryStore({ now: () => observedAt });
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  const keptPerStock = source.records.filter(record => record.tradingDate >= retentionFloor(observedAt)).length;
  const started = performance.now();
  let serialized = 0, changed = 0;
  for (let offset = 0; offset < 500; offset += 20) {
    const records = registry.slice(offset, offset + 20).flatMap(row => source.records.map(record => ({
      ...record, symbol: row.symbol, providerSymbol: row.provider_symbol,
      sourceMetadata: { ...record.sourceMetadata, symbol: row.provider_symbol }
    })));
    serialized += Buffer.byteLength(JSON.stringify(records));
    changed += (await store.upsert(records)).changed;
  }
  assert.equal(changed, 500 * keptPerStock);
  const service = createScreenerService({ listCoverage: async () => registry, dailyHistoryStore: store, now: () => observedAt });
  const beforeRead = performance.now();
  const data = await service.readSnapshot();
  const readMs = performance.now() - beforeRead;
  assert.equal(data.availability.ready, 500);
  assert.equal(data.snapshot.state, 'COMPLETE');
  const { queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const start = performance.now();
    const snapshot = await service.readSnapshot();
    const found = queryScreenerSnapshot(snapshot.snapshot, { ema50: 'above', macd: 'above' }, { page: i % 25 + 1 });
    assert.equal(found.counts.matched, 500);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ simulatedStocks: 500, inputTradingBars: 300, retainedPerStock: keptPerStock,
    retainedCandles: changed, inputJsonBytes: serialized, coldBuildMs: +readMs.toFixed(2),
    warmFilterP95Ms: +samples[37].toFixed(2), totalMs: Math.round(performance.now() - started),
    rssBytes: process.memoryUsage().rss, providerRequests: 0, retentionCalendarDays: 365 }));
});

test('corrupted stored history is Guard Blocked and valid independent Chart evidence can recover it', async () => {
  const source = dailySource();
  const records = source.records.map(record => ({ ...record }));
  records.at(-1).close = -1;
  const broken = {
    revision: async () => 'broken',
    withReadLease: action => action({ readMany: async () => ({ histories: new Map([['PTT', records]]), guardBlocked: new Set() }) })
  };
  const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], dailyHistoryStore: broken, now: () => observedAt });
  const blocked = await service.readSnapshot();
  assert.equal(blocked.availability.guardBlocked, 1);
  assert.equal(blocked.marketFreshness, 'UNAVAILABLE');
  service.rememberDailyHistory('PTT', source.meta, source.result);
  assert.equal((await service.readSnapshot()).marketFreshness, 'CURRENT_SESSION');
});

test('unavailable history storage falls back only to independently guarded Chart evidence', async () => {
  const broken = { revision: async () => 'offline', withReadLease: async () => { throw Error('STORAGE_UNAVAILABLE'); } };
  const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], dailyHistoryStore: broken, now: () => observedAt });
  const missing = await service.readSnapshot();
  assert.equal(missing.marketFreshness, 'UNAVAILABLE');
  assert.equal(missing.availability.unavailable, 1);
  assert.equal(missing.reuseSources.historyUnavailable, true);
  const source = dailySource();
  service.rememberDailyHistory('PTT', source.meta, source.result);
  const recovered = await service.readSnapshot();
  assert.equal(recovered.marketFreshness, 'CURRENT_SESSION');
  assert.equal(recovered.reuseSources.chartHistory, 1);
  assert.equal(recovered.reuseSources.historyUnavailable, true);
});

test('reuse API keeps market snapshots account-neutral and makes zero provider calls', async () => {
  const store = createMemoryDailyHistoryStore({ now: () => observedAt });
  await store.upsert(dailySource().records);
  const factory = require('../server/screener-service');
  const original = factory.createScreenerService;
  factory.createScreenerService = options => original({ ...options, dailyHistoryStore: store,
    listCoverage: async () => [coverage('PTT')], now: () => observedAt });
  process.env.SUPABASE_URL = 'https://reuse-fixture.invalid';
  process.env.SUPABASE_ANON_KEY = 'fixture-public';
  const nativeFetch = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = async (input, init) => {
    upstream++;
    assert.equal(String(input), 'https://reuse-fixture.invalid/auth/v1/user');
    return Response.json({ id: String(init.headers.Authorization).includes('user-b') ? 'user-b' : 'user-a' });
  };
  const { server } = require('../server');
  factory.createScreenerService = original;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/screener';
    assert.equal((await nativeFetch(base)).status, 401);
    const payloads = [];
    for (const id of ['user-a', 'user-b']) {
      const response = await nativeFetch(base + '?owner=' + id, { headers: { authorization: 'Bearer fixture-' + id } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      payloads.push(await response.text());
    }
    assert.equal(payloads[0], payloads[1]);
    assert.equal(JSON.parse(payloads[0]).availability.ready, 1);
    assert.doesNotMatch(payloads[0], /user-a|user-b|watchlist|fixture-private/);
    assert.equal(upstream, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = nativeFetch;
  }
});

test('durable snapshot adapter validates recovery independently and never publishes a failed stage', async () => {
  const { createPostgresScreenerSnapshotStore } = require('../server/screener-postgres-store');
  const { fingerprint } = require('../server/daily-ohlcv');
  const service = createScreenerService({ listCoverage: async () => [coverage('PTT')], now: () => observedAt });
  const source = dailySource();
  service.rememberDailyHistory('PTT', source.meta, source.result);
  const snapshot = (await service.readSnapshot()).snapshot;
  const text = JSON.stringify(snapshot);
  let current = 'corrupt', previous = text, failStage = false, publishes = 0, rollbacks = 0;
  const db = {
    connect() { throw Error('No actual database used by this unit fixture'); },
    async query(sql) {
      if (sql.startsWith('select snapshot_revision')) return { rows: [{ snapshot_revision: 2 }] };
      if (sql.startsWith('insert into')) { if (failStage) throw Error('STORAGE_UNAVAILABLE'); return { rows: [] }; }
      if (sql.startsWith('select screener_private.publish_snapshot')) { publishes++; return { rows: [] }; }
      if (sql.startsWith('select screener_private.rollback_snapshot')) { rollbacks++; return { rows: [] }; }
      return { rows: [{ snapshot_revision: 2, current_text: current, current_hash: fingerprint(text),
        previous_text: previous, previous_hash: fingerprint(previous) }] };
    }
  };
  const store = createPostgresScreenerSnapshotStore({ db });
  assert.equal((await store.readPublished()).recovered, true);
  assert.equal((await store.readPublished()).snapshot.id, snapshot.id);
  previous = JSON.stringify({ ...snapshot, state: 'PARTIAL' });
  assert.equal((await store.readPublished()).snapshot, null);
  current = text;
  assert.equal((await store.readPublished()).recovered, false);
  await assert.rejects(store.rollback(), /INVALID_SCREENER_SNAPSHOT/);
  assert.equal(rollbacks, 0);
  failStage = true;
  await assert.rejects(store.publish(snapshot), /STORAGE_UNAVAILABLE/);
  assert.equal(publishes, 0);
  assert.equal((await store.readPublished()).snapshot.id, snapshot.id);
});

test('a PostgreSQL lease cleanup failure discards the affected connection', async () => {
  const { createPostgresScreenerSnapshotStore } = require('../server/screener-postgres-store');
  const failure = new Error('connection lost while releasing lease');
  const released = [];
  const client = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock') || sql === 'rollback') throw failure;
      return { rows: [] };
    },
    release(error) { released.push(error); }
  };
  const db = { connect: async () => client, query: async () => { throw Error('unexpected query'); } };
  await assert.rejects(createPostgresScreenerSnapshotStore({ db }).withLease(() => null), failure);
  const readError = new Error('history read failed');
  const { createPostgresDailyHistoryStore } = require('../server/daily-ohlcv-store');
  await assert.rejects(createPostgresDailyHistoryStore({ db }).withReadLease(() => { throw readError; }), readError);
  assert.deepEqual(released, [failure, failure]);
});
