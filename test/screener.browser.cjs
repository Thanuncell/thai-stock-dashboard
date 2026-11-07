'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { buildIndexCatalog } = require('../server/screener-index');
const { coverage } = require('./fixtures/screener.cjs');

(async () => {
  process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
  const { server } = require('../server');
  const group = (...symbols) => ({ symbols, effectiveFrom: '2026-01-01', effectiveThrough: '2099-12-31' });
  const longName = 'NO PRICE EXAMPLE ' + 'LONGCOMPANYNAME'.repeat(9);
  const named = (symbol, name) => ({ ...coverage(symbol), company_name_en: name,
    name_source: 'https://example.test/company', name_checked_at: '2026-01-01' });
  const indexCatalog = buildIndexCatalog([
    named('ADVANC', 'ADVANCED INFO SERVICE PUBLIC COMPANY LIMITED'),
    named('CPALL', 'CP ALL PUBLIC COMPANY LIMITED'),
    named('NOPRICE', longName), coverage('PTT'),
    ...Array.from({ length: 496 }, (_, i) => coverage('S' + String(i).padStart(3, '0')))
  ], {
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
      const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width < 800, colorScheme: 'light' });
      const state = { getOwners: [], putOwners: [] };
      const calls = [];
      const modules = [];
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === base && url.pathname.startsWith('/api/')) calls.push(url.pathname);
        if (url.origin === base && url.pathname.includes('/screener-')) modules.push(url.pathname);
        if (url.origin === base && url.pathname === '/api/market') {
          const symbol = url.searchParams.get('symbol');
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
        if (url.origin === base && url.pathname === '/api/screener') return route.abort();
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
      const screener = page.getByRole('region', { name: 'รายชื่อหุ้นตามดัชนีและตลาด' });
      await screener.getByRole('heading', { name: 'รายชื่อหุ้นตามดัชนีและตลาด', level: 2 }).waitFor();
      assert.equal(await page.locator('#workspace-description').textContent(), 'ค้นหาและเลือกดูหุ้นตามดัชนีและตลาดจดทะเบียน');
      const indexList = page.locator('#screener-index-list');
      await indexList.locator('li').first().waitFor();
      await page.waitForLoadState('networkidle');
      assert.equal(calls.filter(call => call === '/api/screener').length, 0, 'hidden technical screener must not fetch its snapshot');
      assert.equal(calls.filter(call => call === '/api/screener/coverage').length, 1);
      assert.equal(await page.locator('#screener-technical, #screener-filters, #screener-results, #screener-index-source').count(), 0);
      assert.doesNotMatch(await screener.textContent(),
        /Stock Screener|คัดกรองทางเทคนิค|Yahoo Finance|แหล่งข้อมูล|หลักฐานตรวจเทียบ|แสดงเฉพาะรายการ|ใช้ชุดนี้ถึง/);
      const tabs = page.getByRole('group', { name: 'กลุ่มหุ้น' });
      assert.deepEqual(await tabs.getByRole('button').allTextContents(), ['ทั้งหมด', 'SET50', 'SET100', 'SETHD', 'SETESG', 'mai']);
      const indexStatus = page.locator('#screener-index-status');
      assert.match(await indexStatus.textContent(), /500.*500/);
      assert.equal(await indexList.locator('li').count(), 20);
      const fetchesBeforeInteractions = calls.length;
      await page.locator('#screener-index-next').click();
      assert.equal(await page.locator('#screener-index-page').textContent(), 'หน้า 2 / 25');
      await page.locator('#screener-index-prev').click();
      assert.equal(await page.locator('#screener-index-page').textContent(), 'หน้า 1 / 25');
      for (const [key, symbols] of [
        ['SET50', ['PTT']], ['SET100', ['PTT', 'S002']], ['SETHD', ['S003']],
        ['SETESG', ['PTT', 'S001']], ['mai', ['S001']]
      ]) {
        await tabs.getByRole('button', { name: key, exact: true }).click();
        assert.equal(await tabs.getByRole('button', { name: key, exact: true }).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await indexList.locator('strong').allTextContents(), symbols);
        assert.equal(await page.locator('#screener-index-source').count(), 0);
      }
      await tabs.getByRole('button', { name: 'ทั้งหมด', exact: true }).click();
      const indexSearch = page.getByRole('searchbox', { name: 'ค้นหารายชื่อหุ้น' });
      await indexSearch.fill('advanced info service');
      assert.deepEqual(await indexList.locator('strong').allTextContents(), ['ADVANC']);
      assert.equal(await indexList.locator('small').textContent(), 'ADVANCED INFO SERVICE PUBLIC COMPANY LIMITED');
      await indexSearch.fill('PTT');
      assert.deepEqual(await indexList.locator('strong').allTextContents(), ['PTT']);
      assert.equal(await indexList.locator('small').count(), 0, 'unverified names show only the symbol');
      await indexSearch.fill('No Price Example');
      assert.deepEqual(await indexList.locator('strong').allTextContents(), ['NOPRICE']);
      assert.equal(await indexList.locator('small').textContent(), longName);
      assert.equal(indexCatalog.stocks.find(row => row.symbol === 'NOPRICE').membershipStatus, 'UNKNOWN');
      const longCard = indexList.getByRole('link', { name: 'เปิดกราฟ NOPRICE' });
      await indexSearch.focus();
      await page.keyboard.press('Tab');
      assert.equal(await longCard.evaluate(card => card.matches(':focus-visible') && getComputedStyle(card).outlineStyle !== 'none'), true);
      const checkCard = () => longCard.evaluate(card => {
        const ticker = card.querySelector('strong');
        const company = card.querySelector('small');
        return { bg: getComputedStyle(card).backgroundColor, full: card.offsetWidth === card.closest('ul').clientWidth,
          wraps: company.scrollWidth <= company.clientWidth, stacked: company.offsetTop > ticker.offsetTop };
      });
      const light = await checkCard();
      assert.ok(light.full && light.wraps && light.stacked);
      await page.locator('#theme-toggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      const dark = await checkCard();
      assert.ok(dark.full && dark.wraps && dark.stacked && dark.bg !== light.bg);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.locator('#theme-toggle').click();
      await indexSearch.fill('CPALL');
      assert.deepEqual(await indexList.locator('strong').allTextContents(), ['CPALL']);
      assert.equal(await indexList.locator('small').textContent(), 'CP ALL PUBLIC COMPANY LIMITED');
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
      const card = await chartLink.boundingBox();
      await chartLink.click({ position: { x: card.width - 12, y: 12 } });
      await page.waitForURL(/symbol=CPALL.*range=1D#chart$/);
      assert.equal(await page.locator('#stock-search').inputValue(), 'CPALL');
      assert.equal(await page.locator('#chart-section').isVisible(), true);
      assert.equal(await page.locator('#screener-page').isVisible(), false);
      await page.getByRole('img', { name: 'กราฟแท่งเทียน CPALL ช่วง 1D' }).waitFor();
      assert.equal(await page.locator('#chart-price').textContent(), '70.00');
      await page.goBack();
      await indexList.locator('li').first().waitFor();
      await page.goForward();
      await page.getByRole('img', { name: 'กราฟแท่งเทียน CPALL ช่วง 1D' }).waitFor();
      await page.goBack();
      await chartLink.waitFor();
      if (width === 1366) {
        const [tab] = await Promise.all([context.waitForEvent('page'), chartLink.click({ modifiers: ['ControlOrMeta'] })]);
        await tab.bringToFront();
        const chart = tab.getByRole('img', { name: 'กราฟแท่งเทียน CPALL ช่วง 1D' });
        const login = tab.locator('#login-form');
        const signIn = login.locator('button[type="submit"]:enabled');
        await chart.or(signIn).first().waitFor();
        if (await signIn.isVisible()) {
          await login.locator('input[name="email"]').fill('a@example.test');
          await login.locator('input[name="password"]').fill('fixture-password');
          await signIn.click();
        }
        await chart.waitFor();
        assert.match(tab.url(), /symbol=CPALL.*range=1D#chart$/);
        assert.match(page.url(), /#screener$/);
        await tab.close();
      }
      assert.equal(await page.locator('#screener-technical').count(), 0);
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
