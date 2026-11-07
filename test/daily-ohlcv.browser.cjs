'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { dailySource, observedAt, coverage } = require('./fixtures/daily-ohlcv.cjs');
const { createScreenerService } = require('../server/screener-service');

async function envelopes() {
  const source = dailySource('S000');
  const stale = dailySource('S000', { last: '2026-11-05' });
  const registry = Array.from({ length: 500 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
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
    if (mode !== 'ready') assert.equal(payloads[mode].snapshot, null, 'strict complete must withhold partial snapshots');
  }
  payloads.unknown = { ...payloads.unavailable, availability: null };
  return payloads;
}

(async () => {
  process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
  const { server } = require('../server');
  const payloads = await envelopes();
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const width of [320, 390, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width < 520 });
      let mode = 'ready', reads = 0, providers = 0;
      const state = { getOwners: [], putOwners: [] };
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (/yahoo/i.test(url.hostname)) { providers++; return route.abort(); }
        if (url.origin === base && url.pathname === '/api/screener') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          reads++;
          return route.fulfill({ json: payloads[mode] });
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
        await page.locator('#screener-reload').waitFor({ state: mode === 'ready' ? 'hidden' : 'visible' });
        await page.waitForLoadState('networkidle');
        const cards = page.locator('#screener-availability');
        if (mode === 'unknown') assert.equal(await cards.isVisible(), false);
        else {
          await cards.waitFor();
          for (const [name, key] of [['ready', 'ready'], ['unavailable', 'unavailable'], ['stale', 'staleSession'], ['blocked', 'guardBlocked']])
            assert.equal(await page.locator('#screener-' + name + '-count').textContent(), String(payloads[mode].availability[key]));
          assert.equal(await cards.locator('dt').count(), 4);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        if (mode !== 'ready') {
          assert.equal(await page.locator('#screener-results').isVisible(), false);
          assert.equal(await page.locator('#screener-filters').isVisible(), false);
        } else {
          await page.locator('#screener-results').waitFor();
          const initialReads = reads;
          await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
          const search = page.getByRole('searchbox', { name: 'ชื่อหรือสัญลักษณ์หุ้น' });
          await search.fill('S010');
          await search.press('Enter');
          assert.equal(await page.locator('#screener-results tbody tr').count(), 1);
          await page.getByLabel('เรียงผลลัพธ์').selectOption('price:asc');
          await search.press('Enter');
          assert.equal(reads, initialReads);
        }
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
