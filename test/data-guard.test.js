'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMarketDataGuard } = require('../server/data-guard');

const NOW = Date.UTC(2026, 9, 18, 9);

function yahooResult(overrides = {}) {
  return {
    meta: {
      symbol: 'PTT.BK',
      currency: 'THB',
      exchangeName: 'SET',
      fullExchangeName: 'Thailand',
      marketState: 'CLOSED',
      regularMarketPrice: 35.25,
      chartPreviousClose: 35,
      regularMarketTime: Math.floor((NOW - 15 * 60 * 1000) / 1000),
      ...overrides.meta
    },
    timestamp: overrides.timestamp || [1_760_000_000, 1_760_086_400],
    indicators: overrides.indicators || { quote: [{
      open: [35, 35.1], high: [35.5, 35.6], low: [34.75, 34.9], close: [35.25, 35.4], volume: [1000, 1200]
    }] }
  };
}

test('wrong-symbol and wrong-market payloads are quarantined before trust', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const wrongSymbol = guard.assess(yahooResult({ meta: { symbol: 'AOT.BK' } }), 'PTT');
  assert.equal(wrongSymbol.value, null);
  assert.equal(wrongSymbol.guardStatus, 'quarantined');
  assert.ok(wrongSymbol.guardReasons.includes('SYMBOL_MISMATCH'));

  const wrongMarket = guard.assess(yahooResult({ meta: { exchangeName: 'NASDAQ', currency: 'USD' } }), 'PTT');
  assert.equal(wrongMarket.value, null);
  assert.ok(wrongMarket.guardReasons.includes('MARKET_MISMATCH'));
});

test('invalid historical rows are rejected without tainting a majority-valid quote', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const result = guard.assess(yahooResult({
    timestamp: [1_760_000_000, 1_760_086_400, 1_760_172_800, Math.floor((NOW + 60 * 60 * 1000) / 1000), 1_760_086_400],
    indicators: { quote: [{
      open: [35, 35, 50, 35, 35],
      high: [35.5, 35.5, 40, 35.5, 35.5],
      low: [34.75, 34.75, 45, 34.75, 34.75],
      close: [35.25, Number.POSITIVE_INFINITY, 46, 35.25, 35.25],
      volume: [1000, -1, 1000, 1000, 1000]
    }] }
  }), 'PTT');

  assert.equal(result.guardStatus, 'accepted');
  assert.equal(result.value.identityStatus, 'accepted');
  assert.equal(result.value.quoteStatus, 'accepted');
  assert.equal(result.value.historyStatus, 'insufficient');
  assert.equal(result.value.rejectedBars, 4);
  assert.equal(result.value.history.length, 1);
  assert.ok(result.value.historyReasons.includes('INVALID_OHLC'));
  assert.ok(result.value.historyReasons.includes('FUTURE_TIMESTAMP'));
  assert.ok(result.value.historyReasons.includes('DUPLICATE_TIMESTAMP'));
  assert.ok(!result.guardReasons.includes('INVALID_OHLC'));
  assert.ok(result.value.history.every(bar => Number.isFinite(bar.close) && bar.high >= bar.low));
});

test('majority-valid history remains usable with warnings and retains rejected-bar evidence', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const result = guard.assess(yahooResult({
    timestamp: [1_760_000_000, 1_760_086_400, 1_760_172_800],
    indicators: { quote: [{
      open: [35, null, 35.2], high: [35.5, null, 35.7], low: [34.75, null, 35], close: [35.25, null, 35.4], volume: [1000, null, 1200]
    }] }
  }), 'PTT');
  assert.equal(result.guardStatus, 'accepted');
  assert.equal(result.value.historyStatus, 'usable_with_warnings');
  assert.equal(result.value.rejectedBars, 1);
  assert.equal(result.value.history.length, 2);
  assert.deepEqual(result.value.historyReasons, ['INVALID_NUMERIC']);
});

