'use strict';

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { coverage, dailyBars, guardedDaily, observedAt, providerChart, session } = require('./fixtures/screener.cjs');
const { createMarketService } = require('../server/market-service');
const { createScreenerAcquisition } = require('../server/screener-acquisition');
const { createScreenerService } = require('../server/screener-service');
const { createScreenerSnapshotStore } = require('../server/screener-snapshot-store');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setscope-ws4-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: createScreenerSnapshotStore(directory) };
}

function synthetic(symbol, bars = dailyBars(), time = observedAt) {
  const item = guardedDaily(symbol, bars);
  item.result.provenance.receivedAt = new Date(time).toISOString();
  return item;
}

function makeRun(store, registry, readDaily, options) {
  return createScreenerAcquisition({
    listCoverage: async () => registry, readDaily, store,
    now: () => observedAt, sleep: async () => {}, ...options
  });
}

test('500 symbols through the actual daily adapter, Data Guard and durable snapshot, with a bounded mock budget', async t => {
  const { directory, store } = await fixture(t);
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  const bars = dailyBars();
  const providerReads = [];
  let active = 0, peak = 0;
  const market = createMarketService({ now: () => observedAt, fetchImpl: async (url, init) => {
    assert.equal(url.hostname, 'query1.finance.yahoo.com');
    assert.equal(url.searchParams.get('interval'), '1d');
    assert.equal(url.searchParams.get('range'), '1y');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
    providerReads.push(symbol);
    peak = Math.max(peak, ++active);
    await delay(1);
    active--;
    return Response.json(providerChart(symbol, '1d', bars));
  } });
  const started = performance.now();
  let gaps = 0;
  const runner = makeRun(store, registry, market.readScreenerDaily, { sleep: async ms => {
    assert.equal(ms, 1000);
    gaps++;
  } });
  const run = await runner.run({ maxRequests: 500 });
  const buildMs = performance.now() - started;
  assert.equal(run.status, 'PUBLISHED');
  assert.equal(run.requests, 500);
  assert.equal(gaps, 24);
  assert.equal(peak, 4);
  assert.equal(new Set(providerReads).size, 500);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', [
    "const {createScreenerSnapshotStore}=require('./server/screener-snapshot-store');",
    "createScreenerSnapshotStore(process.argv[1]).readPublished().then(({snapshot})=>",
    "process.stdout.write(JSON.stringify([snapshot.id,snapshot.counts.ready,snapshot.rows[0].sourceAsOf])));"
  ].join(''), directory], { cwd: path.resolve(__dirname, '..') });
  assert.deepEqual(JSON.parse(stdout), [run.snapshotId, 500, new Date(observedAt).toISOString()]);
  const snapshot = (await store.readPublished()).snapshot;
  const { computeTechnicalSeries, TECHNICAL_DEFAULTS } = await import('../client/domain.mjs');
  const { queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const technical = computeTechnicalSeries(bars, TECHNICAL_DEFAULTS);
  assert.deepEqual(snapshot.rows[0].technical, {
    ema20: technical.ema20.at(-1), ema50: technical.ema50.at(-1), rsi14: technical.rsi.at(-1),
    macd: technical.macd.at(-1), macdSignal: technical.signal.at(-1)
  });
  const filters = { rsi14: { min: 0, max: 100 }, ema20: 'above' };
  const samples = Array.from({ length: 40 }, (_, i) => {
    const before = performance.now();
    const result = queryScreenerSnapshot(snapshot, filters, { page: i % 25 + 1, sortBy: 'price' });
    assert.equal(result.counts.matched, 500);
    assert.equal(result.rows.length, 20);
    return performance.now() - before;
  }).sort((a, b) => a - b);
  assert.equal(providerReads.length, 500);
  const { size } = await fs.stat(path.join(directory, 'published.json'));
  t.diagnostic(JSON.stringify({ mockBuildMs: Math.round(buildMs), filterP95Ms: +samples[37].toFixed(2), bytes: size, peak }));
});

