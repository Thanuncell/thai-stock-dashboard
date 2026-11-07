'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { coverage, dailyBars, guardedDaily, observedAt, session } = require('./fixtures/screener.cjs');
const { createScreenerAcquisition } = require('../server/screener-acquisition');
const { createScreenerSnapshotStore } = require('../server/screener-snapshot-store');
const { guardedDailyEvidence, createScreenerService } = require('../server/screener-service');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-ws5-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  return { directory, store: createScreenerSnapshotStore(directory) };
}

async function snapshot(count = 1, base = 25) {
  const { buildScreenerSnapshot } = await import('../client/screener-core.mjs');
  const registry = Array.from({ length: count }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  const bars = dailyBars(session, 65, base);
  const evidenceBySymbol = Object.fromEntries(registry.map(row => {
    const item = guardedDaily(row.symbol, bars);
    return [row.symbol, guardedDailyEvidence(item.meta, item.result)];
  }));
  return { ...buildScreenerSnapshot({ registry, evidenceBySymbol, sessionDate: session,
    latestCompletedSessionDate: session, observedAt }), state: 'COMPLETE' };
}

function runner(store, registry, readDaily, options) {
  return createScreenerAcquisition({ store, listCoverage: async () => registry,
    readDaily, now: () => observedAt, sleep: async () => {}, ...options });
}

test('a repeated successful session reuses the published universe without provider amplification', async t => {
  const { store } = await fixture(t);
  let requests = 0;
  const registry = [coverage('PTT')];
  const run = runner(store, registry, async symbol => { requests++; return guardedDaily(symbol, dailyBars()); });
  assert.equal((await run.run({ maxRequests: 1 })).status, 'PUBLISHED');
  assert.equal((await run.run({ maxRequests: 1 })).status, 'ALREADY_CURRENT');
  assert.equal(requests, 1);
});

test('malformed or guard-rejected daily responses stop a batch before it expands to the universe', async t => {
  const { store } = await fixture(t);
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + i));
  let requests = 0;
  const result = await runner(store, registry, async symbol => {
    requests++;
    const item = guardedDaily(symbol, dailyBars());
    item.result.guardStatus = 'suspect';
    item.result.guardReasons = ['INVALID_NUMERIC'];
    return item;
  }).run({ maxRequests: 500 });
  assert.equal(result.status, 'INVALID_DATA');
  assert.ok(requests <= 4);
  assert.equal((await store.readPublished()).snapshot, null);
});

test('a failed primary replacement preserves both the current snapshot and its rollback target', async t => {
  const { directory, store } = await fixture(t);
  const a = await snapshot(1, 25), b = await snapshot(1, 35), c = await snapshot(1, 45);
  await store.withLease(() => store.publish(a));
  await store.withLease(() => store.publish(b));
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path.join(directory, 'published.json')) throw Object.assign(Error('fixture disk full'), { code: 'ENOSPC' });
    return originalRename(from, to);
  };
  try { await assert.rejects(store.withLease(() => store.publish(c)), { code: 'ENOSPC' }); }
  finally { fs.rename = originalRename; }
  assert.equal((await store.readPublished()).snapshot.id, b.id);
  await store.withLease(() => store.rollback());
  assert.equal((await store.readPublished()).snapshot.id, a.id);
});

test('old storage version remains readable and rollback survives a version upgrade', async t => {
  const { directory, store } = await fixture(t);
  const a = await snapshot(1, 25), b = await snapshot(1, 35), c = await snapshot(1, 45);
  const envelope = payload => JSON.stringify({
    version: 1, digest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload
  });
  await fs.writeFile(path.join(directory, 'published.json'), envelope(b));
  await fs.writeFile(path.join(directory, 'previous.json'), envelope(a));
  assert.equal((await store.readPublished()).snapshot.id, b.id);
  await store.withLease(() => store.rollback());
  assert.equal((await store.readPublished()).snapshot.id, a.id);
  await store.withLease(() => store.publish(c));
  const upgraded = JSON.parse(await fs.readFile(path.join(directory, 'published.json')));
  assert.equal(upgraded.version, 2);
  assert.equal(upgraded.payload.current.id, c.id);
  assert.equal(upgraded.payload.previous.id, a.id);
  const legacyFallback = JSON.parse(await fs.readFile(path.join(directory, 'previous.json')));
  assert.equal(legacyFallback.version, 1);
  assert.equal(legacyFallback.payload.id, a.id, 'the previous app can read the prior snapshot after an application rollback');
});

