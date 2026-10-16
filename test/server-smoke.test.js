'use strict';

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-publishable-key';

const NativeResponse = globalThis.Response;
const upstreamCalls = [];
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
  assert.equal(health.headers['access-control-allow-origin'], undefined);

  const page = await request(base, '/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
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
