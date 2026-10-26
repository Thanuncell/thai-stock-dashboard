'use strict';

const PROVIDER_POLICIES = Object.freeze({
  search: Object.freeze({ ttlMs: 5_000, staleIfErrorMs: 0, errorBackoffMs: 1_000 }),
  market: Object.freeze({ ttlMs: 30_000, staleIfErrorMs: 0, errorBackoffMs: 2_000 }),
  news: Object.freeze({ ttlMs: 300_000, staleIfErrorMs: 0, errorBackoffMs: 5_000 }),
  newsArchive: Object.freeze({
    ttlMs: 30_000,
    staleIfErrorMs: 300_000,
    errorBackoffMs: 5_000,
    markHit(value) { return { ...value, cached: true }; },
    markStale(value) { return { ...value, cached: true, stale: true, dataState: 'stale' }; }
  }),
  coverage: Object.freeze({
    ttlMs: 300_000,
    staleIfErrorMs: 86_400_000,
    errorBackoffMs: 30_000,
    markHit(value) { return { ...value, cached: true }; },
    markStale(value) { return { ...value, cached: true, stale: true, dataState: 'stale' }; }
  }),
  watchlistNews: Object.freeze({ ttlMs: 300_000, staleIfErrorMs: 0, errorBackoffMs: 5_000 }),
  settrade: Object.freeze({
    ttlMs: 300_000,
    staleIfErrorMs: 1_800_000,
    errorBackoffMs: 60_000,
    markHit(value) {
      return { ...value, cached: true };
    },
    markStale(value, error) {
      const errors = [...new Set([...(Array.isArray(value.errors) ? value.errors : []), error.message])];
      return { ...value, cached: true, stale: true, partial: Boolean(value.partial), dataState: 'stale', errors };
    }
  })
});

function createWatchlistNewsCacheKey(stocks = []) {
  return `wn:${JSON.stringify(stocks.map(item => [String(item.symbol || ''), String(item.name || '')]))}`;
}

function createMemoryCache({ maxEntries = 200, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();
  const failures = new Map();

  function prune() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function remember(key, entry) {
    entries.delete(key);
    entries.set(key, entry);
    prune();
  }

  function freshResult(key, entry, policy) {
    remember(key, entry);
    return {
      value: typeof policy.markHit === 'function' ? policy.markHit(entry.value) : entry.value,
      meta: { status: 'hit', staleAgeMs: Math.max(0, now() - entry.createdAt) }
    };
  }

  function get(key, policy, load, { force = false } = {}) {
    const cached = entries.get(key);
    const failure = failures.get(key);
    if (!force && failure && now() < failure.retryAt) return Promise.reject(failure.error);
    if (failure) failures.delete(key);
    if (!force && cached?.retryAt && now() < cached.retryAt) {
      return Promise.resolve({
        value: typeof policy.markStale === 'function' ? policy.markStale(cached.value, cached.lastError) : cached.value,
        meta: { status: 'stale', staleAgeMs: Math.max(0, now() - cached.createdAt) }
      });
    }
    if (!force && cached && now() < cached.expiresAt) return Promise.resolve(freshResult(key, cached, policy));
    if (pending.has(key)) {
      return pending.get(key).then(result => ({
        value: result.value,
        meta: { ...result.meta, status: result.meta.status === 'stale' ? 'stale' : 'coalesced', coalesced: true }
      }));
    }

    const startedAt = now();
    const task = Promise.resolve().then(load).then(value => {
      const createdAt = now();
      failures.delete(key);
      remember(key, { value, createdAt, expiresAt: createdAt + policy.ttlMs });
      return { value, meta: { status: 'miss', staleAgeMs: 0, loadDurationMs: Math.max(0, createdAt - startedAt) } };
    }).catch(error => {
      const fallback = entries.get(key);
      const staleDeadline = fallback ? fallback.expiresAt + policy.staleIfErrorMs : 0;
      if (fallback && policy.staleIfErrorMs > 0 && now() <= staleDeadline) {
        fallback.retryAt = now() + (policy.errorBackoffMs || 0);
        fallback.lastError = error;
        remember(key, fallback);
        return {
          value: typeof policy.markStale === 'function' ? policy.markStale(fallback.value, error) : fallback.value,
          meta: { status: 'stale', staleAgeMs: Math.max(0, now() - fallback.createdAt) }
        };
      }
      if (policy.errorBackoffMs > 0) failures.set(key, { error, retryAt: now() + policy.errorBackoffMs });
      throw error;
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return {
    get,
    delete(key) { entries.delete(key); },
    clear() { entries.clear(); pending.clear(); failures.clear(); },
    size() { return entries.size; },
    pendingSize() { return pending.size; }
  };
}

async function retryWithBackoff(action, {
  maxAttempts = 2,
  baseDelayMs = 100,
  shouldRetry = () => false,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay))
} = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await action(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
  throw Error('Retry attempts exhausted');
}

function isTransientProviderError(error) {
  if (error?.stopBatch || error?.skipAttempt || error?.accessDenied) return false;
  return Boolean(error?.retryable)
    || /(?:HTTP\s+(?:429|502|503|504)|timeout|timed out|fetch failed)/i.test(String(error?.message || ''));
}

module.exports = {
  PROVIDER_POLICIES,
  createMemoryCache,
  createWatchlistNewsCacheKey,
  isTransientProviderError,
  retryWithBackoff
};