test('disk full, write/sync failures and permissions errors keep the published pair usable', async t => {
  const { directory, store } = await fixture(t);
  const a = await snapshot(1, 25), b = await snapshot(1, 35), c = await snapshot(1, 45);
  await store.withLease(() => store.publish(a));
  await store.withLease(() => store.publish(b));
  for (const [operation, code] of [['open', 'EACCES'], ['writeFile', 'ENOSPC'], ['sync', 'EIO']]) {
    const originalOpen = fs.open;
    fs.open = async (filename, ...args) => {
      if (filename !== path.join(directory, 'published.stage')) return originalOpen(filename, ...args);
      if (operation === 'open') throw Object.assign(Error('fixture-private-storage-diagnostic'), { code });
      const handle = await originalOpen(filename, ...args);
      handle[operation] = async () => { throw Object.assign(Error('fixture-private-storage-diagnostic'), { code }); };
      return handle;
    };
    try { await assert.rejects(store.withLease(() => store.publish(c)), { code }); }
    finally { fs.open = originalOpen; }
    assert.equal((await store.readPublished()).snapshot.id, b.id);
    const primary = JSON.parse(await fs.readFile(path.join(directory, 'published.json')));
    assert.equal(primary.payload.previous.id, a.id);
  }
  // Re-publishing the same complete content cannot replace its rollback target.
  await store.withLease(() => store.publish(b));
  await store.withLease(() => store.rollback());
  assert.equal((await store.readPublished()).snapshot.id, a.id);
});

test('concurrent runs share no acquisition work and a completed universe is reused after restart', async t => {
  const { directory, store } = await fixture(t);
  const registry = [coverage('PTT')];
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const read = async symbol => { calls++; entered(); await waiting; return guardedDaily(symbol, dailyBars()); };
  const first = runner(store, registry, read).run({ maxRequests: 1 });
  await started;
  try {
    await assert.rejects(runner(createScreenerSnapshotStore(directory), registry, read).run({ maxRequests: 1 }), { code: 'EEXIST' });
    assert.equal(calls, 1);
  } finally { release(); }
  assert.equal((await first).status, 'PUBLISHED');
  const again = await runner(createScreenerSnapshotStore(directory), registry, read).run({ maxRequests: 1 });
  assert.equal(again.status, 'ALREADY_CURRENT');
  assert.equal(again.requests, 0);
  assert.equal(calls, 1);
  const changed = await runner(store, [...registry, { ...coverage('AOT'), active: false }], read).run({ maxRequests: 1 });
  assert.equal(changed.status, 'PUBLISHED', 'a changed Coverage universe must be re-evaluated');
  assert.equal(calls, 2);
});

test('401/403/429, malformed records and request budgets do not amplify provider traffic', async t => {
  const { directory, store } = await fixture(t);
  const registry = Array.from({ length: 40 }, (_, i) => coverage('S' + i));
  for (const status of [401, 403]) {
    let calls = 0;
    const result = await runner(store, registry, async () => {
      calls++;
      throw Object.assign(Error('fixture denial'), { status });
    }).run({ maxRequests: 40 });
    assert.equal(result.status, 'PROVIDER_STOPPED');
    assert.ok(calls <= 4);
  }
  for (const bad of [{ meta: {}, result: null }, { meta: { dataGranularity: '1d', exchangeTimezoneName: 'Asia/Bangkok' }, result: {} }]) {
    let calls = 0;
    const result = await runner(store, registry, async () => { calls++; return bad; }).run({ maxRequests: 40 });
    assert.equal(result.status, 'INVALID_DATA');
    assert.ok(calls <= 4);
  }
  const attempted = [];
  const transient = await runner(store, registry, async symbol => {
    attempted.push(symbol);
    throw Object.assign(Error('fixture outage'), { status: 503 });
  }).run({ maxRequests: 7 });
  assert.equal(transient.requests, 7);
  assert.equal(transient.status, 'BUDGET_EXHAUSTED');
  for (const symbol of new Set(attempted)) assert.ok(attempted.filter(item => item === symbol).length <= 2);

  let calls = 0;
  const rate = await runner(store, registry, async () => {
    calls++;
    throw Object.assign(Error('fixture limit'), { status: 429, retryAfter: new Date(observedAt + 3600000).toUTCString() });
  }).run({ maxRequests: 40 });
  assert.equal(rate.status, 'RATE_LIMITED');
  assert.ok(calls <= 4);
  const restarted = await runner(createScreenerSnapshotStore(directory), registry, () => {
    assert.fail('provider must remain in cooldown');
  }).run({ maxRequests: 40 });
  assert.equal(restarted.status, 'COOLDOWN');
  assert.equal(restarted.requests, 0);
  assert.equal(restarted.cooldownUntil, new Date(observedAt + 3600000).toISOString());
});

