'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { coverage, dailyBars, guardedDaily, observedAt, providerChart, session } = require('./fixtures/screener.cjs');
const { createScreenerService } = require('../server/screener-service');
const { buildIndexCatalog } = require('../server/screener-index');

test('bundled Owner Excel membership opens every group and retains unmatched coverage symbols', () => {
  const expected = { SET50: 40, SET100: 80, SETHD: 15, SETESG: 76, mai: 56 };
  const membership = require('../server/index-membership.json');
  const symbols = new Set([...Object.keys(expected).flatMap(group => membership[group].symbols),
    'BBIK', 'DITTO', 'JTS', 'THCOM', 'NOPRICE']);
  const registry = [...symbols, ...Array.from({ length: 500 - symbols.size }, (_, i) => 'XFIX' + i)].map(symbol => coverage(symbol));
  const catalog = buildIndexCatalog(registry, undefined, '2026-11-07');
  assert.equal(catalog.stocks.length, 500);
  assert.equal(new Set(catalog.stocks.map(row => row.symbol)).size, 500);
  assert.equal(catalog.stocks.filter(row => row.membershipStatus === 'UNKNOWN').length, 359);
  for (const [key, size] of Object.entries(expected)) {
    const group = catalog.groups[key];
    assert.equal(group.available, true);
    assert.equal(group.sourceType, 'OWNER_EXCEL');
    assert.equal(group.symbols.length, size);
    assert.equal(new Set(group.symbols).size, size);
    assert.ok(!group.symbols.includes('TTW') && !group.symbols.includes('GST'));
  }
  assert.ok(catalog.groups.SET50.symbols.every(symbol => catalog.groups.SET100.symbols.includes(symbol)));
  assert.ok(catalog.groups.SET100.symbols.includes('JMART'));
  for (const symbol of ['BBIK', 'DITTO', 'JTS', 'THCOM', 'NOPRICE'])
    assert.equal(catalog.stocks.find(row => row.symbol === symbol).membershipStatus, 'UNKNOWN');
  const expired = buildIndexCatalog(registry, undefined, '2027-01-01');
  assert.equal(expired.stocks.length, 500);
  assert.ok(Object.values(expired.groups).every(group => !group.available));
});

test('index catalog joins dated membership by symbol without requiring prices or coverage eligibility', () => {
  const registry = [
    { ...coverage('PTT'), company_name_en: 'Verified Company', name_source: 'https://example.test/ptt', name_checked_at: '2026-01-01' },
    { ...coverage('CPALL'), active: false, company_name_en: 'Unverified Company' },
    coverage('MAI1'), coverage('UNKNOWN1')
  ];
  const group = (...symbols) => ({ effectiveFrom: '2026-07-01', effectiveThrough: '2026-12-31', symbols });
  const membership = {
    SET50: group(' ptt '), SET100: group('PTT', 'CPALL', 'OUTSIDE'),
    SETHD: group('PTT'), SETESG: group('CPALL', 'MAI1'), mai: group('MAI1')
  };
  const result = buildIndexCatalog(registry, membership, '2026-12-31');
  assert.deepEqual(result.stocks, [
    { symbol: 'PTT', name: 'Verified Company', membershipStatus: 'VERIFIED' },
    { symbol: 'CPALL', name: '', membershipStatus: 'VERIFIED' },
    { symbol: 'MAI1', name: '', membershipStatus: 'VERIFIED' },
    { symbol: 'UNKNOWN1', name: '', membershipStatus: 'UNKNOWN' }
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.groups).map(([key, entry]) => [key, entry.symbols])),
    { SET50: ['PTT'], SET100: ['PTT', 'CPALL'], SETHD: ['PTT'], SETESG: ['CPALL', 'MAI1'], mai: ['MAI1'] });
  assert.equal(result.groups.SET100.outsideCoverage, 1);
  assert.equal(result.groups.SET100.effectiveThrough, '2026-12-31');
  assert.match(result.groups.mai.source, /^https:\/\/www\.set\.or\.th\//);
  assert.ok(Object.values(buildIndexCatalog(registry, membership, '2027-01-01').groups).every(group => !group.available));
  assert.ok(Object.values(buildIndexCatalog(registry, membership, '2026-06-30').groups).every(group => !group.available));
});

test('index catalog fails closed for conflicting groups, normalized duplicates and invalid dates', () => {
  const registry = [coverage('PTT'), coverage('CPALL')];
  const group = (...symbols) => ({ effectiveFrom: '2026-07-01', effectiveThrough: '2026-12-31', symbols });
  const result = buildIndexCatalog(registry, {
    SET50: group('PTT'), SET100: group('CPALL'), SETHD: group('PTT', 'ptt'),
    SETESG: { ...group('CPALL'), effectiveThrough: '2026-11-31' }
  }, '2026-11-07');
  assert.ok(Object.values(result.groups).every(group => !group.available && !group.symbols));
  const marketConflict = buildIndexCatalog(registry, {
    SET100: group('PTT'), SETESG: group('CPALL'), mai: group('PTT')
  }, '2026-11-07');
  assert.equal(marketConflict.groups.SET100.available, false);
  assert.equal(marketConflict.groups.mai.available, false);
  assert.deepEqual(marketConflict.groups.SETESG.symbols, ['CPALL']);
  assert.equal(marketConflict.stocks.find(row => row.symbol === 'PTT').membershipStatus, 'UNKNOWN');
  assert.throws(() => buildIndexCatalog([...registry, coverage(' ptt ')]), /Invalid coverage registry/);
  assert.throws(() => buildIndexCatalog([]), /unavailable/);
});