test('staging, process lease, checksummed recovery, retention and operator rollback', async t => {
  const { directory, store } = await fixture(t);
  const registry = [coverage('PTT'), { ...coverage('AOT'), active: false }];
  const run = base => makeRun(store, registry, async symbol => synthetic(symbol, dailyBars(session, 65, base)));
  const first = await run(25).run({ maxRequests: 1 });
  assert.equal(first.status, 'PUBLISHED');
  assert.equal((await store.readPublished()).snapshot.state, 'COMPLETE');
  assert.equal((await store.readPublished()).snapshot.counts.coverageIneligible, 1);
  const second = await run(35).run({ maxRequests: 1 });
  assert.notEqual(first.snapshotId, second.snapshotId);
  await store.withLease(async () => {
    await assert.rejects(run(45).run({ maxRequests: 1 }), { code: 'EEXIST' });
  });
  const child = spawn(process.execPath, ['-e', [
    "const fs=require('node:fs');",
    "const {createScreenerSnapshotStore}=require('./server/screener-snapshot-store');",
    "createScreenerSnapshotStore(process.argv[1]).withLease(()=>{",
    "fs.writeFileSync(require('node:path').join(process.argv[1],'published.stage'),'{');",
    "process.stdout.write('locked');setInterval(()=>{},1000);return new Promise(()=>{});});"
  ].join(''), directory], { cwd: path.resolve(__dirname, '..') });
  t.after(() => { if (child.exitCode === null && !child.signalCode) child.kill(); });
  const exited = once(child, 'exit');
  await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw Error('fixture writer exited early'); })]);
  child.kill();
  await exited;
  assert.equal((await createScreenerSnapshotStore(directory).readPublished()).snapshot.id, second.snapshotId);

  const pathToPrimary = path.join(directory, 'published.json');
  const envelope = JSON.parse(await fs.readFile(pathToPrimary));
  envelope.payload.rows.find(row => row.symbol === 'PTT').candleTime = '2026-11-05T03:00:00.000Z';
  // Even data with a recomputed digest cannot bypass the session/schema checks.
  envelope.digest = createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex');
  await fs.writeFile(pathToPrimary, JSON.stringify(envelope));
  const recovered = await createScreenerSnapshotStore(directory).readPublished();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.snapshot.id, first.snapshotId);
  const next = await run(45).run({ maxRequests: 1 });
  assert.equal((await store.readPublished()).snapshot.id, next.snapshotId);
  await store.withLease(() => store.rollback());
  assert.equal((await store.readPublished()).snapshot.id, first.snapshotId);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['previous.json', 'published.json']);
  await fs.writeFile(path.join(directory, 'previous.json'), 'bad');
  await fs.writeFile(pathToPrimary, '{');
  assert.deepEqual(await store.readPublished(), { snapshot: null, recovered: false });
});

test('partial, invalid OHLCV, stale or wrong interval runs leave a prior publish unchanged', async t => {
  const { store } = await fixture(t);
  const registry = [coverage('PTT'), coverage('CPALL')];
  const withoutVolume = createMarketService({ now: () => observedAt, fetchImpl: async () => {
    const bars = dailyBars();
    bars.at(-1).volume = null;
    return Response.json(providerChart('PTT.BK', '1d', bars));
  } });
  const missingVolume = await makeRun(store, [coverage('PTT')], withoutVolume.readScreenerDaily).run({ maxRequests: 1 });
  assert.equal(missingVolume.status, 'INCOMPLETE');
  assert.equal((await store.readPublished()).snapshot, null);
  const ok = await makeRun(store, registry, async symbol => synthetic(symbol)).run({ maxRequests: 2 });
  assert.equal(ok.published, true);
  for (const mode of ['empty', 'invalid', 'stale', 'wrong-interval', 'incomplete']) {
    const outcome = await makeRun(store, registry, async symbol => {
      const item = synthetic(symbol, mode === 'stale' && symbol === 'PTT' ? dailyBars('2026-11-05') : dailyBars());
      if (symbol !== 'PTT') return item;
      if (mode === 'empty') item.result.history = [];
      if (mode === 'invalid') item.result.history.at(-1).volume = -1;
      if (mode === 'wrong-interval') item.meta.dataGranularity = '60m';
      if (mode === 'incomplete') item.result.history.at(-1).complete = false;
      return item;
    }).run({ maxRequests: 2 });
    assert.equal(outcome.status, 'INCOMPLETE', mode);
    assert.equal(outcome.ready, 1, mode);
    assert.equal((await store.readPublished()).snapshot.id, ok.snapshotId, mode);
  }
});

