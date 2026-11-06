'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');

const root = path.resolve(__dirname, '..');
const stocks = ['WHA', 'AMATA', 'ROJNA'];
const items = symbols => symbols.map(symbol => ({ symbol, name: 'บริษัท ' + symbol }));
const ownerLists = {
  a: [{ id: 'list-1', name: 'A Smart', items: items(stocks) }, { id: 'list-2', name: 'A Second', items: items(['PTT']) }],
  b: [{ id: 'list-1', name: 'B Smart', items: items(['CPALL']) }]
};
const quote = (symbol, last, prior, dataState = 'delayed') => ({
  symbol, last, prior, provider: 'Yahoo Finance', guardStatus: 'accepted', identityStatus: 'accepted', dataState
});

async function run() {
  const mime = { '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
  const server = http.createServer(async (request, response) => {
    const name = new URL(request.url, 'http://127.0.0.1').pathname;
    const file = path.resolve(root, ['/', '/login', '/register'].includes(name) ? 'index.html' : name.slice(1));
    if (!file.startsWith(root + path.sep) || !mime[path.extname(file)]) return response.writeHead(404).end();
    try { response.writeHead(200, { 'content-type': mime[path.extname(file)] }).end(await fs.readFile(file)); }
    catch { response.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const state = { getOwners: [], putOwners: [] }, requests = [], news = [], errors = [];
    let price = 4, amataPrice = 20, failMarket = false, interval = '1m';
    const time = Date.UTC(2026, 10, 4, 3);
    const history = Array.from({ length: 70 }, (_, i) => {
      const close = 30 + i / 10;
      return { time: time + i * 60000, open: close, close, high: close + .2, low: close - .2, volume: 1000 };
    });
    const receivedAt = new Date(time + 71 * 60000).toISOString();
    const metadata = { provider: 'Yahoo Finance', interval: '1m', receivedAt, timeZone: 'Asia/Bangkok' };
    let indicatorReceivedAt = receivedAt, whaIdentity = 'accepted', historyState = 'delayed', historyLength = history.length;
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const owner = /token-b/.test(request.headers().authorization || '') ? 'b' : 'a';
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
      if (url.origin === base && url.pathname === '/api/watchlists') {
        if (request.method() === 'PUT') return json({ ok: true, syncedAt: new Date().toISOString() });
        return json({ record: { watchlists: ownerLists[owner], active_watchlist_id: 'list-1' } });
      }
      if (url.origin === base && url.pathname === '/api/market') {
        const symbols = url.searchParams.get('symbols').split(',');
        requests.push(symbols);
        if (failMarket) return json({ error: 'fixture unavailable' }, 503);
        const quotes = owner === 'b' ? [quote('CPALL', 45, 43)] : [
          { ...quote('WHA', price, 5), identityStatus: whaIdentity },
          quote('AMATA', amataPrice, 19), quote('ROJNA', 3, 4, 'stale'), quote('PTT', 40, null)
        ];
        const bars = history.slice(0, historyLength);
        return json({ stocks: quotes, indices: [], history: bars, indicatorHistory: bars, levelsHistory: bars,
          technicalMeta: { history: metadata, indicator: { ...metadata, interval, receivedAt: indicatorReceivedAt }, levels: metadata },
          fetchedAt: receivedAt, dataState: historyState });
      }
      if (url.origin === base && url.pathname === '/api/watchlist-news') {
        assert.equal(request.method(), 'POST');
        const symbols = request.postDataJSON().stocks.map(stock => stock.symbol);
        news.push(symbols);
        return json({ fetchedAt: new Date().toISOString(), dataState: 'fresh', items: symbols.map(symbol => ({
          source: 'kaohoon', sourceName: 'ข่าวหุ้น', title: symbol + ' รายงานผลประกอบการ',
          url: 'https://www.kaohoon.com/news/fixture-' + symbol,
          pubDate: new Date().toISOString(), matchedSymbols: [symbol],
          verification: { status: 'VERIFIED', basis: 'article' }
        })) });
      }
      return mockRequest(route, base, state);
    });
    page.on('pageerror', error => errors.push(error.message));
    await seedPage(page, 'token-a');
    await page.addInitScript(() => localStorage.setItem('setscope-alert-prefs:user-a', JSON.stringify({
      WHA: { above: '5', below: '', technical: false },
      AMATA: { above: '-1', below: '18', technical: false },
      ROJNA: { above: '', below: '5', technical: false }
    })));
    const nav = route => page.locator(`.side-nav [data-workspace-route="${route}"]`);
    const list = page.locator('#watchlist-mobile');
    const visible = () => list.locator('.watch-item').evaluateAll(rows => rows.map(row => row.dataset.sym));
    const checkResult = page.locator('#watchlist-check-result');
    const checkButton = page.locator('#alerts-panel #watchlist-check');
    const signal = page.locator('#watchlist-signal-detail summary');
    const cards = page.locator('#watchlist-signal-content .technical-reason-card');
    const sort = page.locator('#watchlist-sort');
    await page.goto(base + '/?symbol=WHA&range=1D#chart');
    await page.waitForSelector('#technical-reasons .compact-reasons');
    const overall = await page.locator('#overall-signal').textContent();
    const reasons = await page.locator('#technical-reasons .technical-reason-text').allTextContents();
    await nav('watchlist').click();
    await list.locator('table').waitFor();
    assert.deepEqual(await visible(), stocks);
    assert.deepEqual(await list.locator('thead th').allTextContents(), ['หุ้น', 'ราคาล่าสุด', 'เปลี่ยนแปลง (%)', 'จัดการ']);
    assert.deepEqual(await list.locator('tbody tr').evaluateAll(rows => rows.map(row => row.cells.length)), [4, 4, 4]);
    assert.equal(await sort.inputValue(), 'saved');
    assert.equal(await page.locator('#watchlist-filter, #watchlist-group').count(), 0);
    assert.equal(await page.locator('.watchlist-tools select').count(), 1);
    assert.deepEqual(await sort.locator('option').allTextContents(), [
      'ค่าเริ่มต้น', '% เปลี่ยนแปลง (สูงสุด → ต่ำสุด)', '% เปลี่ยนแปลง (ต่ำสุด → สูงสุด)',
      'ราคา (สูงสุด → ต่ำสุด)', 'ราคา (ต่ำสุด → สูงสุด)'
    ]);
    assert.equal(await list.evaluate(root => root.scrollWidth <= root.clientWidth), true);
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('ROJNA รายงาน'));
    assert.equal(await signal.textContent(), 'สัญญาณ WHA · ' + overall + ' · 1D');
    assert.equal(await list.locator('[data-sym=ROJNA] .watch-price').textContent(), '—');
    assert.equal(await page.locator('.watchlist-source').textContent(), 'แหล่งข้อมูล: Yahoo Finance · ล่าช้าประมาณ 15 นาที');
    await signal.focus();
    await page.keyboard.press('Enter');
    assert.deepEqual(await cards.locator('.technical-reason-text').allTextContents(), reasons);
    assert.deepEqual(await cards.locator('.technical-reason-number').allTextContents(),
      reasons.map((_, index) => String(index + 1).padStart(2, '0')));
    assert.equal(await page.locator('#watchlist-signal-content li').count(), 0);
    const initial = [requests.length, news.length];
    await page.locator('#watchlist-search').fill('wha');
    assert.deepEqual(await visible(), ['WHA']);
    for (const symbol of stocks) assert.match(await page.locator('#watchlist-news-list').textContent(), new RegExp(symbol + ' รายงาน'));
    await page.locator('#watchlist-search').fill('');
    for (const [option, expected] of [
      ['change-desc', ['AMATA', 'WHA', 'ROJNA']], ['change-asc', stocks],
      ['price-desc', ['AMATA', 'WHA', 'ROJNA']], ['saved', stocks], ['price-asc', stocks]
    ]) {
      await sort.selectOption(option);
      assert.deepEqual(await visible(), expected);
    }
    assert.deepEqual([requests.length, news.length], initial);
    await page.locator('#refresh-watchlist-news').click();
    await page.waitForFunction(() => !document.querySelector('#refresh-watchlist-news').disabled);
    assert.deepEqual(news.at(-1), stocks);
    await page.locator('#alerts-toggle').click();
    assert.equal(await checkButton.textContent(), 'ตรวจเงื่อนไขราคา');
    assert.equal(await checkButton.isVisible(), true);
    assert.equal(requests.length, initial[0], 'opening alert settings must not run a manual check');
    price = 5;
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('ถึงเงื่อนไข: WHA'));
    assert.equal(await checkResult.textContent(), 'ตรวจราคาได้ 2 หุ้น · ถึงเงื่อนไข: WHA · ตรวจราคาไม่ได้: ROJNA');
    assert.deepEqual(requests.at(-1), stocks);
    const countAlerts = () => page.locator('#alerts-history .alert-history-item').count();
    assert.equal(await countAlerts(), 1);
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
    assert.equal(await countAlerts(), 1, 'repeat check must not duplicate a crossing alert');
    assert.equal(requests.length, initial[0] + 2);
    amataPrice = 18;
    interval = '5m';
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('WHA, AMATA'));
    assert.equal(await countAlerts(), 2);
    assert.equal(await signal.textContent(), 'สัญญาณ WHA · ยังไม่พร้อม', 'mismatched interval');
    interval = '1m';
    const verifyUnavailable = async (setInvalid, restore, reason) => {
      setInvalid();
      await checkButton.click();
      await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
      assert.equal(await signal.textContent(), 'สัญญาณ WHA · ยังไม่พร้อม', reason);
      assert.equal(await cards.count(), 0);
      restore();
      await checkButton.click();
      await page.waitForFunction(() => !document.querySelector('#watchlist-check').disabled);
      assert.equal(await signal.textContent(), 'สัญญาณ WHA · ' + overall + ' · 1D');
    };
    await verifyUnavailable(() => { whaIdentity = undefined; }, () => { whaIdentity = 'accepted'; }, 'unverified symbol');
    await verifyUnavailable(() => { indicatorReceivedAt = null; }, () => { indicatorReceivedAt = receivedAt; }, 'missing observation time');
    await verifyUnavailable(() => { indicatorReceivedAt = new Date(time + 72 * 60000).toISOString(); },
      () => { indicatorReceivedAt = receivedAt; }, 'observation time newer than response');
    await verifyUnavailable(() => { historyState = 'stale'; }, () => { historyState = 'delayed'; }, 'invalid history state despite valid quote');
    await verifyUnavailable(() => { historyLength = 10; }, () => { historyLength = history.length; }, 'insufficient confirmed history');
    failMarket = true;
    await page.locator('#watchlist-check').click();
    await page.waitForFunction(() => document.querySelector('#watchlist-check-result').textContent.includes('ตรวจราคาไม่สำเร็จ'));
    assert.equal(await list.locator('[data-sym=WHA] .watch-price').textContent(), '—');
    assert.equal(await countAlerts(), 2);
    failMarket = false;
    const beforeResize = requests.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await list.locator(':scope > .watch-item').first().waitFor();
    assert.equal(await list.locator('table').count(), 0);
    assert.equal(await sort.inputValue(), 'price-asc');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(requests.length, beforeResize);
    await page.locator('#theme-toggle').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('#watchlist-select-mobile').selectOption('list-2');
    await page.waitForFunction(() => document.querySelector('#watchlist-mobile [data-sym=PTT]'));
    assert.equal(await checkResult.isVisible(), false);
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('PTT รายงาน'));
    const withoutConditions = requests.length;
    await page.locator('#alerts-toggle').click();
    await checkButton.click();
    assert.match(await checkResult.textContent(), /ตั้งเงื่อนไขราคา/);
    assert.equal(requests.length, withoutConditions);
    await page.locator('#alerts-close').click();
    await page.locator('#watchlist-select-mobile').selectOption('list-1');
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list').textContent.includes('ROJNA รายงาน'));
    const amata = list.locator('[data-sym=AMATA] .watch-select');
    await amata.focus();
    await page.keyboard.press('Enter');
    assert.equal(await amata.getAttribute('aria-pressed'), 'true');
    assert.match(await signal.textContent(), /^สัญญาณ AMATA · /);
    await page.locator('#watchlist-search').fill('WHA');
    await nav('profile').click();
    await Promise.all([page.waitForEvent('load'), page.locator('#profile-logout-button').click()]);
    await page.locator('#login-form input[name=email]').fill('b@example.test');
    await page.locator('#login-form input[name=password]').fill('fixture-password');
    await page.locator('#login-form button[type=submit]').click();
    await page.waitForSelector('body.authenticated');
    await nav('watchlist').click();
    await list.locator('[data-sym=CPALL]').waitFor();
    assert.deepEqual(await visible(), ['CPALL']);
    assert.equal(await page.locator('#watchlist-search').inputValue(), '');
    assert.equal(await page.locator('#watchlist-sort').inputValue(), 'saved');
    await page.locator('#alerts-toggle').click();
    assert.equal(await checkResult.textContent(), '');
    assert.doesNotMatch(await page.locator('#alerts-panel').textContent(), /WHA|AMATA|ROJNA/);
    assert.doesNotMatch(await page.locator('#watchlist-page').textContent(), /WHA|AMATA|ROJNA/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ smartWatchlist: 'PASS', desktop: 1366, mobile: 390, viewRequests: 0, liveProviderRequests: 0 }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => { console.error(error.stack); process.exitCode = 1; });
