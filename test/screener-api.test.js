'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { coverage, dailyBars, guardedDaily, observedAt, providerChart, session } = require('./fixtures/screener.cjs');
const { createScreenerService } = require('../server/screener-service');

test('snapshot coalesces registry reads and separates coverage, freshness and per-filter warm-up', async () => {
  let clock = observedAt;
  let registryReads = 0;
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  registry[499].active = false;
  const service = createScreenerService({ now: () => clock, listCoverage: async () => { registryReads++; return registry; } });
  const add = (symbol, bars, alter = () => {}) => {
    const { meta, result } = guardedDaily(symbol, bars);
    alter(meta, result);
    service.rememberDailyHistory(symbol, meta, result);
  };
  const history = dailyBars();
  for (let i = 0; i < 495; i++) add(registry[i].symbol, history);
  add('S495', dailyBars('2026-11-05'));
  add('S496', dailyBars(session, 3));
  add('S497', history, meta => { meta.dataGranularity = '60m'; });
  add('S498', history, (_meta, result) => { result.rejectedBars = 1; });
  const results = await Promise.all(Array.from({ length: 12 }, () => service.readSnapshot()));
  assert.equal(registryReads, 1);
  const { snapshot, latestCompletedSessionDate, marketFreshness, validUntil } = results[0];
  assert.ok(results.every(result => result.snapshot === snapshot));
  assert.equal(latestCompletedSessionDate, session);
  assert.equal(marketFreshness, 'STALE', 'an incomplete universe with stale rows is not current');
  assert.equal(validUntil, '2026-11-09T10:15:00.000Z');
  assert.deepEqual(snapshot.counts, { registered: 500, eligible: 499, ready: 496, unavailable: 1,
    staleSession: 1, guardBlocked: 1, coverageIneligible: 1 });
  assert.equal(snapshot.rows[496].available.ema20, false);
  assert.equal(snapshot.rows[496].technical.rsi14, null);
  assert.equal(snapshot.rows[497].price.close, null);
  const { queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const query = queryScreenerSnapshot(snapshot, { rsi14: { min: 0, max: 100 } });
  assert.equal(query.counts.unevaluable, 1);
  assert.equal(query.counts.matched, 495);
  assert.equal(registryReads, 1);
  clock = Date.parse(validUntil);
  const afterClose = await service.readSnapshot();
  assert.equal(afterClose.latestCompletedSessionDate, '2026-11-09');
  assert.equal(afterClose.marketFreshness, 'STALE');
  assert.equal(afterClose.snapshot.counts.ready, 0);
  assert.equal(registryReads, 2);
});

test('unreviewed calendars and missing coverage never publish READY', async () => {
  let clock = Date.parse('2030-11-06T11:30:00Z');
  let reads = 0;
  const service = createScreenerService({ now: () => clock, listCoverage: () => { reads++; return null; } });
  const unknown = await service.readSnapshot();
  assert.equal(unknown.marketFreshness, 'UNAVAILABLE');
  assert.equal(unknown.latestCompletedSessionDate, null);
  assert.equal(unknown.snapshot, null);
  assert.equal(reads, 0);
  clock = observedAt;
  const missing = await service.readSnapshot();
  assert.equal(missing.latestCompletedSessionDate, session);
  assert.equal(missing.marketFreshness, 'UNAVAILABLE');
  assert.equal(missing.snapshot, null);
  assert.equal(reads, 1);
});

test('authenticated Screener API reuses a real guarded Chart response path with zero additional Yahoo GETs (fixtures)', async () => {
  const nativeFetch = globalThis.fetch;
  const originalNow = Date.now;
  const upstream = [];
  let failRegistry = false;
  let clock = observedAt;
  Date.now = () => clock;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_ANON_KEY = 'fixture-public';
  process.env.SUPABASE_SECRET_KEY = 'fixture-private';
  delete process.env.SET_API_KEY;
  const bars = dailyBars();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    upstream.push(url);
    if (url.hostname === 'fixture.invalid' && url.pathname === '/auth/v1/user')
      return Response.json({ id: 'fixture-user' });
    if (url.hostname === 'fixture.invalid' && url.pathname === '/rest/v1/security_coverage') {
      assert.equal(init.headers.Prefer, 'count=exact');
      if (failRegistry) return Response.json({ detail: 'fixture-private-diagnostic' }, { status: 503 });
      return Response.json([coverage('PTT'), coverage('CPALL')], { headers: { 'content-range': '0-1/2' } });
    }
    if (url.hostname === 'query1.finance.yahoo.com') {
      const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
      const interval = url.searchParams.get('interval');
      return Response.json(providerChart(symbol, interval, interval === '1d' ? bars : bars.slice(-1)));
    }
    throw Error('Unexpected upstream fixture URL');
  };
  const { server } = require('../server');
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const get = (path, method = 'GET') => nativeFetch(base + path, { method, headers: { authorization: 'Bearer test-session' } });
    const quoteReads = () => upstream.filter(url => url.hostname === 'query1.finance.yahoo.com').length;
    assert.equal((await nativeFetch(base + '/api/screener')).status, 401);
    assert.equal((await get('/api/screener', 'POST')).status, 405);
    assert.equal((await get('/api/screener')).headers.get('cache-control'), 'no-store');
    assert.equal(quoteReads(), 0);
    assert.equal((await get('/api/market?symbols=PTT&symbol=PTT&range=1Y')).status, 200);
    const before = quoteReads();
    assert.ok(before > 0);
    clock += 31000;
    const response = await get('/api/screener');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.marketFreshness, 'UNAVAILABLE', 'one eligible symbol has no evidence');
    assert.equal(data.snapshot.state, 'PARTIAL');
    const ptt = data.snapshot.rows.find(row => row.symbol === 'PTT');
    assert.equal(ptt.state, 'READY');
    assert.equal(ptt.confirmedBars, 65);
    assert.equal(ptt.price.close, bars.at(-1).close);
    const { computeTechnicalSeries, TECHNICAL_DEFAULTS } = await import('../client/domain.mjs');
    const technical = computeTechnicalSeries(bars, TECHNICAL_DEFAULTS);
    assert.deepEqual(ptt.technical, {
      ema20: technical.ema20.at(-1), ema50: technical.ema50.at(-1), rsi14: technical.rsi.at(-1),
      macd: technical.macd.at(-1), macdSignal: technical.signal.at(-1)
    });
    assert.equal(data.snapshot.rows.find(row => row.symbol === 'CPALL').state, 'UNAVAILABLE');
    assert.equal((await get('/api/screener?refresh=1')).status, 200);
    assert.equal(quoteReads(), before);
    assert.equal(upstream.filter(url => url.pathname === '/rest/v1/security_coverage').length, 2);
    failRegistry = true;
    clock += 31000;
    const error = await get('/api/screener');
    assert.equal(error.status, 503);
    assert.doesNotMatch(await error.text(), /fixture-private-diagnostic/);
    assert.equal(quoteReads(), before);
    assert.equal((await get('/healthz')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Date.now = originalNow;
    globalThis.fetch = nativeFetch;
  }
});
