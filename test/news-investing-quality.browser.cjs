'use strict';
const assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage } = require('./account-isolation.browser.cjs');
const owner = require('./fixtures/investing-owner-pages.json'), quality = require('./fixtures/investing-news-quality.json');
let checks = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' }); res.end(data);
    });
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const [viewportName, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }]]) for (const theme of ['light', 'dark']) for (const mode of ['mixed', 'rejected']) {
      const context = await browser.newContext({ viewport });
      const date = new Date(Date.now() - 60000).toISOString(), analysed = [], pageErrors = [];
      // These legacy responses deliberately claim VERIFIED. The shared browser
      // predicate must still reject their current content/URL classification.
      const legacy = row => ({ ...row, source: 'other', sourceName: 'Investing.com', pubDate: date, matchedSymbols: ['PTT'], verification: { status: 'VERIFIED', basis: 'metadata' } });
      const bad = owner.cases.flatMap(row => [legacy({ ...row, title: row.title + ' - Investing.com', snippet: 'ข้อมูลตลาดหุ้นไทยและข้อมูลตราสาร ราคาซื้อขาย กราฟและข้อมูลย้อนหลังในประเทศไทย' }),
        legacy({ ...row, title: row.title + ' - Investing.com', url: 'https://news.google.com/rss/articles/owner-' + row.id, snippet: 'ข้อมูลตลาดหุ้นไทยและข้อมูลตราสาร ราคาซื้อขาย กราฟและข้อมูลย้อนหลังในประเทศไทย' })]);
      bad.push(legacy({ title: quality.articles[1].title, url: 'https://news.google.com/rss/articles/sparse', snippet: 'Thailand stocks' }));
      bad.push(legacy({ title: 'US stocks rise as earnings improve - Investing.com', url: 'https://news.google.com/rss/articles/irrelevant', snippet: 'US stocks rose as the technology sector reported stronger earnings and investors assessed the outlook for American companies. The Federal Reserve said that domestic inflation remained elevated.' }));
      const good = quality.articles.map(row => legacy({ ...row, url: 'https://news.google.com/rss/articles/quality-' + row.id }));
      const candidates = mode === 'mixed' ? [...bad, ...good] : bad;
      const state = { getOwners: [], putOwners: [], holdNextAPut: false, holdNextLogout: false, holdNextAGet: false, holdNextAMarket: false };
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
        const reply = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.origin === base && ['/api/news', '/api/watchlist-news'].includes(url.pathname)) return reply({ items: candidates, dataState: 'fresh', fetchedAt: date });
        if (url.origin === base && url.pathname === '/api/news-archive') {
          const excluded = new Set(url.searchParams.getAll('exclude'));
          const items = candidates.filter(row => !excluded.has(row.url));
          return reply({ configured: true, items, featured: [], total: items.length, page: 1, countExact: true, dataState: 'fresh' });
        }
        if (url.origin === base && url.pathname === '/api/news-analysis') {
          const items = request.postDataJSON().items; analysed.push(...items);
          return reply({ items: items.map(() => ({ summary: '', mode: 'unavailable', basis: 'headline' })), mode: 'unavailable' });
        }
        return mockRequest(route, base, state);
      });
      const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.name));
      await seedPage(page, 'token-a'); await page.addInitScript(value => localStorage.setItem('setscope-theme', value), theme);
      await page.goto(base + '/#news'); await page.waitForSelector('body.authenticated');
      await page.waitForFunction(() => !document.querySelector('#refresh-news').disabled && document.querySelector('#news-list')?.getAttribute('aria-busy') === 'false');
      const expected = mode === 'mixed' ? good.map(row => row.title).sort() : [];
      const visible = () => page.locator('#featured-news .news-title-link, #news-list .news-title-link').allTextContents();
      check((await visible()).sort(), expected, 'Feed and legacy Archive hide all Owner examples');
      await page.locator('.source-chip[data-source="investing"]').click();
      await page.waitForFunction(() => document.querySelector('#news-list')?.getAttribute('aria-busy') === 'false');
      check((await visible()).sort(), expected, 'Investing source filter retains valid Thai and English articles');
      await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
      await page.waitForFunction(() => document.querySelector('#watchlist-news-list')?.getAttribute('aria-busy') === 'false');
      check((await page.locator('#watchlist-news-list .news-title-link').allTextContents()).sort(), expected, 'Watchlist uses the same quality predicate');
      check(analysed.every(row => good.some(value => value.url === row.url)), true, 'rejected/uncertain articles never reach analysis');
      if (mode === 'rejected') check(analysed.length, 0, 'all-rejected view makes zero sentiment requests');
      check(pageErrors, []);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      console.log(JSON.stringify({ viewport: viewportName, theme, mode, ownerEntries: owner.cases.length, result: 'PASS' }));
      await context.close();
    }
    console.log(JSON.stringify({ investingQualityBrowser: 'PASS', checks, liveProviderRequests: 0 }));
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
