'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const test = require('node:test');

// Exercise the ordinary application bootstrap, without any database adapter.
for (const name of Object.keys(process.env)) {
  if (/^(SUPABASE_|PG|DATABASE_URL$|SETSCOPE_)/.test(name)) delete process.env[name];
}
process.env.SUPABASE_URL = 'https://fixture.supabase.co';
process.env.SUPABASE_ANON_KEY = 'fixture-public-key';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (/remembered-session-postgres|dev-remembered-runtime|^pg$/.test(name)) {
    throw new Error('Remember OFF must not load the session database adapter');
  }
  return originalLoad.call(this, name, ...args);
};
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'fixture-owner' });
  if (url.includes('/rest/v1/user_watchlists')) return Response.json([{ watchlists: [], active_watchlist_id: null }]);
  throw new Error('Unexpected upstream request in offline bootstrap test');
};
const { server, start } = require('../server');
function request(route, method = 'GET', authorized = false) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method,
      headers: authorized ? { authorization: 'Bearer fixture-legacy-token' } : {} }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
test('ordinary bootstrap keeps Remember OFF without a session store or migration', async () => {
  try {
    await start();
    assert.equal((await request('/healthz')).status, 200);
    const config = await request('/api/auth-config');
    assert.equal(config.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(config.body)).sort(), ['anonKey', 'configured', 'url']);
    for (const route of ['login', 'restore', 'refresh', 'logout']) {
      const response = await request('/api/auth/session/' + route, 'POST');
      assert.equal(response.status, 404);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.equal((await request('/api/watchlists')).status, 401);
    assert.equal((await request('/api/watchlists', 'GET', true)).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    Module._load = originalLoad;
  }
});
