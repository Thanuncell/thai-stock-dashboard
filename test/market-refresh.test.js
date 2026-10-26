'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createMemoryCache } = require('../server/reliability');
const { invalidateVerifiedMarket } = require('../server/market-refresh');
const { backend } = require('./fixtures/controlled-backend.cjs');
const { manualSignature } = require('../server/controlled-coverage');

test('invalidation fences old in-flight responses without discarding the newer pending load', async () => {
  const cache = createMemoryCache(), policy = { ttlMs: 30000, staleIfErrorMs: 0 };
  let oldResolve, newResolve, calls = 0;
  const old = cache.get('market:PTT|PTT|3M', policy, () => { calls++; return new Promise(resolve => { oldResolve = resolve; }); });
  await Promise.resolve();
  cache.invalidate(key => key.startsWith('market:'));
  const fresh = cache.get('market:PTT|PTT|3M', policy, () => { calls++; return new Promise(resolve => { newResolve = resolve; }); });
  await Promise.resolve(); oldResolve('old'); await old;
  assert.equal(cache.pendingSize(), 1);
  const coalesced = cache.get('market:PTT|PTT|3M', policy, () => assert.fail('duplicate new request'));
  newResolve('new'); assert.equal((await fresh).value, 'new'); assert.equal((await coalesced).value, 'new');
  assert.equal((await cache.get('market:PTT|PTT|3M', policy, () => assert.fail('cache overwritten'))).value, 'new');
  assert.equal(calls, 2);
});

test('only accepted quote and chart evidence invalidates exact affected symbols and leaves other modules cached', async () => {
  const cache = createMemoryCache(), policy = { ttlMs: 30000, staleIfErrorMs: 0 };
  for (const key of ['market:PTT|PTT|3M', 'market:PTTGC|PTTGC|3M', 'news', 'coverage-summary']) await cache.get(key, policy, () => key);
  const valid = { quoteReady: true, chartReady: true, guardStatus: 'delayed', asOf: new Date().toISOString() };
  assert.equal(invalidateVerifiedMarket(cache, 'PTT', { ...valid, guardStatus: 'stale' }), false);
  assert.equal(invalidateVerifiedMarket(cache, 'PTT', { ...valid, quoteReady: false }), false);
  assert.equal(cache.size(), 4);
  assert.equal(invalidateVerifiedMarket(cache, 'PTT', valid), true); assert.equal(cache.size(), 3);
  for (const key of ['market:PTTGC|PTTGC|3M', 'news', 'coverage-summary']) assert.equal((await cache.get(key, policy, () => assert.fail('unrelated cache evicted'))).value, key);
});

test('an old failed load cannot poison a newer valid cache entry after invalidation', async () => {
  const cache = createMemoryCache(), policy = { ttlMs: 30000, staleIfErrorMs: 0, errorBackoffMs: 10000 };
  let rejectOld;
  const old = cache.get('market:PTT|PTT|3M', policy, () => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const rejection = assert.rejects(old, /old failure/);
  await Promise.resolve(); cache.invalidate(() => true);
  await cache.get('market:PTT|PTT|3M', policy, () => 'current');
  rejectOld(Error('old failure')); await rejection;
  assert.equal((await cache.get('market:PTT|PTT|3M', policy, () => assert.fail('fresh cache poisoned'))).value, 'current');
});

test('actual protected manual trigger refreshes the next /api/market price, candles and provider as-of', async t => {
  process.env.SUPABASE_URL = 'https://fixture.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'synthetic-publishable';
  process.env.SUPABASE_SECRET_KEY = 'synthetic-fixture';
  process.env.SETSCOPE_V156_MANUAL_VERIFY = '1';
  process.env.SETSCOPE_V156_TRIGGER_TOKEN = 'fixture-'.repeat(6);
  delete process.env.SETSCOPE_V156_KILL;
  delete process.env.SET_API_KEY;
  const db = backend();
  const initial = Date.now() - 60000, latest = Date.now();
  db.advance(initial, 35);
  globalThis.fetch = db.fetchImpl;
  const { server } = require('../server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  function request(path, { method = 'GET', auth = 'fixture-user', body } = {}) {
    return new Promise((resolve, reject) => {
      const timestamp = String(Date.now());
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
        headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json',
          ...(body ? { 'x-setscope-sent-at': timestamp, 'x-setscope-signature': manualSignature(body, auth, timestamp) } : {}) } }, res => {
        const chunks = [];
        res.on('data', data => chunks.push(data));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
  }
  const path = '/api/market?symbols=PTT&symbol=PTT&range=3M';
  const before = await request(path); assert.equal(before.status, 200); assert.equal(before.body.stocks[0].last, 35);
  db.advance(latest, 36);
  const cached = await request(path); assert.equal(cached.body.stocks[0].last, 35);
  const run = await request('/api/automation/manual', { method: 'POST', auth: process.env.SETSCOPE_V156_TRIGGER_TOKEN, body: { tag: 'refresh' } });
  assert.equal(run.status, 200); assert.equal(run.body.verified, 1);
  const after = await request(path); assert.equal(after.status, 200);
  assert.equal(after.body.stocks[0].last, 36); assert.equal(after.body.history.at(-1).close, 36);
  assert.equal(after.body.asOf, new Date(Math.floor(latest / 1000) * 1000).toISOString());
  assert.equal(after.body.stale, false); assert.equal(after.body.delayed, true);
  assert.ok(!['stale', 'unavailable', 'suspect'].includes(after.body.dataState));
  assert.notEqual(after.body.asOf, before.body.asOf);
  t.diagnostic(JSON.stringify({ trigger: run.body.metrics, apiCallsAcrossTwoLoads: db.calls.filter(call => call.url.hostname === 'query1.finance.yahoo.com').length - run.body.metrics.providerCalls }));
});
