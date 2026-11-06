'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_POLICIES,
  createMemoryCache,
  createWatchlistNewsCacheKey,
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
  assert.equal(fallback.value.dataState, 'stale');
  assert.equal(fallback.value.fetchedAt, new Date(5_000).toISOString());
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

test('watchlist news cache keys cover every normalized provider input', () => {
  const first = createWatchlistNewsCacheKey([{ symbol: 'PTT', name: 'ปตท.' }]);
  const renamed = createWatchlistNewsCacheKey([{ symbol: 'PTT', name: 'PTT Public Company' }]);
  assert.notEqual(first, renamed);
  assert.equal(first, createWatchlistNewsCacheKey([{ symbol: 'PTT', name: 'ปตท.' }]));
});

const policy = {
  ttlMs: 100,
  staleIfErrorMs: 200,
  errorBackoffMs: 1_000,
  markStale(value) { return { ...value, stale: true, dataState: 'stale' }; }
};

test('WS3: stale cache cannot outlive its configured LKG window during cooldown', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = createMemoryCache({ now: () => now });
  await cache.get('settrade:test', policy, () => ({ observedAt: now }));

  now = 1_101;
  const stale = await cache.get('settrade:test', policy, async () => {
    loads += 1;
    throw Error('provider unavailable');
  });
  assert.equal(stale.meta.status, 'stale');
  assert.equal(stale.value.dataState, 'stale');

  now = 1_301; // 1 ms beyond expiresAt + staleIfErrorMs; retry backoff remains active.
  await assert.rejects(cache.get('settrade:test', policy, async () => {
    loads += 1;
    return { observedAt: now };
  }), /provider unavailable|CACHE_STALE_BACKOFF_EXPIRED/);
  assert.equal(loads, 1, 'an expired fallback must not trigger a new upstream call during cooldown');

  now = 2_102; // After retryAt, loading is permitted again.
  const recovered = await cache.get('settrade:test', policy, async () => {
    loads += 1;
    return { observedAt: now };
  });
  assert.equal(recovered.meta.status, 'miss');
  assert.equal(recovered.value.observedAt, now);
  assert.equal(loads, 2);
});

test('WS3: cache still reuses stale fallback within the permitted LKG window', async () => {
  let now = 5_000;
  const cache = createMemoryCache({ now: () => now });
  await cache.get('coverage:test', policy, async () => ({ observedAt: now }));
  now = 5_101;
  await cache.get('coverage:test', policy, async () => { throw Error('timeout'); });
  now = 5_300; // Exactly at expiresAt + staleIfErrorMs is still allowed.
  const result = await cache.get('coverage:test', policy, () => { throw Error('unexpected fetch'); });
  assert.equal(result.meta.status, 'stale');
  assert.equal(result.value.dataState, 'stale');
});

test('WS3: no-stale market policy remains fail-closed', async () => {
  let now = 7_000;
  const cache = createMemoryCache({ now: () => now });
  await cache.get('market:test', PROVIDER_POLICIES.market, async () => ({ value: 1 }));
  now += PROVIDER_POLICIES.market.ttlMs + 1;
  await assert.rejects(cache.get('market:test', PROVIDER_POLICIES.market, async () => { throw Error('down'); }), /down/);
  await assert.rejects(cache.get('market:test', PROVIDER_POLICIES.market, async () => ({ value: 2 })), /down/);
});

function recordPayload(body, time = Date.parse('2026-11-06T04:30:00Z')) {
  const output = [];
  let finish;
  const res = {
    statusCode: 200,
    setHeader() {},
    once(_event, cb) { finish = cb; }
  };
  const audit = createObservability({
    logger: { info: line => output.push(JSON.parse(line)) },
    now: () => time,
    requestId: () => 'test-request'
  });
  audit.startRequest({ method: 'GET' }, res, '/api/market-overview');
  audit.markPayload(res, body);
  finish();
  return output[0];
}

test('WS5: a timestamp alone cannot prove market data is fresh', () => {
  const log = recordPayload({ fetchedAt: '2024-01-01T00:00:00Z', provider: 'SETTRADE' });
  assert.equal(log.dataState, 'unknown');
  assert.ok(log.staleAgeMs > 1_000_000);
});

test('WS5: explicit stale state takes precedence over a valid timestamp', () => {
  const log = recordPayload({ fetchedAt: '2026-11-06T04:29:00Z', stale: true });
  assert.equal(log.dataState, 'stale');
});

test('WS5: explicitly verified fresh state remains visible', () => {
  const log = recordPayload({ dataState: 'fresh', asOf: '2026-11-06T04:29:00Z' });
  assert.equal(log.dataState, 'fresh');
});

test('WS5: errors without source quality state are partial', () => {
  const log = recordPayload({ fetchedAt: '2026-11-06T04:29:00Z', errors: ['bad upstream'] });
  assert.equal(log.dataState, 'partial');
});

test('diagnostics never log arbitrary inbound or publisher path segments', async () => {
  const lines = [];
  const observability = createObservability({ logger: { info: line => lines.push(JSON.parse(line)) } });
  const res = { statusCode: 404, setHeader() {}, once(_event, cb) { this.finish = cb; } };
  observability.startRequest({ method: 'GET' }, res, '/api/path-redaction-marker');
  res.finish();
  const fetch = observability.observedFetch(async () => ({ status: 200 }));
  await fetch('https://example.test/news/path-redaction-marker?query-redaction-marker=1');
  await fetch('https://query1.finance.yahoo.com/v8/finance/chart/path-redaction-marker');
  assert.equal(lines[0].route, 'unknown');
  assert.equal(lines[1].operation, 'fetch');
  assert.equal(lines[2].operation, 'chart');
  assert.doesNotMatch(JSON.stringify(lines), /redaction-marker/);
});
