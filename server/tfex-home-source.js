'use strict';

const { TFEX_HOME_URL, parseTfexHome } = require('./tfex-home-parser');
const { explicitAccessDenial } = require('./market-overview-safety');
const { PROVIDER_POLICIES } = require('./reliability');
const { bangkokDay, tradingDay } = require('./automation-policy');

const CLOSED_LKG_MS = 168 * 3600000;

function extendedRetentionAllowed(time) {
  if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) return false;
  const day = bangkokDay(time), todayTrading = tradingDay(day);
  if (todayTrading === null) return false;
  const local = new Date(time + 7 * 3600000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  // Protect the entire Day/Night envelope, including breaks and pre-open.
  // Calendar dates only govern LKG display; they do not verify the source session.
  if (minutes < 3 * 60) {
    const previousDay = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    if (tradingDay(previousDay) !== false) return false;
  }
  return !todayTrading || minutes < 7 * 60 + 50;
}

function createTfexHomeSource({ enabled = false, fetchImpl = globalThis.fetch, now = Date.now,
  policy = PROVIDER_POLICIES.settrade, maxSourceAgeMs = PROVIDER_POLICIES.settrade.staleIfErrorMs } = {}) {
  let lastGood = null, historical = null, pending = null, freshUntil = 0, nextAttemptAt = 0, stoppedReason = null, lastFailure = null;
  const empty = () => ({ available: false, delayMinutes: 15, totalVolume: null, openInterest: null,
    marketDate: '', investorType: [], topVolume: [] });
  function sourceTimeValid(record) {
    const time = Date.parse(record.diagnostics.reportedAsOf);
    return Number.isFinite(time) && now() >= record.savedAt && time <= now() && now() - time <= maxSourceAgeMs;
  }
  function withinSourceRetention(record, time) {
    // Receipts and cache reuse cannot extend the source timestamp's hard deadline.
    const sourceTime = Date.parse(record.diagnostics.reportedAsOf);
    return Number.isFinite(sourceTime) && time >= record.savedAt && sourceTime <= time
      && time - sourceTime <= CLOSED_LKG_MS;
  }
  function historicalTimeValid(record, time) {
    return extendedRetentionAllowed(time) && withinSourceRetention(record, time)
      && time - Date.parse(record.diagnostics.reportedAsOf) > maxSourceAgeMs;
  }
  function retainedRecord() {
    const time = now(), retentionMs = extendedRetentionAllowed(time) ? CLOSED_LKG_MS : policy.staleIfErrorMs;
    const good = lastGood && withinSourceRetention(lastGood, time)
      && time - lastGood.savedAt <= retentionMs ? lastGood : null;
    const old = historical && historicalTimeValid(historical, time) ? historical : null;
    if (!good) return old;
    if (!old) return good;
    const difference = Date.parse(old.diagnostics.reportedAsOf) - Date.parse(good.diagnostics.reportedAsOf);
    return difference > 0 || (difference === 0 && old.savedAt > good.savedAt) ? old : good;
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
    const record = retainedRecord();
    return record ? result('LKG', record, reason) : result('UNAVAILABLE', null, reason);
  }
  function cachedResult() {
    const record = retainedRecord();
    if (!record) return null;
    if (record === lastGood && now() < freshUntil && sourceTimeValid(record)) return result('PASS', record);
    if (record === historical && now() < record.cacheUntil) return result('LKG', record, 'SOURCE_TIME_UNVERIFIED');
    return null;
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
      const fresh = sourceTimeValid(record), retained = retainedRecord();
      if ((!fresh && !historicalTimeValid(record, now()))
        || (retained && Date.parse(diagnostics.reportedAsOf) < Date.parse(retained.diagnostics.reportedAsOf))) {
        throw Object.assign(Error(), { code: 'SOURCE_TIME_UNVERIFIED' });
      }
      if (fresh) { lastGood = record; freshUntil = now() + policy.ttlMs; }
      // Historical acquisition never renews a former-PASS record's ordinary LKG allowance.
      else { historical = record; historical.cacheUntil = now() + policy.ttlMs; }
      lastFailure = null;
      return result(fresh ? 'PASS' : 'LKG', record, fresh ? null : 'SOURCE_TIME_UNVERIFIED');
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
    const cached = cachedResult();
    if (cached) return Promise.resolve(cached);
    if (now() < nextAttemptAt) return Promise.resolve(failure(lastFailure));
    if (pending) return pending;
    pending = load().finally(() => { pending = null; });
    return pending;
  }
  // Composite Overview cache hits must re-evaluate trust without a new fetch.
  function peekSnapshot() {
    if (!enabled) return result('UNAVAILABLE', null, 'SOURCE_DISABLED');
    if (stoppedReason) return failure(stoppedReason);
    const cached = cachedResult();
    if (cached) return cached;
    const record = retainedRecord() || historical || lastGood;
    return failure(lastFailure || (record && !sourceTimeValid(record) ? 'SOURCE_TIME_UNVERIFIED' : 'CACHE_EXPIRED'));
  }
  return { getSnapshot, peekSnapshot, snapshot: () => ({ enabled, source: 'TFEX', sourceUrl: TFEX_HOME_URL,
    state: !enabled ? 'DISABLED' : stoppedReason ? 'MANUAL_REVIEW_REQUIRED' : 'ACTIVE',
    stopped: Boolean(stoppedReason), reason: stoppedReason }) };
}

module.exports = { createTfexHomeSource };
