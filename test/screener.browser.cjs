'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');

(async () => {
  process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
  const { server } = require('../server');
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
      const retiredRequests = [];
      const errors = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base && /^\/(?:api\/screener(?:\/|$)|client\/screener-)/.test(url.pathname)) {
          retiredRequests.push(url.pathname);
          return route.abort();
        }
        if (url.origin === base && url.pathname === '/api/search' && url.searchParams.get('q')?.toUpperCase() === 'OUTSIDE') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          return route.fulfill({ json: { items: [{ symbol: 'OUTSIDE', name: 'Outside Coverage Fixture', exchange: 'SET' }] } });
        }
        if (![base, 'https://isolation-test.supabase.co'].includes(url.origin)) return route.abort();
        return mockRequest(route, base, state);
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      if (width !== 390) await seedPage(page, 'token-a');
      await page.goto(base + '/?watchlist=discard#screener');
      if (width === 390) {
        const login = page.locator('#login-form');
        await login.waitFor();
        await page.waitForURL(base + '/login');
        await login.locator('input[name="email"]').fill('a@example.test');
        await login.locator('input[name="password"]').fill('fixture-password');
        await login.locator('button[type="submit"]').click();
      }
      const overview = page.locator('#market-overview');
      await overview.waitFor();
      await page.waitForURL(base + '/#overview');
      const nav = page.locator('.side-nav');
      assert.deepEqual(await nav.locator('.nav-item').evaluateAll(links => links.map(link => link.dataset.workspaceRoute)),
        ['overview', 'chart', 'news', 'watchlist', 'profile']);
      assert.equal(await page.locator('#screener-page, [data-workspace-route="screener"]').count(), 0);

      for (const [route, selector] of [['watchlist', '#watchlist-page'], ['news', '#news-section'], ['profile', '#profile-page']]) {
        await nav.locator('[data-workspace-route="' + route + '"]').click();
        await page.locator(selector).waitFor();
        await page.waitForURL(url => url.hash === '#' + route);
      }
      const historyLength = await page.evaluate(() => history.length);
      await page.evaluate(() => { location.hash = 'screener'; });
      await page.waitForURL(base + '/#overview');
      await overview.waitFor();
      assert.equal(await page.evaluate(() => history.length), historyLength + 1, 'redirect replaces the retired entry');
      await page.goBack();
      await page.waitForURL(base + '/#profile');
      await page.locator('#profile-page').waitFor();
      await page.goForward();
      await page.waitForURL(base + '/#overview');
      await overview.waitFor();

      await nav.locator('[data-workspace-route="chart"]').click();
      const search = page.locator('#stock-search');
      await search.fill('OUTSIDE');
      await page.locator('.suggestion-item[data-symbol="OUTSIDE"]').click();
      await page.waitForURL(url => url.hash === '#chart' && url.searchParams.get('symbol') === 'OUTSIDE');
      assert.equal(await search.inputValue(), 'OUTSIDE');
      assert.deepEqual(state.putOwners, []);
      assert.deepEqual(retiredRequests, []);
      assert.deepEqual(errors, []);
      console.log('Screener decommission and active routes verified at ' + width + 'px');
      await context.close();
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