test('unavailable storage and uncertain leases fail closed before acquisition starts', async t => {
  const { directory, store } = await fixture(t);
  let calls = 0;
  const registry = [coverage('PTT')];
  const read = () => { calls++; return guardedDaily('PTT', dailyBars()); };
  const lock = createHash('sha256').update('screener-snapshot-writer-v1').digest('hex');
  await fs.writeFile(path.join(directory, lock + '.lock.reclaim'), '');
  await assert.rejects(runner(store, registry, read).run({ maxRequests: 1 }), { code: 'EEXIST' });
  assert.equal(calls, 0);
  await fs.unlink(path.join(directory, lock + '.lock.reclaim'));
  await fs.writeFile(path.join(directory, 'cooldown.json'), '{');
  await assert.rejects(runner(store, registry, read).run({ maxRequests: 1 }), /COOLDOWN_CORRUPT/);
  assert.equal(calls, 0);
  await fs.unlink(path.join(directory, 'cooldown.json'));
  const originalOpen = fs.open;
  fs.open = async (filename, ...args) => {
    if (filename === path.join(directory, 'published.json')) throw Object.assign(Error('fixture storage offline'), { code: 'EIO' });
    return originalOpen(filename, ...args);
  };
  try { await assert.rejects(runner(store, registry, read).run({ maxRequests: 1 }), { code: 'EIO' }); }
  finally { fs.open = originalOpen; }
  assert.equal(calls, 0);
});

test('invalid snapshot versions, values, sessions and dates cannot become current', async t => {
  const { directory, store } = await fixture(t);
  const good = await snapshot();
  await store.withLease(() => store.publish(good));
  const alterations = [
    value => { value.rows[0].technical.rsi14 = 101; },
    value => { value.rows[0].technical.ema20 = -1; },
    value => { value.rows[0].sourceAsOf = '2026-11-07T11:30:00.000Z'; },
    value => { value.rows[0].candleTime = '2026-11-05T03:00:00.000Z'; },
    value => { value.rows[0].sourceAsOf = '2026-11-06T25:00:00.000Z'; },
    value => { value.state = 'PARTIAL'; },
    value => { value.counts.ready = 0; },
    value => { value.rows[0].ownerId = 'fixture-account'; }
  ];
  for (const alter of alterations) {
    const changed = structuredClone(good);
    alter(changed);
    await assert.rejects(store.withLease(() => store.publish(changed)), /INVALID_SCREENER/);
    assert.equal((await store.readPublished()).snapshot.id, good.id);
  }
  const primary = JSON.parse(await fs.readFile(path.join(directory, 'published.json')));
  primary.version = 999;
  await fs.writeFile(path.join(directory, 'published.json'), JSON.stringify(primary));
  const service = createScreenerService({ snapshotStore: createScreenerSnapshotStore(directory), now: () => observedAt });
  assert.equal((await service.readSnapshot()).marketFreshness, 'UNAVAILABLE');
});

