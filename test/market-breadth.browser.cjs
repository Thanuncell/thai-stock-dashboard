'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { mockRequest, seedPage, freePort } = require('./account-isolation.browser.cjs');

const labels = ['ปรับขึ้น', 'ไม่เปลี่ยนแปลง', 'ปรับลง'];
const group = (market, count, volume) => ({ market, items: ['Gainers', 'Unchanges', 'Losers'].map((label, i) => ({ label, count: count === null ? null : count + i, volumeThousand: volume === null ? null : volume + i })) });
const empty = labels.map(label => [label, '—', '—']);
const rows = (count, volume) => labels.map((label, i) => [label, count === null ? '—' : (count + i).toFixed(2), volume === null ? '—' : (volume + i).toFixed(2)]);
const cases = [
  { name: 'both markets', breadth: [group('mai', 20, 200), group('SET', 10, 100)], expected: [rows(10, 100), rows(20, 200)] },
  { name: 'SET only', breadth: [group('SET', 10, 100)], expected: [rows(10, 100), empty] },
  { name: 'mai only', breadth: [group('mai', 20, 200)], expected: [empty, rows(20, 200)] },
  { name: 'no data', breadth: [], expected: [empty, empty] },
  { name: 'partial fields and zero', breadth: [group('SET', 0, null), group('mai', null, 0)], expected: [rows(0, null), rows(null, 0)] },
  { name: 'invalid fields and unknown market', breadth: [group('SET50', 999, 999), group('SET', -4, 10), group('mai', 20, -4)], expected: [rows(null, 10), rows(20, null)] },
  { name: 'ambiguous duplicate rows', breadth: [group('SET', 10, 100), group('SET', 20, 200)], expected: [empty, empty] },
  { name: 'acquisition failure', fail: true, expected: [empty, empty] }
];

(async () => {
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const root = path.join(__dirname, '..');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, base).pathname;
    const file = path.resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
      if (error) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  let browser, checks = 0;
  const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
  try {
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const [viewportName, viewport] of [['desktop', { width: 1366, height: 900 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 800 }]]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport });
        let current = cases[0];
        const state = { getOwners: [], putOwners: [], holdNextAPut: false, holdNextLogout: false, holdNextAGet: false, holdNextAMarket: false };
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== base && url.origin !== 'https://isolation-test.supabase.co') return route.abort();
          if (url.origin === base && ['/api/market-overview', '/api/settrade-overview'].includes(url.pathname)) return route.fulfill({ status: current.fail ? 503 : 200, contentType: 'application/json', body: JSON.stringify(current.fail ? { error: 'Fixture unavailable' } : { indices: [], breadth: current.breadth, fieldStatus: { breadth: { partial: true, coverageReason: 'MAI_BREADTH_LABELS_UNVERIFIED' } }, tfex: {}, nvdr: {}, foreign: {}, activeValue: [] }) });
          return mockRequest(route, base, state);
        });
        const page = await context.newPage();
        await seedPage(page, 'token-a');
        await page.addInitScript(value => localStorage.setItem('setscope-theme', value), theme);
        for (const scenario of cases) {
          current = scenario;
          await page.goto('about:blank');
          await page.goto(base + '/#overview', { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('body.authenticated');
          await page.waitForFunction(() => document.querySelector('#settrade-updated')?.textContent === 'อัปเดตข้อมูลไม่สำเร็จ' || document.querySelector('#refresh-market-data')?.disabled === false);
          const tables = page.locator('#market-breadth-list table');
          check(await tables.locator('caption').allTextContents(), ['SET', 'mai'], scenario.name);
          for (let i = 0; i < 2; i++) {
            check(await tables.nth(i).locator('tbody tr').evaluateAll(nodes => nodes.map(row => [...row.cells].map(cell => cell.textContent))), scenario.expected[i], scenario.name);
            check(await tables.nth(i).evaluate(table => table.scrollWidth <= table.clientWidth + 1), true, 'table fits viewport');
          }
          check(await page.locator('#market-breadth-list > :not(table)').count(), 0, 'no warning beneath tables');
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no page overflow');
        }
        await page.goto(base + '/#profile', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('body.authenticated');
        check(await page.locator('#profile-recovery-button').textContent(), 'รับรหัสผ่านใหม่');
        check(await page.locator('#forgot-password-form button[type="submit"]').textContent(), 'ส่งลิงก์ตั้งรหัสผ่านใหม่');
        console.log(JSON.stringify({ viewport: viewportName, theme, scenarios: cases.length, result: 'PASS' }));
        await context.close();
      }
    }
    console.log(JSON.stringify({ marketBreadthBrowser: 'PASS', checks, liveProviderRequests: 0 }));
  } finally { await browser?.close().catch(() => {}); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
