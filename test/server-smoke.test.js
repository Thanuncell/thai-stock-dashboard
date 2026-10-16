'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-publishable-key';

const NativeResponse = globalThis.Response;
const upstreamCalls = [];
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  upstreamCalls.push({ url, init });
  if (url.endsWith('/auth/v1/user')) {
    return new NativeResponse(JSON.stringify({ id: 'user-a', email: 'a@example.test' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.includes('/rest/v1/user_watchlists')) {
    if ((init.method || 'GET') === 'POST') return new NativeResponse('', { status: 201 });
    return new NativeResponse(JSON.stringify([{ watchlists: [], active_watchlist_id: 'list-1' }]), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (url.startsWith('https://www.settrade.com/')) {
    if (url.includes('/nvdr/value') || url.includes('/derivatives/overview')) throw new Error('simulated provider outage');
    if (url.includes('/historical-report/investor-type')) return new NativeResponse(fixture('settrade-foreign.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('/top-ranking/most-active-value')) return new NativeResponse('<div class="table-placeholder"></div>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new NativeResponse(fixture('settrade-overview.html'), { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (url.includes('query1.finance.yahoo.com/v8/finance/chart/')) {
    if (url.includes('AOT.BK')) return new NativeResponse('upstream unavailable', { status: 503 });
    const symbol = url.includes('%5ESET.BK') || url.includes('^SET.BK') ? '^SET.BK' : 'PTT.BK';
    return new NativeResponse(JSON.stringify({ chart: { result: [{
      meta: { symbol, regularMarketPrice: 35.25, chartPreviousClose: 35, regularMarketTime: 1_760_000_000 },
      timestamp: [1_760_000_000],
      indicators: { quote: [{ open: [35], high: [35.5], low: [34.75], close: [35.25], volume: [1000] }] }
    }], error: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://news.google.com/rss/search')) {
    if (decodeURIComponent(url).includes('site:kaohoon.com')) return new NativeResponse('unavailable', { status: 503 });
    const now = new Date().toUTCString();
    return new NativeResponse(`<rss><channel><item><title>PTT update</title><link>https://news.google.com/articles/1</link><pubDate>${now}</pubDate><description>Market update</description><source>ทันหุ้น</source></item></channel></rss>`, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' }
    });
  }
  throw new Error(`Unexpected upstream request: ${url}`);
};

const { server } = require('../server');

function request(base, pathname, options = {}) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {} }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('health and static responses have strict security headers without invalid CORS', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await request(base, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).service, 'setscope');
  assert.match(health.headers['content-security-policy'], /default-src 'self'/);
  assert.match(health.headers['content-security-policy'], /connect-src 'self' https:\/\/project\.supabase\.co/);
  assert.match(health.headers['content-security-policy'], /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(health.headers['content-security-policy'], /font-src 'self' https:\/\/fonts\.gstatic\.com/);
  assert.equal(health.headers['access-control-allow-origin'], undefined);

  const page = await request(base, '/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await request(base, '/lib/indicators.js')).status, 200);
  assert.equal((await request(base, '/theme-init.js')).status, 200);
});

test('protected APIs reject missing bearer tokens', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await request(base, '/api/market?symbols=PTT&symbol=PTT&range=1D');
  assert.equal(response.status, 401);
  assert.equal(JSON.parse(response.body).error, 'กรุณาเข้าสู่ระบบ');
});

test('watchlist reads and writes are scoped to the validated auth user', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer test-token' };
  const read = await request(base, '/api/watchlists', { headers });
  assert.equal(read.status, 200);
  const readCall = upstreamCalls.find(call => call.url.includes('/rest/v1/user_watchlists') && !call.init.method);
  assert.match(readCall.url, /user_id=eq\.user-a/);

  const write = await request(base, '/api/watchlists', {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: 'user-b',
      watchlists: [{ id: 'list-1', name: 'Main', items: [{ symbol: 'ptt', name: 'PTT' }] }],
      activeWatchlistId: 'list-1'
    })
  });
  assert.equal(write.status, 200);
  const writeCall = upstreamCalls.find(call => call.url.includes('/rest/v1/user_watchlists') && call.init.method === 'POST');
  const upstreamBody = JSON.parse(writeCall.init.body);
  assert.equal(upstreamBody.user_id, 'user-a');
  assert.equal(upstreamBody.watchlists[0].items[0].symbol, 'PTT');
});

test('partial provider outages degrade independently without fabricating zero values', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: 'Bearer test-token' };

  const marketResponse = await request(base, '/api/market?symbols=PTT,AOT&symbol=PTT&range=1D', { headers });
  assert.equal(marketResponse.status, 200);
  const market = JSON.parse(marketResponse.body);
  assert.deepEqual(market.stocks.map(stock => stock.symbol), ['PTT']);
  assert.ok(market.errors.some(error => error.includes('AOT')));
  assert.equal(market.stocks[0].last, 35.25);

  const settradeResponse = await request(base, '/api/settrade-overview', { headers });
  assert.equal(settradeResponse.status, 200);
  const settrade = JSON.parse(settradeResponse.body);
  assert.equal(settrade.indices[0].symbol, 'SET');
  assert.equal(settrade.nvdr.marketMillion, null);
  assert.equal(settrade.tfex.available, false);
  assert.equal(settrade.errors.length, 2);
  assert.ok(settrade.fetchedAt);

  const newsResponse = await request(base, '/api/news', { headers });
  assert.equal(newsResponse.status, 200);
  const news = JSON.parse(newsResponse.body);
  assert.ok(news.items.length > 0);
  assert.deepEqual(news.errors, ['kaohoon']);
});
