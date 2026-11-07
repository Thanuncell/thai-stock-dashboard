'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const { createScreenerService } = require('../server/screener-service');
const { coverage, dailyBars, guardedDaily, observedAt } = require('./fixtures/screener.cjs');

async function fixture() {
  const registry = Array.from({ length: 498 }, (_, i) => coverage('S' + String(i).padStart(3, '0')));
  registry.push(coverage('PTT'), coverage('CPALL'));
  for (const row of registry.filter(row => ['S496', 'S497', 'CPALL'].includes(row.symbol))) row.active = false;
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
      let mode = 'ready';
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base && url.pathname.startsWith('/api/')) calls.push(url.pathname);
        if (url.origin === base && url.pathname.includes('/screener-')) modules.push(url.pathname);
        if (url.origin === base && url.pathname === '/api/screener') {
          assert.match(route.request().headers().authorization, /^Bearer /);
          if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'fixture' } });
          if (mode === 'stale') return route.fulfill({ json: { ...payload, marketFreshness: 'STALE', snapshot: {
            ...payload.snapshot, state: 'UNAVAILABLE', counts: { ...payload.snapshot.counts, ready: 0, staleSession: 498 }, rows: []
          } } });
          if (mode === 'partial') return route.fulfill({ json: { ...payload, marketFreshness: 'CURRENT_SESSION', snapshot: {
            ...payload.snapshot, state: 'PARTIAL', counts: { ...payload.snapshot.counts, ready: 496, unavailable: 1 }
          } } });
          if (mode === 'expired') return route.fulfill({ json: { ...payload, validUntil: new Date(Date.now() - 1000).toISOString() } });
          return route.fulfill({ json: payload });
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
      await page.locator('#screener-results').waitFor();
      await page.waitForLoadState('networkidle');
      const readCount = calls.length;
      assert.equal(calls.filter(call => call === '/api/screener').length, 1);
      const nav = page.getByRole('link', { name: 'คัดกรองหุ้น', exact: true });
      assert.equal(await nav.getAttribute('aria-current'), 'page');
      assert.match(await page.locator('#screener-coverage').textContent(), /500.*497.*497/);
      assert.equal(await page.locator('#screener-results tbody tr').count(), 20);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.equal(await page.locator('.side-nav .nav-item').count(), 6);
      assert.ok(await page.locator('#user-avatar').isVisible());
      await nav.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      assert.ok(await nav.evaluate(link => link.matches(':focus-visible')));
      const search = page.getByRole('searchbox', { name: 'ชื่อหรือสัญลักษณ์หุ้น' });
      const reset = page.getByRole('button', { name: 'ล้างตัวกรอง' });
      await search.fill('ปตท.');
      await search.press('Enter');
      assert.equal(await page.locator('#screener-results tbody tr').count(), 1);
      assert.match(await page.locator('#screener-results tbody').innerText(), /PTT/);
      await reset.click();
      await page.getByRole('button', { name: 'ถัดไป' }).click();
      assert.match(await page.locator('#screener-page-number').textContent(), /หน้า 2/);
      await page.getByRole('button', { name: 'ก่อนหน้า' }).click();
      assert.match(await page.locator('#screener-page-number').textContent(), /หน้า 1/);
      await search.fill('S495');
      await search.press('Enter');
      assert.match(await page.locator('#screener-results tbody').innerText(), /EMA20 ยังไม่พร้อม/);
      await page.getByLabel('RSI 14 ขั้นต่ำ').fill('10');
      await search.press('Enter');
      assert.match(await page.locator('#screener-result-summary').textContent(), /ไม่พบ.*ข้อมูลตัวกรองไม่พอ 1/);
      await reset.click();
      await page.getByLabel('ราคาปิดขั้นต่ำ').fill('100');
      await page.getByLabel('ราคาปิดสูงสุด').fill('1');
      await search.press('Enter');
      await page.getByRole('alert').filter({ hasText: 'ตรวจช่วงตัวกรอง' }).waitFor();
      await reset.click();
      await page.getByLabel('เรียงผลลัพธ์').selectOption('price:asc');
      await search.press('Enter');
      assert.equal(await page.locator('#screener-results tbody tr').first().getByRole('rowheader').textContent(), 'S495');
      await page.getByLabel('ตัวกรองสำเร็จรูป').selectOption('trend');
      await search.press('Enter');
      assert.match(await page.locator('#screener-result-summary').textContent(), /ข้อมูลตัวกรองไม่พอ 1/);
      const filterP95 = await page.locator('#screener-filters').evaluate(form => {
        const samples = Array.from({ length: 25 }, () => {
          const start = performance.now();
          form.requestSubmit();
          return performance.now() - start;
        }).sort((a, b) => a - b);
        return samples[Math.ceil(samples.length * .95) - 1];
      });
      assert.equal(calls.length, readCount, 'filters, sorting and pagination must reuse the snapshot');
      if (width === 1366) {
        for (const [name, selector] of [['ภาพรวมตลาด', '#market-overview'], ['กราฟเทคนิค', '#chart-section'],
          ['ข่าวและบทวิเคราะห์', '#news-section'], ['รายการติดตาม', '#watchlist-page'], ['โปรไฟล์', '#profile-page']]) {
          await page.locator('.side-nav').getByRole('link', { name }).click();
          await page.locator(selector).waitFor();
          assert.equal(await page.locator('#screener-page').isVisible(), false);
        }
        await nav.click();
        await page.goBack();
        await page.locator('#profile-page').waitFor();
        await page.goForward();
        await page.locator('#screener-results').waitFor();
        assert.equal(calls.filter(call => call === '/api/screener').length, 1);
      }
      for (const [nextMode, message] of [['stale', 'ข้อมูลเก่ากว่ารอบล่าสุด'], ['partial', 'ข้อมูลคัดกรองยังไม่พร้อม'], ['error', 'โหลดข้อมูลคัดกรองไม่สำเร็จ'],
        ['expired', 'ข้อมูลคัดกรองหมดอายุ']]) {
        mode = nextMode;
        await page.getByRole('button', { name: 'โหลดข้อมูลคัดกรองใหม่' }).click();
        await page.locator('#screener-status').filter({ hasText: message }).waitFor();
        assert.equal(await page.locator('#screener-results').isVisible(), false);
        assert.equal(await search.isVisible(), false);
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log('Screener browser verified at ' + width + 'px, 500-stock filter and render p95 ' + filterP95.toFixed(1) + ' ms');
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
