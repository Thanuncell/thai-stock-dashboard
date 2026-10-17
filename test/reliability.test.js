'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_POLICIES,
  createMemoryCache,
  retryWithBackoff
} = require('../server/reliability');
const { createObservability } = require('../server/observability');

test('identical concurrent cache misses are coalesced into one upstream load', async () => {
  let loads = 0;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const cache = createMemoryCache();
  const load = async () => { loads += 1; await pending; return { fetchedAt: '2026-10-17T00:00:00.000Z' }; };

  const first = cache.get('market:PTT', PROVIDER_POLICIES.market, load);
  const second = cache.get('market:PTT', PROVIDER_POLICIES.market, load);
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(loads, 1);
  assert.equal(a.meta.status, 'miss');
  assert.equal(b.meta.status, 'coalesced');
  assert.deepEqual(a.value, b.value);
  assert.equal(cache.pendingSize(), 0);
});

test('failed loads clear pending state and market policy never serves stale data', async () => {
  let now = 1_000;
  const cache = createMemoryCache({ now: () => now });
  await cache.get('market:PTT', PROVIDER_POLICIES.market, async () => ({ value: 1 }));
  now += PROVIDER_POLICIES.market.ttlMs + 1;

  await assert.rejects(cache.get('market:PTT', PROVIDER_POLICIES.market, async () => { throw Error('upstream down'); }), /upstream down/);
  assert.equal(cache.pendingSize(), 0);
  let repeatedLoads = 0;
  await assert.rejects(cache.get('market:PTT', PROVIDER_POLICIES.market, async () => { repeatedLoads += 1; return { value: 2 }; }), /upstream down/);
  assert.equal(repeatedLoads, 0);
});

test('SETTRADE stale fallback is bounded and explicitly marked', async () => {
  let now = 5_000;
  const cache = createMemoryCache({ now: () => now });
  await cache.get('settrade', PROVIDER_POLICIES.settrade, async () => ({ fetchedAt: new Date(now).toISOString() }));
  now += PROVIDER_POLICIES.settrade.ttlMs + 1;
  const fallback = await cache.get('settrade', PROVIDER_POLICIES.settrade, async () => { throw Error('timeout'); });

  assert.equal(fallback.meta.status, 'stale');
  assert.equal(fallback.value.stale, true);
  assert.ok(fallback.meta.staleAgeMs > 0);

  let repeatedLoads = 0;
  const backedOff = await cache.get('settrade', PROVIDER_POLICIES.settrade, async () => { repeatedLoads += 1; return {}; });
  assert.equal(backedOff.meta.status, 'stale');
  assert.equal(repeatedLoads, 0);

  now += PROVIDER_POLICIES.settrade.staleIfErrorMs + 1;
  await assert.rejects(cache.get('settrade', PROVIDER_POLICIES.settrade, async () => { throw Error('still down'); }), /still down/);
});

test('exponential backoff is bounded and only retries approved failures', async () => {
  const delays = [];
  let attempts = 0;
  const value = await retryWithBackoff(async () => {
    attempts += 1;
    if (attempts < 2) throw Object.assign(Error('HTTP 503'), { retryable: true });
    return 'ok';
  }, {
    maxAttempts: 2,
    baseDelayMs: 50,
    shouldRetry: error => error.retryable === true,
    sleep: async delay => { delays.push(delay); }
  });
  assert.equal(value, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [50]);

  attempts = 0;
  await assert.rejects(retryWithBackoff(async () => {
    attempts += 1;
    throw Error('HTTP 400');
  }, { maxAttempts: 3, shouldRetry: () => false, sleep: async () => {} }), /HTTP 400/);
  assert.equal(attempts, 1);
});

test('structured logs contain operational fields but never accept credentials', async () => {
  const lines = [];
  const observability = createObservability({
    logger: { info: line => lines.push(JSON.parse(line)) },
    now: (() => { let value = 100; return () => value += 25; })(),
    requestId: () => 'request-1'
  });
  observability.emit('http_request', {
    requestId: 'request-1', route: '/api/market', provider: 'Yahoo Finance',
    durationMs: 25, status: 200, cacheStatus: 'hit', staleAgeMs: 10,
    authorization: 'Bearer secret-token', token: 'secret-token'
  });

  assert.deepEqual(lines[0], {
    event: 'http_request', requestId: 'request-1', route: '/api/market',
    provider: 'Yahoo Finance', durationMs: 25, status: 200,
    cacheStatus: 'hit', staleAgeMs: 10
  });
  assert.doesNotMatch(JSON.stringify(lines), /secret-token|authorization|token/i);
});
