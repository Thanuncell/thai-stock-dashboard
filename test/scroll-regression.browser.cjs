'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const playwrightModule = process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);

const ROOT = path.join(__dirname, '..');
const watchItems = Array.from({ length: 24 }, (_, index) => ({
  symbol: `T${String(index + 1).padStart(2, '0')}`,
  name: `บริษัททดสอบ ${index + 1}`
}));
const chartBars = Array.from({ length: 120 }, (_, index) => {
  const close = 30 + index * .08;
  return {
    time: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString(),
    open: close - .05,
    high: close + .2,
    low: close - .2,
    close,
    volume: 1_000_000 + index * 1000
  };
});

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function newsItems(count, prefix = 'ข่าวตลาด') {
  return Array.from({ length: count }, (_, index) => ({
    source: 'infoquest',
    sourceName: 'Infoquest',
    title: `${prefix} ลำดับ ${index + 1}`,
    url: `https://news.google.com/articles/browser-${prefix}-${index + 1}`,
    pubDate: new Date(Date.now() - index * 60_000).toISOString(),
    snippet: 'รายละเอียดข่าวสำหรับทดสอบพฤติกรรมการเลื่อนหน้าเว็บ',
    matchedSymbols: ['T01']
  }));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${url}`);
}

async function mockRequest(route, baseUrl, metrics) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === 'https://browser-test.supabase.co' && url.pathname === '/auth/v1/user') {
    return json(route, { id: 'browser-user', email: 'browser@example.test' });
  }
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/')) return route.continue();
  if (url.pathname === '/api/auth-config') {
    return json(route, { configured: true, url: 'https://browser-test.supabase.co', anonKey: 'browser-test-key' });
  }
  if (url.pathname === '/api/watchlists') {
    if (request.method() === 'PUT') return json(route, { ok: true, syncedAt: new Date().toISOString() });
    return json(route, { record: { watchlists: [{ id: 'list-1', name: 'Regression', items: watchItems }], active_watchlist_id: 'list-1' } });
  }
  if (url.pathname === '/api/market') {
    metrics.marketRequests += 1;
    return json(route, {
      stocks: watchItems.map((item, index) => ({ ...item, last: 30 + index, prevClose: 29 + index, change: 1, percent: 1 })),
      indices: [], history: chartBars, indicatorHistory: chartBars, levelsHistory: chartBars, errors: [],
      fetchedAt: new Date().toISOString(), asOf: new Date().toISOString(), source: 'fixture',
      stale: false, partial: false, delayed: true, delayMinutes: 15, dataState: 'delayed', provider: 'fixture'
    });
  }
  if (url.pathname === '/api/market-overview' || url.pathname === '/api/settrade-overview') {
    return json(route, {
      indices: [], breadth: {}, closeSummary: {}, activeValue: [], nvdr: {}, foreign: {}, tfex: {}, errors: [],
      fieldStatus: {}, sourceStatus: {}, links: {}, fetchedAt: new Date().toISOString(), asOf: null,
      marketDate: null, source: 'fixture', stale: false, partial: true, delayed: true, dataState: 'partial'
    });
  }
  if (url.pathname === '/api/coverage') {
    return json(route, { configured: true, universe: 400, currentVerified: 321, technicalReady: 280, lastChecked: new Date().toISOString(), provider: 'Yahoo Finance', dataState: 'fresh' });
  }
  if (url.pathname === '/api/news') {
    return json(route, { items: newsItems(28), errors: [], fetchedAt: new Date().toISOString(), asOf: new Date().toISOString(), source: 'fixture', stale: false, partial: false, dataState: 'fresh', maxAgeDays: 30 });
  }
  if (url.pathname === '/api/watchlist-news') {
    return json(route, { items: newsItems(23, 'ข่าว Watchlist'), fetchedAt: new Date().toISOString(), asOf: new Date().toISOString(), source: 'fixture', stale: false, partial: false, dataState: 'fresh', maxAgeDays: 30 });
  }
  if (url.pathname === '/api/news-archive') {
    return json(route, { configured: false, items: [], total: 0, page: 1, pageSize: 10, maxAgeDays: 365, stale: false, dataState: 'unavailable' });
  }
  if (url.pathname === '/api/news-analysis') {
    const payload = request.postDataJSON();
    return json(route, { items: (payload.items || []).map(() => ({ summary: 'สรุปข่าวสำหรับการทดสอบ', mode: 'rules', basis: 'headline' })), mode: 'rules', aiConfigured: false });
  }
  if (url.pathname === '/api/search') return json(route, { items: [], provider: 'fixture' });
  return json(route, {});
}

async function swipe(cdp, x, startY, endY) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
  for (let step = 1; step <= 6; step++) {
    const y = startY + ((endY - startY) * step / 6);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await new Promise(resolve => setTimeout(resolve, 18));
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise(resolve => setTimeout(resolve, 180));
}

async function chartSwipe(cdp, page, start, end) {
  const samples = [];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (let step = 1; step <= 7; step++) {
    const point = {
      x: start.x + ((end.x - start.x) * step / 7),
      y: start.y + ((end.y - start.y) * step / 7)
    };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    await page.waitForTimeout(36);
    samples.push(await page.locator('.price-chart-svg').innerHTML());
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(180);
  return samples;
}

async function pinch(cdp, page, center) {
  const before = await page.locator('.price-chart-svg').innerHTML();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: center.x - 35, y: center.y }, { x: center.x + 35, y: center.y }]
  });
  for (let step = 1; step <= 5; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: center.x - 35 - step * 12, y: center.y },
        { x: center.x + 35 + step * 12, y: center.y }
      ]
    });
    await page.waitForTimeout(40);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(180);
  return { before, after: await page.locator('.price-chart-svg').innerHTML() };
}

async function run() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SUPABASE_URL: 'https://browser-test.supabase.co',
      SUPABASE_ANON_KEY: 'browser-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let browser;
  try {
    await waitForServer(`${baseUrl}/healthz`);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const metrics = { marketRequests: 0 };
    await context.addInitScript(items => {
      sessionStorage.setItem('setscope-auth-session-v1', JSON.stringify({
        access_token: 'browser-access', refresh_token: 'browser-refresh', expires_at: Date.now() + 3_600_000
      }));
      localStorage.setItem('setscope-watchlists-v2:browser-user', JSON.stringify([{ id: 'list-1', name: 'Regression', items }]));
      localStorage.setItem('setscope-active-watchlist:browser-user', 'list-1');
    }, watchItems);
    const page = await context.newPage();
    await page.route('**/*', route => mockRequest(route, baseUrl, metrics));

    await page.goto(`${baseUrl}/#watchlist`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.authenticated #watchlist-mobile .watch-item');
    await page.waitForFunction(() => document.querySelectorAll('#watchlist-mobile .watch-item').length === 24);
    await page.waitForSelector('#coverage-summary[data-state="ready"]');
    assert.equal(await page.locator('#coverage-universe').textContent(), '400');
    assert.equal(await page.locator('#coverage-count').textContent(), '321');
    assert.match(await page.locator('#coverage-summary').textContent(), /แหล่งข้อมูล:\s*Yahoo Finance/);
    const list = page.locator('#watchlist-mobile');
    await list.scrollIntoViewIfNeeded();
    const box = await list.boundingBox();
    assert.ok(box && box.height > 100, 'Watchlist scroll surface must be visible');
    const point = { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 30, box.height / 2) };

    await page.evaluate(() => {
      const root = document.querySelector('#watchlist-mobile');
      root.scrollTop = root.scrollHeight;
      window.scrollTo(0, 0);
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(150);
    const wheelDownY = await page.evaluate(() => window.scrollY);

    await page.evaluate(() => {
      const root = document.querySelector('#watchlist-mobile');
      root.scrollTop = root.scrollHeight;
      window.scrollTo(0, 0);
    });
    for (let index = 0; index < 7; index++) await page.mouse.wheel(0, 42);
    await page.waitForTimeout(150);
    const touchpadDownY = await page.evaluate(() => window.scrollY);

    await page.evaluate(() => {
      const root = document.querySelector('#watchlist-mobile');
      root.scrollTop = 0;
      window.scrollTo(0, 260);
    });
    await page.mouse.move(point.x, point.y);
    const beforeWheelUp = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(150);
    const wheelUpY = await page.evaluate(() => window.scrollY);

    await page.evaluate(() => {
      const root = document.querySelector('#watchlist-mobile');
      root.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    const cdp = await context.newCDPSession(page);
    await swipe(cdp, point.x, point.y + 70, point.y - 120);
    const touchInner = await page.evaluate(() => ({ root: document.querySelector('#watchlist-mobile').scrollTop, page: window.scrollY }));
    await page.evaluate(() => {
      const root = document.querySelector('#watchlist-mobile');
      root.scrollTop = root.scrollHeight;
      window.scrollTo(0, 0);
    });
    await swipe(cdp, point.x, point.y + 70, point.y - 120);
    const touchDownY = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    const watchlistPreservation = await page.evaluate(async () => {
      const root = document.querySelector('#watchlist-mobile');
      const search = document.querySelector('#watchlist-search');
      const toggle = document.querySelector('#watchlist-toggle');
      root.scrollTop = Math.min(180, root.scrollHeight - root.clientHeight);
      window.scrollTo(0, 0);
      const before = root.scrollTop;
      search.value = 'T';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const afterSearch = root.scrollTop;
      toggle.click();
      toggle.click();
      const afterCollapse = root.scrollTop;
      root.querySelector('.watch-item')?.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      const afterSelection = root.scrollTop;
      document.querySelector('#refresh-watchlist-news').click();
      await new Promise(resolve => setTimeout(resolve, 80));
      return { before, afterSearch, afterCollapse, afterSelection, afterRefresh: root.scrollTop, page: window.scrollY };
    });
    await page.waitForFunction(() => !document.querySelector('#refresh-watchlist-news').disabled);
    await page.waitForTimeout(300);

    await page.waitForSelector('#watchlist-news-pager:not([hidden])');
    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      [...document.querySelectorAll('#watchlist-news-pager .page-btn')].find(button => button.textContent === '2')?.click();
    });
    await page.waitForTimeout(60);
    const watchPaginationEarlyY = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(400);
    const watchPaginationSettledY = await page.evaluate(() => window.scrollY);

    await page.goto(`${baseUrl}/#news`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.authenticated #news-pager:not([hidden])');
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.locator('#news-pager .page-btn').filter({ hasText: /^2$/ }).click();
    await page.waitForTimeout(60);
    const paginationEarlyY = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(500);
    const paginationSettledY = await page.evaluate(() => window.scrollY);

    await page.evaluate(() => window.scrollTo(0, Math.min(320, document.documentElement.scrollHeight - innerHeight)));
    const beforeRefresh = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.querySelector('#refresh-news').click());
    await page.waitForTimeout(150);
    const afterRefresh = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => {
      const input = document.querySelector('#news-search');
      input.value = 'ตลาด';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);
    const afterSearch = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => document.querySelector('.source-chip[data-source="infoquest"]').click());
    await page.waitForTimeout(100);
    const afterFilter = await page.evaluate(() => window.scrollY);

    const navigationScroll = await page.evaluate(async () => {
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const newsBefore = window.scrollY;
      document.querySelector('.nav-item[href="#overview"]').click();
      await settle();
      const overviewInitial = window.scrollY;
      const overviewTarget = Math.min(260, document.documentElement.scrollHeight - innerHeight);
      window.scrollTo(0, overviewTarget);
      document.querySelector('.nav-item[href="#chart"]').click();
      await settle();
      const chartInitial = window.scrollY;
      document.querySelector('.nav-item[href="#overview"]').click();
      await settle();
      const overviewRestored = window.scrollY;
      document.querySelector('.nav-item[href="#news"]').click();
      await settle();
      return { newsBefore, overviewInitial, overviewTarget, chartInitial, overviewRestored, newsRestored: window.scrollY };
    });

    await page.goto(`${baseUrl}/?symbol=T01#chart`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.authenticated .price-chart-svg');
    await page.waitForFunction(() => document.querySelectorAll('.price-candle').length >= 30);
    const chart = page.locator('#stock-price-chart');
    await chart.scrollIntoViewIfNeeded();
    let chartBox = await chart.boundingBox();
    assert.ok(chartBox && chartBox.height > 200, 'Mobile chart touch surface must be visible');
    const requestsBeforeGestures = metrics.marketRequests;
    const chartCenter = { x: chartBox.x + chartBox.width / 2, y: chartBox.y + Math.min(chartBox.height / 2, 220) };
    const horizontalPageBefore = await page.evaluate(() => window.scrollY);
    const horizontalSamples = await chartSwipe(cdp, page,
      { x: chartCenter.x - 75, y: chartCenter.y },
      { x: chartCenter.x + 105, y: chartCenter.y });
    const horizontalPageAfter = await page.evaluate(() => window.scrollY);
    const horizontalFrames = new Set(horizontalSamples).size;

    await page.evaluate(() => {
      const host = document.querySelector('#stock-price-chart');
      const top = host.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, top - 120));
    });
    await page.waitForTimeout(100);
    chartBox = await chart.boundingBox();
    const verticalStartY = await page.evaluate(() => window.scrollY);
    const verticalBefore = await chart.innerHTML();
    await chartSwipe(cdp, page,
      { x: chartBox.x + chartBox.width / 2, y: chartBox.y + Math.min(chartBox.height - 40, 260) },
      { x: chartBox.x + chartBox.width / 2 + 4, y: chartBox.y + 55 });
    const verticalEndY = await page.evaluate(() => window.scrollY);
    const verticalAfter = await chart.innerHTML();

    await chart.scrollIntoViewIfNeeded();
    chartBox = await chart.boundingBox();
    const pinchResult = await pinch(cdp, page, { x: chartBox.x + chartBox.width / 2, y: chartBox.y + Math.min(chartBox.height / 2, 220) });

    await page.setViewportSize({ width: 1280, height: 900 });
    await chart.scrollIntoViewIfNeeded();
    chartBox = await chart.boundingBox();
    const desktopBefore = await chart.innerHTML();
    await page.mouse.move(chartBox.x + chartBox.width * .35, chartBox.y + chartBox.height * .45);
    await page.mouse.down();
    await page.mouse.move(chartBox.x + chartBox.width * .65, chartBox.y + chartBox.height * .45, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(180);
    const desktopAfter = await chart.innerHTML();
    const requestsAfterGestures = metrics.marketRequests;
    const chartGesture = {
      touchAction: await chart.evaluate(node => getComputedStyle(node).touchAction),
      horizontalFrames,
      horizontalPageBefore,
      horizontalPageAfter,
      verticalStartY,
      verticalEndY,
      verticalChartChanged: verticalBefore !== verticalAfter,
      pinchChanged: pinchResult.before !== pinchResult.after,
      desktopChanged: desktopBefore !== desktopAfter,
      providerRequestDelta: requestsAfterGestures - requestsBeforeGestures
    };

    const results = {
      wheelDownY, touchpadDownY, beforeWheelUp, wheelUpY, touchInner, touchDownY,
      watchlistPreservation, watchPaginationEarlyY, watchPaginationSettledY,
      paginationEarlyY, paginationSettledY, beforeRefresh, afterRefresh, afterSearch, afterFilter,
      navigationScroll, chartGesture
    };
    console.log(JSON.stringify(results));
    assert.ok(wheelDownY > 0, 'mouse wheel must hand off from the Watchlist boundary to the page');
    assert.ok(touchpadDownY > 0, 'touchpad-style wheel deltas must hand off from the Watchlist boundary to the page');
    assert.ok(wheelUpY < beforeWheelUp, 'upward wheel input must hand off from the top boundary to the page');
    assert.ok(touchInner.root > 0 && touchInner.page === 0, 'touch swipe must scroll inside Watchlist before its boundary');
    assert.ok(touchDownY > 0, 'touch swipe must hand off from the Watchlist boundary to the page');
    assert.ok(watchlistPreservation.before > 0, 'Watchlist preservation test requires an internal scroll position');
    assert.equal(watchlistPreservation.afterSearch, watchlistPreservation.before, 'Watchlist search must preserve internal scroll');
    assert.equal(watchlistPreservation.afterCollapse, watchlistPreservation.before, 'Watchlist collapse and expand must preserve internal scroll');
    assert.equal(watchlistPreservation.afterSelection, watchlistPreservation.before, 'Watchlist rerender must preserve internal scroll');
    assert.equal(watchlistPreservation.afterRefresh, watchlistPreservation.before, 'Watchlist News refresh must preserve internal scroll');
    assert.equal(watchlistPreservation.page, 0, 'Watchlist state changes must not move the page');
    assert.equal(watchPaginationEarlyY, 0, 'Watchlist News pagination must move the actual window to the top');
    assert.equal(watchPaginationSettledY, 0, 'Watchlist News pagination must not bounce after rendering');
    assert.equal(paginationEarlyY, 0, 'News pagination must move the actual window to the top');
    assert.equal(paginationSettledY, 0, 'News pagination must not bounce after rendering');
    assert.ok(Math.abs(afterRefresh - beforeRefresh) <= 1, 'manual/background News refresh must not change window scroll');
    assert.ok(Math.abs(afterSearch - beforeRefresh) <= 1, 'News search must not change window scroll');
    assert.ok(Math.abs(afterFilter - beforeRefresh) <= 1, 'News source filter must not change window scroll');
    assert.ok(navigationScroll.overviewTarget > 0, 'Overview fixture must provide a meaningful saved scroll position');
    assert.equal(navigationScroll.overviewInitial, 0, 'first Overview navigation must use its own position');
    assert.equal(navigationScroll.chartInitial, 0, 'first Chart navigation must use its own position');
    assert.equal(navigationScroll.overviewRestored, navigationScroll.overviewTarget, 'Overview navigation must restore its own scroll');
    assert.equal(navigationScroll.newsRestored, navigationScroll.newsBefore, 'News navigation must restore its own scroll');
    assert.ok(chartGesture.horizontalFrames >= 3, 'mobile horizontal chart pan must update progressively');
    assert.ok(Math.abs(chartGesture.horizontalPageAfter - chartGesture.horizontalPageBefore) <= 1, 'horizontal chart pan must not move the page');
    assert.ok(chartGesture.verticalEndY > chartGesture.verticalStartY, 'vertical chart swipe must use native page scroll');
    assert.equal(chartGesture.verticalChartChanged, false, 'vertical page swipe must not pan the chart');
    assert.equal(chartGesture.pinchChanged, true, 'two-finger chart pinch must keep zooming');
    assert.equal(chartGesture.desktopChanged, true, 'desktop chart drag must keep panning');
    assert.equal(chartGesture.providerRequestDelta, 0, 'cached chart gestures must make zero provider requests');
  } finally {
    await browser?.close().catch(() => {});
    if (server.exitCode === null) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill();
      await stopped;
    }
  }
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
