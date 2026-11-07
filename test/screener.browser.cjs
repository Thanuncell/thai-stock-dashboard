'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { createScreenerService } = require('../server/screener-service');
const { buildIndexCatalog } = require('../server/screener-index');
const { coverage, dailyBars, guardedDaily, observedAt } = require('./fixtures/screener.cjs');

async function fixture() {
  const registry = Array.from({ length: 498 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  registry.push(coverage('PTT'), coverage('CPALL'));
  const service = createScreenerService({ now: () => observedAt, listCoverage: () => registry });
  const bars = dailyBars();
  for (const row of registry) {
    if (!row.active) continue;
    const source = row.symbol === 'S495' ? dailyBars(undefined, 2) : bars;
    const { meta, result } = guardedDaily(row.symbol, source);
    service.rememberDailyHistory(row.symbol, meta, result);
  }
  return { ...await service.readSnapshot(), validUntil: new Date(Date.now() + 3600000).toISOString() };
}

(async () => {
  process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
  const { server } = require('../server');
  const payload = await fixture();
  const group = (...symbols) => ({ symbols, effectiveFrom: '2026-01-01', effectiveThrough: '2099-12-31' });
  const indexCatalog = buildIndexCatalog([
    ...payload.snapshot.rows.map(({ symbol }) => coverage(symbol)),
    { ...coverage('NOPRICE'), company_name_en: 'No Price Example',
      name_source: 'https://example.test/noprice', name_checked_at: '2026-01-01' }
  ].filter(row => row.symbol !== 'S497'), {
    sourceType: 'OWNER_EXCEL',
    SET50: group('PTT'), SET100: group('PTT', 'S002'), SETHD: group('S003', 'OUTSIDE'),
    SETESG: group('PTT', 'S001'), mai: group('S001')
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const width of [320, 390, 1366]) {
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width < 800 });
      const state = { getOwners: [], putOwners: [] };
      const calls = [];
      const modules = [];
      let holdChart;
      let mode = 'ready';
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === base && url.pathname.startsWith('/api/')) calls.push(url.pathname);
        if (url.origin === base && url.pathname.includes('/screener-')) modules.push(url.pathname);
        if (url.origin === base && url.pathname === '/api/market') {
          const symbol = url.searchParams.get('symbol');
          if (holdChart && symbol === 'CPALL') await holdChart;
          const price = symbol === 'CPALL' ? 70 : 35;
          const history = Array.from({ length: 45 }, (_, i) => ({
            time: Date.UTC(2026, 10, 6, 3, i * 5), open: price, high: price + 1,
            low: price - 1, close: price, volume: 1000
          }));
          return route.fulfill({ json: { stocks: [{ symbol, last: price, prior: price - 1,
            history, guardStatus: 'accepted', dataState: 'delayed' }], indices: [],
            history, levelsHistory: history, indicatorHistory: history,
            fetchedAt: '2026-11-06T11:30:00.000Z', dataState: 'delayed' } });
        }
        if (url.origin === base && url.pathname === '/api/screener') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'fixture' } });
          if (mode === 'stale') return route.fulfill({ json: { ...payload, marketFreshness: 'STALE', snapshot: {
            ...payload.snapshot, state: 'UNAVAILABLE', counts: { ...payload.snapshot.counts, ready: 0, staleSession: 498 }, rows: []
          } } });
          if (mode === 'partial') return route.fulfill({ json: { ...payload, marketFreshness: 'CURRENT_SESSION', snapshot: {
            ...payload.snapshot, state: 'PARTIAL', counts: { ...payload.snapshot.counts, ready: 499, unavailable: 1 }
          } } });
          if (mode === 'mixed') return route.fulfill({ json: { ...payload, marketFreshness: 'STALE', snapshot: {
            ...payload.snapshot, state: 'PARTIAL', counts: { ...payload.snapshot.counts, ready: 499, staleSession: 1 }
          } } });
          if (mode === 'expired') return route.fulfill({ json: { ...payload, validUntil: new Date(Date.now() - 1000).toISOString() } });
          return route.fulfill({ json: payload });
        }
        if (url.origin === base && url.pathname === '/api/screener/coverage') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          return route.fulfill({ json: indexCatalog });
        }
        if (![base, 'https://isolation-test.supabase.co'].includes(url.origin)) return route.abort();
        return mockRequest(route, base, state);
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      if (width !== 390) await seedPage(page, 'token-a');
      await page.goto(base + (width === 1366 ? '/#overview' : '/#screener'));
      if (width === 390) {
        const login = page.locator('#login-form');
        await login.waitFor();
        assert.ok(!calls.includes('/api/screener'), 'unauthenticated deep link must not load a snapshot');
        assert.ok(!calls.includes('/api/screener/coverage'));
        await login.locator('input[name="email"]').fill('a@example.test');
        await login.locator('input[name="password"]').fill('fixture-password');
        await login.locator('button[type="submit"]').click();
        await page.waitForURL(base + '/#screener');
      }
      if (width === 1366) {
        await page.locator('#market-overview').waitFor();
        await page.waitForLoadState('networkidle');
        assert.deepEqual(modules, [], 'Screener modules must not add startup requests on other routes');
        assert.ok(!calls.includes('/api/screener'));
        await page.getByRole('link', { name: 'คัดกรองหุ้น', exact: true }).click();
      }
      await page.getByRole('heading', { name: 'Stock Screener' }).waitFor();
      const indexList = page.locator('#screener-index-list');
      await indexList.locator('li').first().waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(calls.filter(call => call === '/api/screener').length, 0, 'hidden technical screener must not fetch its snapshot');
      assert.equal(calls.filter(call => call === '/api/screener/coverage').length, 1);
      assert.equal(await page.locator('#screener-technical').isVisible(), false);
      assert.equal(await page.locator('#screener-index-source').count(), 0, 'source prose must be absent');
      assert.equal(await page.getByRole('heading', { name: 'คัดกรองทางเทคนิค' }).count(), 0);
      const tabs = page.getByRole('group', { name: 'กลุ่มหุ้น' });
      assert.deepEqual(await tabs.getByRole('button').allTextContents(), ['ทั้งหมด', 'SET50', 'SET100', 'SETHD', 'SETESG', 'mai']);
      const indexStatus = page.locator('#screener-index-status');
      assert.match(await indexStatus.textContent(), /500.*500/);
      assert.equal(await indexList.locator('li').count(), 20);
      const fetchesBeforeInteractions = calls.length;
      await page.locator('#screener-index-next').click();
      assert.match(await page.locator('#screener-index-page').textContent(), /2 \\/ 25/);
      await page.locator('#screener-index-prev').click();
      for (const [key, symbols] of [
        ['SET50', ['PTT']], ['SET100', ['PTT', 'S002']], ['SETHD', ['S003']],
        ['SETESG', ['PTT', 'S001']], ['mai', ['S001']]
      ]) {
        await tabs.getByRole('button', { name: key, exact: true }).click();
        assert.equal(await tabs.getByRole('button', { name: key, exact: true }).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await indexList.getByRole('link').allTextContents(), symbols);
        assert.equal(await page.locator('#screener-index-source').count(), 0);
      }
      await tabs.getByRole('button', { name: 'ทั้งหมด', exact: true }).click();
      const indexSearch = page.getByRole('searchbox', { name: 'ค้นหารายชื่อหุ้น' });
      await indexSearch.fill('No Price Example');
      assert.deepEqual(await indexList.getByRole('link').allTextContents(), ['NOPRICE']);
      assert.equal(indexCatalog.stocks.find(row => row.symbol === 'NOPRICE').membershipStatus, 'UNKNOWN');
      await indexSearch.fill('CPALL');
      assert.deepEqual(await indexList.getByRole('link').allTextContents(), ['CPALL']);
      assert.equal(calls.length, fetchesBeforeInteractions,
        'switching groups, filtering and pagination must make no extra request');
      const nav = page.getByRole('link', { name: 'คัดกรองหุ้น', exact: true });
      assert.equal(await nav.getAttribute('aria-current'), 'page');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.equal(await page.locator('.side-nav .nav-item').count(), 6);
      assert.ok(await page.locator('#user-avatar').isVisible());

      const chartLink = indexList.getByRole('link', { name: 'เปิดกราฟ CPALL' });
      assert.match(await chartLink.getAttribute('href'), /symbol=CPALL.*range=1D#chart$/);
      const watchlistWrites = state.putOwners.length;
      await chartLink.click();
      await page.waitForURL(/symbol=CPALL.*range=1D#chart$/);
      assert.equal(await page.locator('#stock-search').inputValue(), 'CPALL');
      assert.equal(await page.locator('#chart-section').isVisible(), true);
      assert.equal(await page.locator('#screener-page').isVisible(), false);
      await page.getByRole('img', { name: 'กราฟแท่งเทียน CPALL ช่วง 1D' }).waitFor();
      assert.equal(await page.locator('#chart-price').textContent(), '70.00');
      await page.goBack();
      await indexList.locator('li').first().waitFor();
      assert.equal(await page.locator('#screener-technical').isVisible(), false);
      assert.equal(calls.filter(call => call === '/api/screener').length, 0);
      assert.equal(calls.filter(call => call === '/api/screener/coverage').length, 1);
      assert.equal(state.putOwners.length, watchlistWrites);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('Screener browse-only UI verified at ' + width + 'px');
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