test('an isolated historical price spike is quarantined before chart and Technical Analysis use', () => {
  const guard = createMarketDataGuard({ now: () => NOW, maxPriceMoveRatio: 0.35 });
  const result = guard.assess(yahooResult({
    timestamp: [1_760_000_000, 1_760_086_400, 1_760_172_800],
    indicators: { quote: [{
      open: [35, 99, 35.1], high: [35.5, 101, 35.6], low: [34.75, 98, 34.9], close: [35.25, 100, 35.4], volume: [1000, 1000, 1200]
    }] }
  }), 'PTT');
  assert.equal(result.guardStatus, 'accepted');
  assert.equal(result.value.historyStatus, 'usable_with_warnings');
  assert.equal(result.value.rejectedBars, 1);
  assert.deepEqual(result.value.history.map(bar => bar.close), [35.25, 35.4]);
  assert.ok(result.value.historyReasons.includes('HISTORICAL_ANOMALY'));
});

test('anomaly quarantine preserves last-known-good as explicitly stale', () => {
  const guard = createMarketDataGuard({ now: () => NOW, maxPriceMoveRatio: 0.35 });
  const accepted = guard.assess(yahooResult(), 'PTT');
  assert.equal(accepted.guardStatus, 'accepted');
  assert.equal(accepted.value.last, 35.25);

  const anomaly = guard.assess(yahooResult({ meta: { regularMarketPrice: 80 } }), 'PTT');
  assert.equal(anomaly.guardStatus, 'quarantined');
  assert.ok(anomaly.guardReasons.includes('DATA_ANOMALY'));
  assert.equal(anomaly.value.last, 35.25);
  assert.equal(anomaly.value.dataState, 'stale');
  assert.equal(anomaly.value.stale, true);
  assert.equal(anomaly.value.fallbackFromLastKnown, true);
  assert.equal(anomaly.value.time, accepted.value.time);
  assert.equal(anomaly.value.asOf, accepted.value.asOf);
  assert.equal(anomaly.value.lastValidAt, accepted.value.lastValidAt);
  assert.ok(anomaly.value.lastCheckedAt);
  assert.equal(anomaly.value.anomalyCount, 1);
});

test('out-of-order bars are normalized and price/change mismatches are quarantined without correction', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const normalized = guard.assess(yahooResult({
    timestamp: [1_760_086_400, 1_760_000_000],
    indicators: { quote: [{
      open: [35.1, 35], high: [35.6, 35.5], low: [34.9, 34.75], close: [35.4, 35.25], volume: [1200, 1000]
    }] }
  }), 'PTT');
  assert.equal(normalized.guardStatus, 'accepted');
  assert.deepEqual(normalized.value.history.map(bar => bar.time), [1_760_000_000_000, 1_760_086_400_000]);

  const mismatch = guard.assess(yahooResult({ meta: {
    regularMarketChange: 3,
    regularMarketChangePercent: 9
  } }), 'PTT');
  assert.equal(mismatch.guardStatus, 'quarantined');
  assert.ok(mismatch.guardReasons.includes('PRICE_CHANGE_MISMATCH'));
  assert.equal(mismatch.value.last, normalized.value.last);
  assert.equal(mismatch.value.stale, true);
});

test('range-start chartPreviousClose cannot cause a false price-change quarantine', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const day = 24 * 60 * 60;
  const latest = Math.floor((NOW - 2 * 60 * 60 * 1000) / 1000);
  const result = guard.assess(yahooResult({
    timestamp: [latest - day, latest],
    indicators: { quote: [{
      open: [40.5, 40.75], high: [41, 41.25], low: [40.25, 40.5], close: [40.75, 41], volume: [1000, 1200]
    }] },
    meta: {
      regularMarketPrice: 41,
      chartPreviousClose: 42.5,
      regularMarketChange: 0.25,
      regularMarketChangePercent: 0.613
    }
  }), 'PTT');

  assert.equal(result.guardStatus, 'accepted');
  assert.equal(result.value.prior, 40.75);
  assert.ok(!result.guardReasons.includes('PRICE_CHANGE_MISMATCH'));
});

