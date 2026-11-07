'use strict';

const { latestSession, tradingDay } = require('./automation-policy');
const { createMemoryCache } = require('./reliability');
const { completeForEligible } = require('./screener-snapshot-store');
const { guardedDailyEvidence, chartHistoryToRecords, historyEvidence } = require('./daily-ohlcv');

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

function createScreenerService({ listCoverage = async () => null, snapshotStore, dailyHistoryStore, now = Date.now } = {}) {
  const evidence = new Map();
  const chartSources = new Map();
  const cache = createMemoryCache({ maxEntries: 2, now });
  let chartRevision = 0;

  function rememberDailyHistory(symbol, meta, result) {
    const next = guardedDailyEvidence(meta, result);
    const last = evidence.get(symbol);
    if (!next || last && Date.parse(last.sourceFetchedAt) > Date.parse(next.sourceFetchedAt)) return;
    evidence.delete(symbol);
    evidence.set(symbol, next);
    chartSources.set(symbol, { meta, result });
    if (evidence.size > 1000) {
      const oldest = evidence.keys().next().value;
      evidence.delete(oldest);
      chartSources.delete(oldest);
    }
    chartRevision++;
  }

  async function backfillExistingHistory() {
    if (!dailyHistoryStore) throw Error('DAILY_HISTORY_STORE_UNAVAILABLE');
    let changed = 0, rejected = 0;
    for (const [symbol, source] of chartSources) {
      let records;
      try { records = chartHistoryToRecords(symbol, source.meta, source.result); }
      catch (_) { rejected++; continue; }
      changed += (await dailyHistoryStore.upsert(records)).changed;
    }
    return { changed, rejected };
  }

  async function buildReusedSnapshot(registry, session, observedAt, reader) {
    const { buildScreenerSnapshot, buildDailyScreenerRow } = await import('../client/screener-core.mjs');
    const reused = new Map();
    const sources = { published: 0, storedHistory: 0, chartHistory: 0, unavailable: 0 };
    for (let offset = 0; offset < registry.length; offset += 20) {
      const batch = registry.slice(offset, offset + 20);
      const stored = reader ? await reader.readMany(batch.map(row => row.symbol), { asOf: observedAt }) : null;
      for (const row of batch) {
        let saved = null;
        const records = stored?.histories.get(row.symbol) || [];
        let blocked = stored?.guardBlocked.has(row.symbol);
        if (records.length) {
          try { saved = historyEvidence(records, row.symbol, observedAt); }
          catch (_) { blocked = true; }
        }
        const chart = evidence.get(row.symbol);
        const candidates = [saved, chart].filter(Boolean);
        let selected = candidates.length === 1 ? candidates[0] : null;
        for (const item of candidates.length > 1 ? candidates : []) {
          const result = buildDailyScreenerRow(row, item, { sessionDate: session, observedAt });
          if (result.state === 'READY') {
            selected ||= item;
            if (['ema20', 'ema50', 'rsi14', 'macd'].every(key => result.available[key])) { selected = item; break; }
          }
        }
        selected ||= saved || chart;
        if (!selected && blocked) selected = {
          provider: row.provider, providerSymbol: row.provider_symbol, interval: '1d', identityStatus: 'accepted',
          guardStatus: 'suspect', historyStatus: 'blocked', dataState: 'suspect', guardReasons: ['STORED_HISTORY_INVALID'], bars: []
        };
        if (selected) reused.set(row.symbol, selected);
        if (selected === saved && saved) sources.storedHistory++;
        else if (selected === chart && chart) sources.chartHistory++;
        else sources.unavailable++;
      }
    }
    return {
      snapshot: buildScreenerSnapshot({ registry, evidenceBySymbol: reused, sessionDate: session,
        latestCompletedSessionDate: session, observedAt }),
      sources
    };
  }

  async function readSnapshot() {
    const startedAt = now();
    const session = latestSession(startedAt);
    const validUntil = new Date(nextSessionBoundary(session, startedAt)).toISOString();
    if (!session) return { snapshot: null, latestCompletedSessionDate: null, validUntil,
      marketFreshness: 'UNAVAILABLE', availability: null };
    const revision = snapshotStore?.revision ? await snapshotStore.revision() : '';
    let historyRevision = '', historyUnavailable = false;
    try { historyRevision = dailyHistoryStore?.revision ? await dailyHistoryStore.revision() : ''; }
    catch (_) { historyRevision = 'unavailable'; historyUnavailable = true; }
    const key = [session, revision, historyRevision, chartRevision].join('|');
    const { value: loaded } = await cache.get(key, CACHE_POLICY, async () => {
      const published = snapshotStore ? (await snapshotStore.readPublished()).snapshot : null;
      if (published?.sessionDate === session && Date.parse(published.generatedAt) <= startedAt && completeForEligible(published))
        return { snapshot: published, sources: { published: published.counts.ready, storedHistory: 0, chartHistory: 0, unavailable: 0 } };
      const registry = await listCoverage();
      if (!registry) return { snapshot: published, sources: null };
      const observedAt = now();
      if (latestSession(observedAt) !== session) return { snapshot: null, sources: null };
      if (dailyHistoryStore && !historyUnavailable) {
        try { return await dailyHistoryStore.withReadLease(reader => buildReusedSnapshot(registry, session, observedAt, reader)); }
        catch (_) { historyUnavailable = true; }
      }
      const fallback = await buildReusedSnapshot(registry, session, observedAt, null);
      if (historyUnavailable) fallback.sources.historyUnavailable = true;
      return fallback;
    });
    const value = loaded.snapshot;
    const current = now();
    const latest = latestSession(current);
    if (latest !== session) return {
      snapshot: null, latestCompletedSessionDate: latest,
      validUntil: new Date(nextSessionBoundary(latest, current)).toISOString(),
      marketFreshness: 'UNAVAILABLE', availability: null
    };
    const usable = value && value.sessionDate === session && Date.parse(value.generatedAt) <= current;
    const ready = usable && completeForEligible(value);
    // Safe Partial is read-only: existing Chart evidence may screen READY rows,
    // but a partial candidate is never published to a durable snapshot store.
    const partialReady = usable && value.state === 'PARTIAL' && value.counts.ready > 0
      && value.rows.some(row => row.state === 'READY');
    const stale = value && (value.sessionDate < session || value.counts.staleSession > 0);
    return {
      snapshot: ready || partialReady ? value : null,
      latestCompletedSessionDate: session,
      validUntil,
      marketFreshness: ready || partialReady ? 'CURRENT_SESSION' : stale ? 'STALE' : 'UNAVAILABLE',
      availability: usable ? value.counts : null,
      reuseSources: loaded.sources
    };
  }

  return { rememberDailyHistory, readSnapshot, backfillExistingHistory };
}

module.exports = { createScreenerService, guardedDailyEvidence };
