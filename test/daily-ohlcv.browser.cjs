'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { dailySource, observedAt, coverage } = require('./fixtures/daily-ohlcv.cjs');
const { createScreenerService } = require('../server/screener-service');

async function envelopes(registry) {
  const { queryScreenerSnapshot } = await import('../client/screener-core.mjs');
  const source = dailySource('S000');
  const stale = dailySource('S000', { last: '2026-11-05' });
  const payloads = {};
  for (const mode of ['ready', 'missing', 'stale', 'blocked', 'unavailable']) {
    const service = createScreenerService({ now: () => observedAt, listCoverage: () => registry,
      snapshotStore: { readPublished: async () => ({ snapshot: null }) } });
    for (let i = 0; i < 500 && mode !== 'unavailable'; i++) {
      if (i === 499 && mode === 'missing') continue;
      const original = i === 499 && mode === 'stale' ? stale : source;
      const result = i === 499 && mode === 'blocked'
        ? { ...original.result, guardStatus: 'suspect', historyStatus: 'blocked', guardReasons: ['FIXTURE_GUARD_BLOCKED'] }
        : original.result;
      service.rememberDailyHistory(registry[i].symbol, { ...original.meta, symbol: registry[i].provider_symbol }, result);
    }
    payloads[mode] = { ...await service.readSnapshot(), validUntil: new Date(Date.now() + 3600000).toISOString() };
    if (mode === 'unavailable') assert.equal(payloads[mode].snapshot, null);
    else {
      const { snapshot, availability } = payloads[mode];
      const ready = mode === 'ready' ? 500 : 499;
      assert.equal(snapshot.state, mode === 'ready' ? 'COMPLETE' : 'PARTIAL');
      assert.equal(availability.ready, ready);
      for (const [key, absentMode] of [['unavailable', 'missing'], ['staleSession', 'stale'], ['guardBlocked', 'blocked']])
        assert.equal(availability[key], Number(mode === absentMode));
      const page = queryScreenerSnapshot(snapshot, {}, { page: 2 });
      assert.equal(page.counts.matched, ready);
      assert.equal(page.rows.length, 20);
      assert.equal(queryScreenerSnapshot(snapshot, { search: 'S499' }).rows.length, mode === 'ready' ? 1 : 0);
      assert.deepEqual(queryScreenerSnapshot(snapshot, { search: 'S010' }, { sortBy: 'price', sortDirection: 'asc' })
        .rows.map(row => row.symbol), ['S010']);
    }
  }
  payloads.unknown = { ...payloads.unavailable, availability: null };
  return payloads;
}

(async () => {
  process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
  const { server } = require('../server');
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  const payloads = await envelopes(registry);
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const width of [320, 390, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width < 520 });
      let mode = 'ready', reads = 0, coverageReads = 0, providers = 0;
      const state = { getOwners: [], putOwners: [] };
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (/yahoo/i.test(url.hostname)) { providers++; return route.abort(); }
        if (url.origin === base && url.pathname === '/api/screener') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          reads++;
          return route.fulfill({ json: payloads[mode] });
        }
        if (url.origin === base && url.pathname === '/api/screener/coverage') {
          coverageReads++;
          return route.abort();
        }
        if (![base, 'https://isolation-test.supabase.co'].includes(url.origin)) return route.abort();
        return mockRequest(route, base, state);
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await seedPage(page, 'token-a');
      for (const nextMode of ['ready', 'missing', 'stale', 'blocked', 'unavailable', 'unknown']) {
        mode = nextMode;
        await page.goto(base + '/?fixture=' + mode + '#screener');
        await page.waitForURL(base + '/#overview');
        await page.locator('#market-overview').waitFor();
        await page.waitForLoadState('networkidle');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(reads, 0, 'the retired route does not load technical snapshots in any state');
        assert.equal(coverageReads, 0, 'the retired route does not load its registry catalog');
      }
      assert.equal(providers, 0);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, states: 6, fixtureSymbols: 500, providerRequests: providers, result: 'PASS' }));
      await context.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