test('a confirmed listing transfer overrides a stale mai flag without affecting coverage or SETESG', () => {
  const { listingTransfers } = require('../server/index-membership.json');
  const group = (...symbols) => ({ effectiveFrom: '2024-01-01', effectiveThrough: '2026-12-31', symbols });
  const registry = [coverage('DITTO'), coverage('MAI1')];
  const membership = { listingTransfers, mai: group('DITTO', 'MAI1'), SETESG: group('DITTO', 'TTW') };
  assert.deepEqual(buildIndexCatalog(registry, membership, '2024-01-16').groups.mai.symbols, ['DITTO', 'MAI1']);
  const current = buildIndexCatalog(registry, membership, '2026-11-07');
  assert.deepEqual(current.stocks.map(row => row.symbol), ['DITTO', 'MAI1']);
  assert.deepEqual(current.groups.mai.symbols, ['MAI1']);
  assert.deepEqual(current.groups.SETESG.symbols, ['DITTO']);
  assert.equal(current.groups.SETESG.outsideCoverage, 1);
  assert.equal(buildIndexCatalog(registry, { listingTransfers, mai: group('DITTO') }, '2026-11-07').groups.mai.available, false);
});

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
  assert.equal(marketFreshness, 'CURRENT_SESSION', 'only current READY rows qualify for safe partial screening');
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
  assert.equal(afterClose.snapshot, null, 'no READY rows from the latest session means no Safe Partial result');
  assert.equal(afterClose.availability.ready, 0);
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

test('retired Screener endpoints authenticate and skip data work while Chart, Search and Coverage still work', async () => {
  const nativeFetch = globalThis.fetch;
  const originalNow = Date.now;
  const upstream = [];
  Date.now = () => observedAt;
  process.env.SUPABASE_URL = 'https://fixture.invalid';
  process.env.SUPABASE_ANON_KEY = 'fixture-public';
  process.env.SUPABASE_SECRET_KEY = 'fixture-private';
  delete process.env.SET_API_KEY;
  const bars = dailyBars();
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    upstream.push(url);
    if (url.hostname === 'fixture.invalid' && url.pathname === '/auth/v1/user')
      return init.headers.authorization === 'Bearer bad-session' || init.headers.Authorization === 'Bearer bad-session'
        ? Response.json({}, { status: 401 }) : Response.json({ id: 'fixture-user' });
    if (url.hostname === 'fixture.invalid' && url.pathname === '/rest/v1/security_coverage') {
      assert.equal(init.headers.Prefer, 'count=exact');
      return Response.json([coverage('PTT'), coverage('CPALL')], { headers: { 'content-range': '0-1/2' } });
    }
    if (url.hostname === 'query1.finance.yahoo.com') {
      if (url.pathname === '/v1/finance/search')
        return Response.json({ quotes: [{ symbol: 'OUTSIDE.BK', quoteType: 'EQUITY', longname: 'Outside Coverage Fixture' }] });
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
    const get = (path, method = 'GET', token = 'test-session') =>
      nativeFetch(base + path, { method, headers: { authorization: 'Bearer ' + token } });
    const dataReads = () => upstream.filter(url => url.pathname !== '/auth/v1/user').length;
    const endpoints = ['/api/screener', '/api/screener/coverage'];
    async function assertDisabled() {
      const before = dataReads();
      for (const path of endpoints) {
        const response = await get(path + '?refresh=1');
        assert.equal(response.status, 410);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal((await response.json()).code, 'SCREENER_DISABLED');
      }
      assert.equal(dataReads(), before, 'disabled endpoints must not query registry, snapshots or a provider');
    }
    for (const path of endpoints) {
      assert.equal((await nativeFetch(base + path)).status, 401);
      assert.equal((await get(path, 'GET', 'bad-session')).status, 401);
      assert.equal((await get(path, 'POST')).status, 405);
    }
    await assertDisabled();
    assert.equal(dataReads(), 0);
    const marketResponse = await get('/api/market?symbols=PTT&symbol=PTT&range=1Y');
    assert.equal(marketResponse.status, 200);
    const market = await marketResponse.json();
    assert.equal(market.stocks.find(row => row.symbol === 'PTT').guardStatus, 'accepted');
    assert.equal(market.history.length, 65);
    assert.equal(market.history.at(-1).close, bars.at(-1).close);
    await assertDisabled();
    assert.equal(upstream.filter(url => url.pathname === '/rest/v1/security_coverage').length, 0);
    const searchResponse = await get('/api/search?q=OUTSIDE');
    assert.equal(searchResponse.status, 200);
    assert.deepEqual((await searchResponse.json()).items.map(row => row.symbol), ['OUTSIDE']);
    assert.equal(upstream.filter(url => url.pathname === '/v1/finance/search').length, 1);
    const coverageResponse = await get('/api/coverage');
    assert.equal(coverageResponse.status, 200);
    assert.equal((await coverageResponse.json()).configured, true);
    assert.equal(upstream.filter(url => url.pathname === '/rest/v1/security_coverage').length, 2);
    await assertDisabled();
    assert.equal((await get('/healthz')).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Date.now = originalNow;
    globalThis.fetch = nativeFetch;
  }
});
