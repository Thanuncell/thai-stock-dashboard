'use strict';

const { TFEX_HOME_URL, parseTfexHome } = require('./tfex-home-parser');
const { explicitAccessDenial } = require('./market-overview-safety');
const { PROVIDER_POLICIES } = require('./reliability');

function createTfexHomeSource({ enabled = false, fetchImpl = globalThis.fetch, now = Date.now,
  policy = PROVIDER_POLICIES.settrade, maxSourceAgeMs = PROVIDER_POLICIES.settrade.staleIfErrorMs } = {}) {
  let lastGood = null, pending = null, freshUntil = 0, nextAttemptAt = 0, stoppedReason = null, lastFailure = null;
  const empty = () => ({ available: false, delayMinutes: 15, totalVolume: null, openInterest: null,
    marketDate: '', investorType: [], topVolume: [] });
  function sourceTimeValid(record) {
    const time = Date.parse(record.diagnostics.reportedAsOf);
    return Number.isFinite(time) && now() >= record.savedAt && time <= now() && now() - time <= maxSourceAgeMs;
  }
  function result(state, record, reason = null) {
    const diagnostics = record ? structuredClone(record.diagnostics) : null;
    return { value: record ? { ...record.value, investorType: [], topVolume: [] } : empty(),
      status: { state, source: 'TFEX', sourceUrl: TFEX_HOME_URL, asOf: null, delayed: true,
        sourceLabel: 'TFEX Official', fetchedAt: record?.fetchedAt || null,
        sourceUpdatedAt: diagnostics?.reportedAsOf || null,
        freshness: state === 'LKG' ? 'LKG' : state === 'PASS' ? 'SOURCE_SNAPSHOT' : 'UNVERIFIED',
        freshnessVerified: false,
        volumeEffectiveTime: null, openInterestEffectiveTime: null, tradingSessionDate: null,
        openInterestReference: diagnostics?.openInterestReference || null,
        ...(state === 'LKG' ? { stale: true } : {}), reason,
        ...(diagnostics ? { reportedAsOf: diagnostics.reportedAsOf,
          partial: record.value.totalVolume === null || record.value.openInterest === null
            || !diagnostics.openInterestReference || diagnostics.invalidFields.length > 0,
          sourceTimeAgeMs: now() - Date.parse(diagnostics.reportedAsOf) } : {}) },
      fetchedAt: record?.fetchedAt || null, diagnostics: diagnostics || null };
  }
  function failure(reason) {
    if (lastGood && now() >= lastGood.savedAt && Date.parse(lastGood.diagnostics.reportedAsOf) <= now()
      && now() - lastGood.savedAt <= policy.staleIfErrorMs) return result('LKG', lastGood, reason);
    return result('UNAVAILABLE', null, reason);
  }
  async function readBody(response) {
    const limit = 1_000_000;
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) { await reader.cancel(); throw Object.assign(Error(), { code: 'BODY_SIZE_LIMIT' }); }
          chunks.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks).toString('utf8');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > limit) throw Object.assign(Error(), { code: 'BODY_SIZE_LIMIT' });
    return text;
  }
  async function load() {
    try {
      const response = await fetchImpl(TFEX_HOME_URL, { method: 'GET', redirect: 'manual', credentials: 'omit',
        headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; SETscope/1.0; TFEX public homepage)' },
        signal: AbortSignal.timeout(10000) });
      if ([401, 403, 429].includes(response.status)) {
        stoppedReason = response.status === 429 ? 'SOURCE_RATE_LIMIT_STOP' : 'MANUAL_REVIEW_REQUIRED';
        throw Object.assign(Error(), { code: stoppedReason });
      }
      if (response.status >= 300 && response.status < 400) throw Object.assign(Error(), { code: 'REDIRECT_NOT_FOLLOWED' });
      if (response.status !== 200) throw Object.assign(Error(), { code: 'SOURCE_HTTP_ERROR' });
      if (response.url && response.url !== TFEX_HOME_URL) throw Object.assign(Error(), { code: 'SOURCE_URL_MISMATCH' });
      if (!/^text\/html\b/i.test(response.headers?.get('content-type') || '')) throw Object.assign(Error(), { code: 'SOURCE_CONTENT_TYPE_MISMATCH' });
      const text = await readBody(response);
      if (explicitAccessDenial(text)) { stoppedReason = 'MANUAL_REVIEW_REQUIRED'; throw Object.assign(Error(), { code: stoppedReason }); }
      const parsed = parseTfexHome(text), diagnostics = parsed.__diagnostics;
      if (!parsed.available || diagnostics.result !== 'ACCEPT') throw Object.assign(Error(), { code: diagnostics.result });
      const record = { value: parsed, diagnostics, savedAt: now(), fetchedAt: new Date(now()).toISOString() };
      if (!sourceTimeValid(record)) throw Object.assign(Error(), { code: 'SOURCE_TIME_UNVERIFIED' });
      lastGood = record; freshUntil = now() + policy.ttlMs; lastFailure = null;
      return result('PASS', record);
    } catch (error) {
      lastFailure = typeof error.code === 'string' ? error.code
        : error.name === 'TimeoutError' ? 'ACQUISITION_TIMEOUT' : 'ACQUISITION_GAP';
      nextAttemptAt = now() + policy.errorBackoffMs;
      return failure(lastFailure);
    }
  }
  function getSnapshot() {
    if (!enabled) return Promise.resolve(result('UNAVAILABLE', null, 'SOURCE_DISABLED'));
    if (stoppedReason) return Promise.resolve(failure(stoppedReason));
    if (lastGood && now() < freshUntil && sourceTimeValid(lastGood)) return Promise.resolve(result('PASS', lastGood));
    if (now() < nextAttemptAt) return Promise.resolve(failure(lastFailure));
    if (pending) return pending;
    pending = load().finally(() => { pending = null; });
    return pending;
  }
  // Composite Overview cache hits must re-evaluate trust without a new fetch.
  function peekSnapshot() {
    if (!enabled) return result('UNAVAILABLE', null, 'SOURCE_DISABLED');
    if (stoppedReason) return failure(stoppedReason);
    if (lastGood && now() < freshUntil && sourceTimeValid(lastGood)) return result('PASS', lastGood);
    return failure(lastFailure || (lastGood && !sourceTimeValid(lastGood) ? 'SOURCE_TIME_UNVERIFIED' : 'CACHE_EXPIRED'));
  }
  return { getSnapshot, peekSnapshot, snapshot: () => ({ enabled, source: 'TFEX', sourceUrl: TFEX_HOME_URL,
    state: !enabled ? 'DISABLED' : stoppedReason ? 'MANUAL_REVIEW_REQUIRED' : 'ACTIVE',
    stopped: Boolean(stoppedReason), reason: stoppedReason }) };
}

module.exports = { createTfexHomeSource };
