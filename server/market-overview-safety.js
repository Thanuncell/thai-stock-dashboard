'use strict';

const PROVIDER_STATE = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED'
});

function safetyError(code, message, { status = 0, retryable = false } = {}) {
  const error = Error(`${code}: ${message}`);
  error.code = code;
  error.status = status;
  error.retryable = retryable;
  return error;
}

function explicitAccessDenial(html = '') {
  const value = String(html);
  return /cf-chl-|bot challenge|access denied|captcha challenge|verify (?:that )?you are human/i.test(value)
    || /<title[^>]*>[^<]*(?:captcha|challenge)[^<]*<\/title>/i.test(value)
    || /<title[^>]*>[^<]*(?:login|sign in|เข้าสู่ระบบ)[^<]*<\/title>/i.test(value)
    || /<input[^>]+type=["']password["']/i.test(value);
}

function expectedSettradeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'settrade.com' || url.hostname === 'www.settrade.com');
  } catch (_) {
    return false;
  }
}

function createMarketOverviewSafety({
  fetchImpl = globalThis.fetch,
  enabled = process.env.MARKET_OVERVIEW_SCRAPER_ENABLED !== 'false',
  now = Date.now,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  minSpacingMs = Number(process.env.MARKET_OVERVIEW_MIN_SPACING_MS) || 250,
  budgetWindowMs = Number(process.env.MARKET_OVERVIEW_BUDGET_WINDOW_MS) || 300_000,
  maxRequestsPerWindow = Number(process.env.MARKET_OVERVIEW_MAX_REQUESTS_PER_WINDOW) || 7,
  cooldownMs = Number(process.env.MARKET_OVERVIEW_COOLDOWN_MS) || 900_000,
  maxAttempts = Number(process.env.MARKET_OVERVIEW_MAX_ATTEMPTS) || 2,
  openAfterFailures = Number(process.env.MARKET_OVERVIEW_OPEN_AFTER_FAILURES) || 2,
  retryBaseMs = 200
} = {}) {
  let state = enabled ? PROVIDER_STATE.ACTIVE : PROVIDER_STATE.DISABLED;
  let openUntil = 0;
  let lastRequestAt = 0;
  let lastSuccessAt = null;
  let lastHttpStatus = null;
  let transientFailures = 0;
  let rateLimitCount = 0;
  let halfOpenProbe = false;
  let queue = Promise.resolve();
  const requestTimes = [];

  function snapshot() {
    return {
      state,
      lastSuccessAt,
      lastHttpStatus,
      openUntil: openUntil || null,
      requestCount: requestTimes.filter(time => now() - time < budgetWindowMs).length,
      budgetWindowMs,
      maxRequestsPerWindow,
      minSpacingMs
    };
  }

  function refreshState() {
    if (state === PROVIDER_STATE.OPEN && now() >= openUntil) state = PROVIDER_STATE.HALF_OPEN;
  }

  function assertAvailable() {
    refreshState();
    if (state === PROVIDER_STATE.DISABLED) throw safetyError('SCRAPER_DISABLED', 'Market Overview scraper is disabled');
    if (state === PROVIDER_STATE.MANUAL_REVIEW_REQUIRED) {
      throw safetyError('MANUAL_REVIEW_REQUIRED', 'Provider access requires manual review');
    }
    if (state === PROVIDER_STATE.OPEN) throw safetyError('BACKOFF', 'Provider circuit is OPEN');
    if (state === PROVIDER_STATE.HALF_OPEN && halfOpenProbe) {
      throw safetyError('OPEN', 'Provider HALF_OPEN probe is already in progress');
    }
  }

  function consumeBudget() {
    const cutoff = now() - budgetWindowMs;
    while (requestTimes.length && requestTimes[0] <= cutoff) requestTimes.shift();
    if (requestTimes.length >= maxRequestsPerWindow) {
      throw safetyError('REQUEST_BUDGET_EXHAUSTED', 'Shared provider request budget is exhausted');
    }
    requestTimes.push(now());
  }

  function openCircuit(error) {
    state = PROVIDER_STATE.OPEN;
    halfOpenProbe = false;
    if (error.code === 'RATE_LIMITED') {
      rateLimitCount += 1;
      openUntil = now() + cooldownMs * Math.min(4, 2 ** (rateLimitCount - 1));
    } else {
      openUntil = now() + cooldownMs;
    }
  }

  async function perform(url, init) {
    if (!expectedSettradeUrl(url)) throw safetyError('SOURCE_GUARD_REJECTED', 'Unexpected provider URL');
    const waitMs = Math.max(0, lastRequestAt + minSpacingMs - now());
    if (waitMs > 0) await sleep(waitMs);

    let attempt = 0;
    let lastError;
    while (attempt < maxAttempts) {
      attempt += 1;
      consumeBudget();
      lastRequestAt = now();
      try {
        const response = await fetchImpl(url, init);
        lastHttpStatus = response.status;
        if (response.url && !expectedSettradeUrl(response.url)) {
          throw safetyError('SOURCE_GUARD_REJECTED', 'Provider redirected outside the expected URL family');
        }
        if (response.status === 304) {
          transientFailures = 0;
          state = PROVIDER_STATE.ACTIVE;
          halfOpenProbe = false;
          lastSuccessAt = new Date(now()).toISOString();
          return { text: '', status: 304, notModified: true };
        }
        const text = await response.text();
        if (response.status === 401 || response.status === 403 || explicitAccessDenial(text)) {
          state = PROVIDER_STATE.MANUAL_REVIEW_REQUIRED;
          halfOpenProbe = false;
          throw safetyError('MANUAL_REVIEW_REQUIRED', `Provider access denied (HTTP ${response.status})`, { status: response.status });
        }
        if (response.status === 429) {
          const error = safetyError('RATE_LIMITED', 'Provider returned HTTP 429; BACKOFF required', { status: 429 });
          openCircuit(error);
          throw error;
        }
        if (response.status >= 500) {
          throw safetyError('TRANSIENT_PROVIDER_FAILURE', `Provider returned HTTP ${response.status}`, { status: response.status, retryable: true });
        }
        if (!response.ok) throw safetyError('PROVIDER_HTTP_ERROR', `Provider returned HTTP ${response.status}`, { status: response.status });

        transientFailures = 0;
        rateLimitCount = 0;
        state = PROVIDER_STATE.ACTIVE;
        halfOpenProbe = false;
        lastSuccessAt = new Date(now()).toISOString();
        return { text, status: response.status, notModified: false };
      } catch (error) {
        lastError = error;
        if (error.code === 'MANUAL_REVIEW_REQUIRED' || error.code === 'RATE_LIMITED') throw error;
        const retryable = Boolean(error.retryable) || /timeout|timed out|fetch failed/i.test(String(error.message || ''));
        if (!retryable || attempt >= maxAttempts) break;
        await sleep(retryBaseMs * (2 ** (attempt - 1)));
      }
    }

    transientFailures += 1;
    if (state === PROVIDER_STATE.HALF_OPEN || transientFailures >= openAfterFailures) {
      openCircuit(lastError || safetyError('TRANSIENT_PROVIDER_FAILURE', 'Provider request failed'));
      throw safetyError('OPEN', lastError?.message || 'Provider circuit opened', { status: lastError?.status, retryable: true });
    }
    state = PROVIDER_STATE.ACTIVE;
    halfOpenProbe = false;
    throw lastError;
  }

  function request(url, init = {}) {
    try { assertAvailable(); }
    catch (error) { return Promise.reject(error); }
    const task = queue.catch(() => {}).then(() => {
      assertAvailable();
      if (state === PROVIDER_STATE.HALF_OPEN) halfOpenProbe = true;
      return perform(url, init);
    });
    queue = task.catch(() => {});
    return task;
  }

  return { request, snapshot, states: PROVIDER_STATE };
}

module.exports = {
  PROVIDER_STATE,
  createMarketOverviewSafety,
  expectedSettradeUrl,
  explicitAccessDenial,
  safetyError
};