test('retries and timeouts consume budget, stop on denial or redirect, and persist 429 cooldown', async t => {
  const { store, directory } = await fixture(t);
  const registry = Array.from({ length: 25 }, (_, i) => coverage('S' + i));
  const attempts = new Map();
  const retry = makeRun(store, [coverage('PTT')], async (symbol, _mapping, { signal }) => {
    const count = attempts.get(symbol) || 0;
    attempts.set(symbol, count + 1);
    if (count === 0) {
      const keepAlive = setTimeout(() => {}, 80);
      try { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
      finally { clearTimeout(keepAlive); }
    }
    return synthetic(symbol);
  }, { requestTimeoutMs: 15 });
  assert.equal((await retry.run({ maxRequests: 2 })).status, 'PUBLISHED');
  assert.equal(attempts.get('PTT'), 2);
  const exhausted = await makeRun(store, registry, async () => {
    throw Object.assign(Error('fixture outage'), { status: 503 });
  }).run({ maxRequests: 3 });
  assert.equal(exhausted.status, 'BUDGET_EXHAUSTED');
  assert.equal(exhausted.requests, 3);
  const redirected = createMarketService({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://fixture.invalid' } }) });
  const redirect = await makeRun(store, registry, redirected.readScreenerDaily).run({ maxRequests: 25 });
  assert.equal(redirect.status, 'PROVIDER_STOPPED');
  assert.ok(redirect.requests <= 4);
  for (const status of [401, 403, 429]) {
    const limited = await makeRun(store, registry, async () => {
      throw Object.assign(Error('fixture response'), { status, retryAfter: '1800' });
    }).run({ maxRequests: 25 });
    assert.equal(limited.status, status === 429 ? 'RATE_LIMITED' : 'PROVIDER_STOPPED');
    assert.ok(limited.requests <= 4);
  }
  const afterRestart = await makeRun(createScreenerSnapshotStore(directory), registry, () => {
    assert.fail('cooldown cannot use provider');
  }).run({ maxRequests: 25 });
  assert.equal(afterRestart.status, 'COOLDOWN');
  assert.equal(afterRestart.requests, 0);
  assert.equal(afterRestart.cooldownUntil, new Date(observedAt + 1800000).toISOString());
});

test('calendar treats holiday and weekend as closures and suppresses old or mixed-session snapshots', async t => {
  const { store } = await fixture(t);
  let clock = Date.parse('2026-10-16T12:00:00Z');
  let reads = 0;
  const registry = [coverage('PTT')];
  const runner = makeRun(store, registry, async symbol => {
    reads++;
    return synthetic(symbol, dailyBars('2026-10-15'), clock);
  }, { now: () => clock });
  const holiday = await runner.run({ maxRequests: 1 });
  assert.equal(holiday.status, 'PUBLISHED');
  assert.equal(holiday.sessionDate, '2026-10-15');
  const service = createScreenerService({ snapshotStore: store, now: () => clock });
  assert.equal((await service.readSnapshot()).marketFreshness, 'CURRENT_SESSION');
  clock = Date.parse('2026-10-18T12:00:00Z');
  assert.equal((await service.readSnapshot()).latestCompletedSessionDate, '2026-10-15');
  clock = Date.parse('2026-10-19T10:15:00Z');
  const next = await service.readSnapshot();
  assert.equal(next.latestCompletedSessionDate, '2026-10-19');
  assert.equal(next.marketFreshness, 'STALE');
  assert.equal(next.snapshot, null);
  const crossed = await makeRun(store, registry, async symbol => {
    clock = Date.parse('2026-10-20T10:15:00Z');
    return synthetic(symbol, dailyBars('2026-10-19'), clock);
  }, { now: () => clock }).run({ maxRequests: 1 });
  assert.equal(crossed.status, 'SESSION_CHANGED');
  assert.equal((await store.readPublished()).snapshot.id, holiday.snapshotId);
  clock = Date.parse('2030-11-06T12:00:00Z');
  assert.equal((await runner.run({ maxRequests: 1 })).status, 'CALENDAR_UNAVAILABLE');
  assert.equal((await service.readSnapshot()).marketFreshness, 'UNAVAILABLE');
  assert.equal(reads, 1);
});

test('durable read API is authenticated, account-neutral, and starts no registry or provider calls', async t => {
  const { directory, store } = await fixture(t);
  const main = require('../scripts/run-screener-snapshot').main;
  await assert.rejects(main(['--acquire', '--max-requests=1'], {}), /authorization/);
  await makeRun(store, [coverage('PTT')], async symbol => synthetic(symbol)).run({ maxRequests: 1 });
  const originalNow = Date.now;
  const nativeFetch = globalThis.fetch;
  const apiCalls = [];
  Date.now = () => observedAt;
  Object.assign(process.env, {
    SETSCOPE_SCREENER_SNAPSHOT_DIR: directory,
    SUPABASE_URL: 'https://fixture.invalid',
    SUPABASE_ANON_KEY: 'fixture-public',
    SUPABASE_SECRET_KEY: 'fixture-private'
  });
  globalThis.fetch = async (url, init) => {
    apiCalls.push(String(url));
    assert.equal(String(url), 'https://fixture.invalid/auth/v1/user');
    return Response.json({ id: String(init.headers.Authorization).includes('user-b') ? 'user-b' : 'user-a' });
  };
  const { server } = require('../server');
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/screener';
    assert.equal((await nativeFetch(base)).status, 401);
    const responses = await Promise.all(['user-a', 'user-b'].map(id =>
      nativeFetch(base + '?owner=' + id + '&refresh=1', { headers: { authorization: 'Bearer fixture-' + id } })));
    assert.deepEqual(responses.map(res => res.status), [200, 200]);
    assert.deepEqual(responses.map(res => res.headers.get('cache-control')), ['no-store', 'no-store']);
    const payloads = await Promise.all(responses.map(res => res.text()));
    assert.equal(payloads[0], payloads[1]);
    assert.equal(JSON.parse(payloads[0]).marketFreshness, 'CURRENT_SESSION');
    assert.doesNotMatch(payloads[0], /user-[ab]|fixture-private|watchlist/);
    assert.equal(apiCalls.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    Date.now = originalNow;
    globalThis.fetch = nativeFetch;
  }
});