test('approved safe partial read never weakens strict complete durable publication', async t => {
  const { store } = await fixture(t);
  const { buildScreenerSnapshot, queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  const bars = dailyBars();
  const evidenceBySymbol = Object.fromEntries(registry.slice(0, 499).map(row => {
    const item = guardedDaily(row.symbol, bars);
    return [row.symbol, guardedDailyEvidence(item.meta, item.result)];
  }));
  const partial = buildScreenerSnapshot({ registry, evidenceBySymbol, sessionDate: session, latestCompletedSessionDate: session, observedAt });
  assert.equal(partial.state, 'PARTIAL');
  assert.equal(partial.counts.eligible, 500);
  assert.equal(partial.counts.ready, 499);
  assert.equal(partial.counts.unavailable, 1);
  assert.equal(queryScreenerSnapshot(partial).counts.matched, 499, 'only guarded READY rows are screened');
  await assert.rejects(store.withLease(() => store.publish(partial)), /INVALID_SCREENER/);
  const service = createScreenerService({ listCoverage: async () => registry, now: () => observedAt });
  for (const row of registry.slice(0, 499)) {
    const item = guardedDaily(row.symbol, bars);
    service.rememberDailyHistory(row.symbol, item.meta, item.result);
  }
  const envelope = await service.readSnapshot();
  assert.equal(envelope.marketFreshness, 'CURRENT_SESSION');
  assert.equal(envelope.snapshot.state, 'PARTIAL');
  assert.equal(queryScreenerSnapshot(envelope.snapshot).counts.matched, 499);
});

test('500-stock cold reader, warm cache, filter and memory measurements stay provider-free', async t => {
  const { directory: storeDirectory, store } = await fixture(t);
  const data = await snapshot(500);
  await store.withLease(() => store.publish(data));
  await store.withLease(async () => store.publish(await snapshot(500, 35)));
  const { queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  let diskReads = 0;
  const source = { revision: store.revision, readPublished: () => { diskReads++; return store.readPublished(); } };
  const heapBefore = process.memoryUsage().heapUsed;
  const cold = [];
  for (let i = 0; i < 15; i++) {
    const service = createScreenerService({ snapshotStore: source, now: () => observedAt });
    const start = performance.now();
    assert.equal((await service.readSnapshot()).snapshot.counts.ready, 500);
    cold.push(performance.now() - start);
  }
  const cached = createScreenerService({ snapshotStore: source, now: () => observedAt });
  await cached.readSnapshot();
  const warm = [], filters = [];
  const reads = diskReads;
  for (let i = 0; i < 40; i++) {
    let start = performance.now();
    const current = await cached.readSnapshot();
    warm.push(performance.now() - start);
    start = performance.now();
    assert.equal(queryScreenerSnapshot(current.snapshot, { rsi14: { min: 0, max: 100 } },
      { page: i % 25 + 1, sortBy: 'price', sortDirection: 'desc' }).rows.length, 20);
    filters.push(performance.now() - start);
  }
  assert.equal(diskReads, reads);
  const p95 = samples => +samples.sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1].toFixed(2);
  const primaryBytes = (await fs.stat(path.join(storeDirectory, 'published.json'))).size;
  const previousBytes = (await fs.stat(path.join(storeDirectory, 'previous.json'))).size;
  t.diagnostic(JSON.stringify({ fixtureSymbols: 500, primaryBytes, previousBytes,
    readerColdP95Ms: p95(cold), warmP95Ms: p95(warm),
    filterP95Ms: p95(filters), heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
    rssBytes: process.memoryUsage().rss, providerRequests: 0, coldMeaning: 'new reader instance; filesystem cache not flushed' }));
});

test('cooperative timeouts are bounded, retried once and never publish unfinished data', async t => {
  const { store } = await fixture(t);
  let active = 0, peak = 0, calls = 0;
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const started = performance.now();
    const result = await runner(store, [coverage('PTT'), coverage('CPALL')], async (_symbol, _mapping, { signal }) => {
      calls++;
      peak = Math.max(peak, ++active);
      try {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } finally { active--; }
    }, { requestTimeoutMs: 15 }).run({ maxRequests: 4 });
    assert.equal(calls, 4);
    assert.equal(result.requests, 4);
    assert.equal(result.published, false);
    assert.ok(performance.now() - started < 2000);
    assert.ok(peak <= 2);
    assert.equal(active, 0);
    assert.equal((await store.readPublished()).snapshot, null);
  } finally { clearTimeout(keepAlive); }
});

test('published replacements and operator rollback invalidate a cached snapshot immediately', async t => {
  const { store } = await fixture(t);
  const a = await snapshot(1, 25), b = await snapshot(1, 35);
  await store.withLease(() => store.publish(a));
  const service = createScreenerService({ snapshotStore: store, now: () => observedAt });
  assert.equal((await service.readSnapshot()).snapshot.id, a.id);
  await store.withLease(() => store.publish(b));
  assert.equal((await service.readSnapshot()).snapshot.id, b.id);
  await store.withLease(() => store.rollback());
  assert.equal((await service.readSnapshot()).snapshot.id, a.id);
});