test('newer validated chart history supersedes stale quote metadata', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const day = 24 * 60 * 60;
  const latest = Math.floor((NOW - 2 * 60 * 60 * 1000) / 1000);
  const result = guard.assess(yahooResult({
    timestamp: [latest - day, latest],
    indicators: { quote: [{
      open: [9.8, 9.7], high: [10, 9.8], low: [9.7, 9.6], close: [9.75, 9.65], volume: [1000, 1200]
    }] },
    meta: {
      regularMarketPrice: 9.95,
      chartPreviousClose: 9.95,
      regularMarketTime: latest - 10 * day,
      regularMarketChange: 0,
      regularMarketChangePercent: 0
    }
  }), 'PTT');

  assert.equal(result.guardStatus, 'accepted');
  assert.equal(result.value.last, 9.65);
  assert.equal(result.value.prior, 9.75);
  assert.equal(result.value.time, latest * 1000);
  assert.ok(!result.guardReasons.includes('LAST_CLOSE_MISMATCH'));
  assert.ok(!result.guardReasons.includes('PRICE_CHANGE_MISMATCH'));
});

test('stale or future provider time cannot masquerade as fresh', () => {
  const guard = createMarketDataGuard({ now: () => NOW, regularMarketStaleMs: 60 * 60 * 1000 });
  const stale = guard.assess(yahooResult({ meta: {
    marketState: 'REGULAR',
    regularMarketTime: Math.floor((NOW - 2 * 60 * 60 * 1000) / 1000)
  } }), 'PTT');
  assert.equal(stale.value.dataState, 'stale');
  assert.ok(stale.guardReasons.includes('STALE_TIMESTAMP'));

  const future = guard.assess(yahooResult({ meta: {
    regularMarketTime: Math.floor((NOW + 60 * 60 * 1000) / 1000)
  } }), 'PTT');
  assert.equal(future.value, null);
  assert.equal(future.guardStatus, 'quarantined');
  assert.ok(future.guardReasons.includes('FUTURE_TIMESTAMP'));
});

test('last-known-good fallback is bounded by TTL and isolated by chart context', () => {
  let now = NOW;
  const guard = createMarketDataGuard({ now: () => now, lastKnownGoodTtlMs: 60 * 60 * 1000 });
  const accepted = guard.assess(yahooResult(), 'PTT', { contextKey: 'chart:1d:5m' });
  assert.equal(accepted.guardStatus, 'accepted');

  const wrongRange = guard.assess(yahooResult({ meta: { regularMarketPrice: 80 } }), 'PTT', { contextKey: 'chart:1y:1d' });
  assert.equal(wrongRange.value, null);
  assert.equal(wrongRange.fallbackFromLastKnown, false);

  now += 2 * 60 * 60 * 1000;
  const expired = guard.assess(yahooResult({ meta: { regularMarketPrice: 80 } }), 'PTT', { contextKey: 'chart:1d:5m' });
  assert.equal(expired.value, null);
  assert.equal(expired.fallbackFromLastKnown, false);
});

test('invalid quote metadata is not promoted to accepted or converted to zero', () => {
  const guard = createMarketDataGuard({ now: () => NOW });
  const result = guard.assess(yahooResult({ meta: {
    regularMarketDayHigh: Number.POSITIVE_INFINITY,
    regularMarketDayLow: -1,
    regularMarketVolume: -5,
    regularMarketChange: Number.NaN,
    regularMarketChangePercent: Number.POSITIVE_INFINITY
  } }), 'PTT');
  assert.equal(result.guardStatus, 'suspect');
  assert.ok(result.guardReasons.includes('INVALID_NUMERIC'));
  assert.ok(result.guardReasons.includes('NEGATIVE_VOLUME'));
  assert.equal(result.value.high, null);
  assert.equal(result.value.low, null);
  assert.equal(result.value.volume, null);
});
