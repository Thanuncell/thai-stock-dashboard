'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const { latestSession } = require('./automation-policy');
const { isTransientProviderError } = require('./reliability');
const { guardedDailyEvidence } = require('./screener-service');
const { completeForEligible } = require('./screener-snapshot-store');

const MAX_REQUESTS = 1100;
const BATCH_SIZE = 20;
const CONCURRENCY = 4;
const MIN_COOLDOWN = 15 * 60 * 1000;

function rateLimitUntil(value, now) {
  const until = /^\d+$/.test(value || '') ? now + Number(value) * 1000 : Date.parse(value);
  return Math.max(now + MIN_COOLDOWN, Number.isSafeInteger(until) && until <= 8.64e15 ? until : 0);
}

function createScreenerAcquisition({
  listCoverage, readDaily, store, now = Date.now, sleep = delay, requestTimeoutMs = 9000
}) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 9000)
    throw Error('SCREENER_INVALID_TIMEOUT');

  async function run({ maxRequests } = {}) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS)
      throw Error('SCREENER_EXPLICIT_REQUEST_BUDGET_REQUIRED');

    return store.withLease(async () => {
      const startedAt = now();
      const session = latestSession(startedAt);
      const outcome = { sessionDate: session, requests: 0, eligible: 0, ready: 0, published: false };
      if (!session) return { ...outcome, status: 'CALENDAR_UNAVAILABLE' };
      const cooldown = await store.readCooldown();
      if (cooldown > startedAt) return { ...outcome, status: 'COOLDOWN', cooldownUntil: new Date(cooldown).toISOString() };

      const { buildScreenerSnapshot, screenerEligible } = await import('../client/screener-core.mjs');
      const registry = await listCoverage();
      const context = { registry, sessionDate: session, latestCompletedSessionDate: session };
      // Validate the full mapping before the first provider request.
      buildScreenerSnapshot({ ...context, observedAt: startedAt });
      const eligible = registry.filter(screenerEligible);
      outcome.eligible = eligible.length;
      const evidenceBySymbol = new Map();
      let stopped = null, limitedUntil = 0;

      async function collect(row) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (stopped) return;
          if (latestSession(now()) !== session) { stopped = 'SESSION_CHANGED'; return; }
          if (outcome.requests >= maxRequests) { stopped = 'BUDGET_EXHAUSTED'; return; }
          outcome.requests++;
          const signal = AbortSignal.timeout(requestTimeoutMs);
          try {
            const { meta, result } = await readDaily(row.symbol, row.provider_symbol, { signal });
            signal.throwIfAborted();
            const evidence = guardedDailyEvidence(meta, result);
            if (evidence) evidenceBySymbol.set(row.symbol, evidence);
            return;
          } catch (error) {
            if (error.status === 429 || error.code === 'SOURCE_RATE_LIMITED') {
              limitedUntil = Math.max(limitedUntil, rateLimitUntil(error.retryAfter, now()));
              stopped = 'RATE_LIMITED';
              return;
            }
            if (error.stopBatch || [401, 403].includes(error.status) || error.accessDenied) {
              if (stopped !== 'RATE_LIMITED') stopped = 'PROVIDER_STOPPED';
              return;
            }
            if (attempt || !(signal.aborted || isTransientProviderError(error) || [500, 502, 503, 504].includes(error.status)))
              return;
            if (!stopped) await sleep(250);
          }
        }
      }

      for (let offset = 0; offset < eligible.length && !stopped; offset += BATCH_SIZE) {
        const batch = eligible.slice(offset, offset + BATCH_SIZE);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
          while (!stopped && next < batch.length) await collect(batch[next++]);
        }));
        if (!stopped && offset + BATCH_SIZE < eligible.length) await sleep(1000);
      }

      if (limitedUntil) await store.saveCooldown(limitedUntil);
      const observedAt = now();
      if (latestSession(observedAt) !== session)
        return { ...outcome, status: stopped || 'SESSION_CHANGED' };
      const candidate = buildScreenerSnapshot({ ...context, observedAt, evidenceBySymbol });
      outcome.ready = candidate.counts.ready;
      if (stopped || !completeForEligible(candidate)) return { ...outcome, status: stopped || 'INCOMPLETE' };
      const snapshot = { ...candidate, state: 'COMPLETE' };
      await store.publish(snapshot);
      return { ...outcome, status: 'PUBLISHED', published: true, snapshotId: snapshot.id };
    });
  }

  return { run };
}

module.exports = { createScreenerAcquisition };
