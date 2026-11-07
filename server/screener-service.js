'use strict';

const { latestSession, tradingDay } = require('./automation-policy');
const { createMemoryCache } = require('./reliability');

const DAY = 86400000;
const CACHE_POLICY = { ttlMs: 30000, staleIfErrorMs: 0, errorBackoffMs: 10000 };

function nextSessionBoundary(session, now) {
  if (!session) return now + CACHE_POLICY.ttlMs;
  const midnight = Date.parse(session + 'T00:00:00Z');
  for (let offset = 1; offset <= 10; offset++) {
    const next = midnight + offset * DAY;
    const trading = tradingDay(new Date(next).toISOString().slice(0, 10));
    if (trading === null) break;
    if (trading) return next + (10 * 60 + 15) * 60000;
  }
  return now + CACHE_POLICY.ttlMs;
}

function createScreenerService({ listCoverage, now = Date.now } = {}) {
  const evidence = new Map();
  const cache = createMemoryCache({ maxEntries: 2, now });

  function rememberDailyHistory(symbol, meta, result) {
    if (meta.dataGranularity !== '1d' || meta.exchangeTimezoneName !== 'Asia/Bangkok'
      || result.fallbackFromLastKnown || result.identityStatus !== 'accepted'
      || result.history.length > 300) return;
    const sourceFetchedAt = result.provenance.receivedAt;
    const last = evidence.get(symbol);
    if (!Number.isFinite(Date.parse(sourceFetchedAt))
      || last && Date.parse(last.sourceFetchedAt) > Date.parse(sourceFetchedAt)) return;
    evidence.delete(symbol);
    evidence.set(symbol, {
      provider: result.provenance.provider,
      providerSymbol: meta.symbol,
      interval: result.provenance.interval,
      identityStatus: result.identityStatus,
      guardStatus: result.guardStatus,
      historyStatus: result.historyStatus,
      dataState: result.dataState,
      guardReasons: result.rejectedBars ? [...result.guardReasons, 'REJECTED_DAILY_BARS'] : result.guardReasons,
      sourceFetchedAt,
      bars: result.history
    });
    if (evidence.size > 1000) evidence.delete(evidence.keys().next().value);
  }

  async function readSnapshot() {
    const startedAt = now();
    const session = latestSession(startedAt);
    const validUntil = new Date(nextSessionBoundary(session, startedAt)).toISOString();
    if (!session) return { snapshot: null, latestCompletedSessionDate: null, validUntil, marketFreshness: 'UNAVAILABLE' };
    const { value } = await cache.get(session, CACHE_POLICY, async () => {
      const registry = await listCoverage();
      if (!registry) return null;
      const { buildScreenerSnapshot } = await import('../client/screener-core.mjs');
      const observedAt = now();
      if (latestSession(observedAt) !== session) return null;
      return buildScreenerSnapshot({
        registry, evidenceBySymbol: evidence, sessionDate: session,
        latestCompletedSessionDate: session, observedAt
      });
    });
    const current = now();
    const latest = latestSession(current);
    if (latest !== session) return {
      snapshot: null, latestCompletedSessionDate: latest,
      validUntil: new Date(nextSessionBoundary(latest, current)).toISOString(), marketFreshness: 'UNAVAILABLE'
    };
    return {
      snapshot: value,
      latestCompletedSessionDate: session,
      validUntil,
      marketFreshness: value?.counts.ready ? 'CURRENT_SESSION' : value?.counts.staleSession ? 'STALE' : 'UNAVAILABLE'
    };
  }

  return { rememberDailyHistory, readSnapshot };
}

module.exports = { createScreenerService };
