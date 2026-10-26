'use strict';

const { normalizeSymbol } = require('../lib/validation');

const DEFAULT_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;
const DEFAULT_REGULAR_MARKET_STALE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PRICE_MOVE_RATIO = 0.35;
const DEFAULT_LAST_KNOWN_GOOD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LAST_CLOSE_MISMATCH_RATIO = 0.02;
const MAX_LAST_KNOWN = 500;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const bangkokDateKey = value => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value));

function previousSessionClose(history = []) {
  const latest = history.at(-1);
  if (!latest?.time) return null;
  const latestDate = bangkokDateKey(latest.time);
  for (let index = history.length - 2; index >= 0; index -= 1) {
    const bar = history[index];
    if (bar?.time && bangkokDateKey(bar.time) !== latestDate) return finiteNumber(bar.close);
  }
  return null;
}

function expectedProviderSymbol(symbol) {
  const canonical = normalizeSymbol(symbol);
  return canonical === 'SET' ? '^SET.BK' : `${canonical}.BK`;
}

function normalizeProviderSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function validMarket(meta = {}) {
  const currency = String(meta.currency || '').trim().toUpperCase();
  const market = `${meta.exchangeName || ''} ${meta.fullExchangeName || ''}`.trim();
  if (currency && currency !== 'THB') return false;
  return !market || /(?:SET|Thailand|BKK)/i.test(market);
}

function normalizeHistory(result, { now, futureToleranceMs, maxPriceMoveRatio = DEFAULT_MAX_PRICE_MOVE_RATIO }) {
  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const candidates = [];
  const reasons = new Set();
  const seen = new Set();
  const duplicates = new Set();

  timestamps.forEach((rawTime, index) => {
    const seconds = finiteNumber(rawTime);
    const time = seconds === null ? null : seconds * 1000;
    if (time === null || time <= 0) {
      reasons.add('INVALID_TIMESTAMP');
      return;
    }
    if (time > now + futureToleranceMs) {
      reasons.add('FUTURE_TIMESTAMP');
      return;
    }
    if (seen.has(time)) {
      reasons.add('DUPLICATE_TIMESTAMP');
      duplicates.add(time);
      return;
    }
    seen.add(time);

    const open = finiteNumber(quote.open?.[index]);
    const high = finiteNumber(quote.high?.[index]);
    const low = finiteNumber(quote.low?.[index]);
    const close = finiteNumber(quote.close?.[index]);
    const volumeValue = quote.volume?.[index];
    const volume = finiteNumber(volumeValue);
    if ([open, high, low, close].some(value => value === null || value <= 0)) {
      reasons.add('INVALID_NUMERIC');
      return;
    }
    if (high < low || open < low || open > high || close < low || close > high) {
      reasons.add('INVALID_OHLC');
      return;
    }
    if (volumeValue !== null && volumeValue !== undefined && volumeValue !== '' && (volume === null || volume < 0)) {
      reasons.add(volume !== null && volume < 0 ? 'NEGATIVE_VOLUME' : 'INVALID_NUMERIC');
      return;
    }
    candidates.push({ time, open, high, low, close, volume });
  });

  const ordered = candidates.filter(bar => !duplicates.has(bar.time)).sort((left, right) => left.time - right.time);
  const history = ordered.filter((bar, index) => {
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    if (!previous || !next) return true;
    const jumpFromPrevious = Math.abs(bar.close - previous.close) / previous.close;
    const jumpToNext = Math.abs(bar.close - next.close) / next.close;
    const neighborsAgree = Math.abs(previous.close - next.close) / previous.close <= 0.1;
    if (jumpFromPrevious > maxPriceMoveRatio && jumpToNext > maxPriceMoveRatio && neighborsAgree) {
      reasons.add('HISTORICAL_ANOMALY');
    }
    return true;
  });
  return { history, reasons: [...reasons], rejectedBars: Math.max(0, timestamps.length - history.length) };
}

function createMarketDataGuard({
  now = Date.now,
  futureToleranceMs = DEFAULT_FUTURE_TOLERANCE_MS,
  regularMarketStaleMs = DEFAULT_REGULAR_MARKET_STALE_MS,
  maxPriceMoveRatio = DEFAULT_MAX_PRICE_MOVE_RATIO,
  lastKnownGoodTtlMs = DEFAULT_LAST_KNOWN_GOOD_TTL_MS,
  lastCloseMismatchRatio = DEFAULT_LAST_CLOSE_MISMATCH_RATIO,
  maxLastKnown = MAX_LAST_KNOWN
} = {}) {
  const lastKnownGood = new Map();

  function remember(symbol, value) {
    lastKnownGood.delete(symbol);
    lastKnownGood.set(symbol, value);
    while (lastKnownGood.size > maxLastKnown) lastKnownGood.delete(lastKnownGood.keys().next().value);
  }

  function fallback(key, guardReasons, checkedAt, timestamp) {
    const previous = lastKnownGood.get(key);
    if (!previous) return null;
    const lastValidTime = Date.parse(previous.lastValidAt || previous.receivedAt || '');
    if (!Number.isFinite(lastValidTime) || timestamp - lastValidTime > lastKnownGoodTtlMs) {
      lastKnownGood.delete(key);
      return null;
    }
    return {
      ...previous,
      history: previous.history.map(bar => ({ ...bar })),
      validatedHistory: previous.history.map(bar => ({ ...bar })),
      stale: true,
      dataState: 'stale',
      guardStatus: 'quarantined',
      quoteStatus: 'quarantined',
      historyStatus: 'blocked',
      identityStatus: 'quarantined',
      guardReasons,
      lastCheckedAt: checkedAt,
      anomalyCount: Number(previous.anomalyCount || 0) + 1,
      fallbackFromLastKnown: true
    };
  }

  function assess(result, requestedSymbol, { contextKey = 'default', providerSymbol: mappedProviderSymbol } = {}) {
    const symbol = normalizeSymbol(requestedSymbol);
    const storageKey = `${symbol}|${mappedProviderSymbol || expectedProviderSymbol(symbol)}|${String(contextKey || 'default')}`;
    const timestamp = Number(now());
    const checkedAt = new Date(timestamp).toISOString();
    const reasons = new Set();
    const meta = result?.meta || {};
    const providerSymbol = normalizeProviderSymbol(meta.symbol);
    const expectedSymbol = mappedProviderSymbol || expectedProviderSymbol(symbol);
    if (!providerSymbol) reasons.add('SYMBOL_UNVERIFIED');
    else if (providerSymbol !== expectedSymbol) reasons.add('SYMBOL_MISMATCH');
    if (!validMarket(meta)) reasons.add('MARKET_MISMATCH');

    const normalized = normalizeHistory(result, { now: timestamp, futureToleranceMs, maxPriceMoveRatio });
    const latestBar = normalized.history.at(-1);
    const rawProviderTime = meta.regularMarketTime;
    const providerTime = finiteNumber(rawProviderTime);
    if (rawProviderTime !== null && rawProviderTime !== undefined && rawProviderTime !== '' && (providerTime === null || providerTime <= 0)) {
      reasons.add('INVALID_TIMESTAMP');
    }
    const providerTimeMs = providerTime && providerTime > 0 ? providerTime * 1000 : null;
    const quoteMetaOlderThanHistory = Boolean(providerTimeMs && latestBar?.time && providerTimeMs < latestBar.time);
    const rawLast = meta.regularMarketPrice;
    const metaLast = finiteNumber(rawLast);
    const invalidLast = rawLast !== null && rawLast !== undefined && rawLast !== '' && (metaLast === null || metaLast <= 0);
    if (invalidLast) reasons.add('INVALID_NUMERIC');
    const last = invalidLast ? null : quoteMetaOlderThanHistory
      ? latestBar?.close ?? null
      : metaLast && metaLast > 0 ? metaLast : latestBar?.close ?? null;
    const historyMatchesQuoteSession = quoteMetaOlderThanHistory || !providerTimeMs
      || latestBar?.time && bangkokDateKey(latestBar.time) === bangkokDateKey(providerTimeMs);
    const sessionPrior = historyMatchesQuoteSession ? previousSessionClose(normalized.history) : null;
    // For multi-day ranges chartPreviousClose is the range-start reference, not yesterday's close.
    const rawPrior = meta.previousClose ?? meta.regularMarketPreviousClose ?? sessionPrior
      ?? (meta.range === '1d' ? meta.chartPreviousClose : null);
    const metaPrior = finiteNumber(rawPrior);
    if (rawPrior !== null && rawPrior !== undefined && rawPrior !== '' && (metaPrior === null || metaPrior <= 0)) reasons.add('INVALID_NUMERIC');
    const prior = metaPrior && metaPrior > 0 ? metaPrior : null;
    const time = quoteMetaOlderThanHistory ? latestBar?.time ?? null : providerTimeMs ?? latestBar?.time ?? null;
    const providerTimeFuture = Boolean(time && time > timestamp + futureToleranceMs);
    if (providerTimeFuture) reasons.add('FUTURE_TIMESTAMP');
    if (time && String(meta.marketState || '').toUpperCase() === 'REGULAR' && timestamp - time > regularMarketStaleMs) {
      reasons.add('STALE_TIMESTAMP');
    }

    const rawChange = quoteMetaOlderThanHistory ? null : meta.regularMarketChange;
    const rawChangePercent = quoteMetaOlderThanHistory ? null : meta.regularMarketChangePercent;
    const change = finiteNumber(rawChange);
    const changePercent = finiteNumber(rawChangePercent);
    if (rawChange !== null && rawChange !== undefined && rawChange !== '' && change === null) reasons.add('INVALID_NUMERIC');
    if (rawChangePercent !== null && rawChangePercent !== undefined && rawChangePercent !== '' && changePercent === null) reasons.add('INVALID_NUMERIC');
    if (last !== null && latestBar?.close > 0 && Math.abs(last - latestBar.close) / latestBar.close > lastCloseMismatchRatio) {
      reasons.add('LAST_CLOSE_MISMATCH');
    }
    if (last !== null && prior !== null) {
      const impliedChange = last - prior;
      const impliedPercent = prior === 0 ? null : impliedChange / prior * 100;
      if (change !== null && Math.abs(change - impliedChange) > Math.max(0.02, Math.abs(last) * 0.001)) reasons.add('PRICE_CHANGE_MISMATCH');
      if (changePercent !== null && impliedPercent !== null && Math.abs(changePercent - impliedPercent) > 0.15) reasons.add('PRICE_CHANGE_MISMATCH');
    } else if (last !== null && change !== null && changePercent !== null) {
      const impliedBase = last - change;
      if (impliedBase <= 0 || Math.abs(change / impliedBase * 100 - changePercent) > 0.15) reasons.add('PRICE_CHANGE_MISMATCH');
    }

    const rawHigh = meta.regularMarketDayHigh;
    const rawLow = meta.regularMarketDayLow;
    const rawVolume = meta.regularMarketVolume;
    let high = finiteNumber(rawHigh);
    let low = finiteNumber(rawLow);
    let volume = finiteNumber(rawVolume);
    if (rawHigh !== null && rawHigh !== undefined && rawHigh !== '' && (high === null || high <= 0)) reasons.add('INVALID_NUMERIC');
    if (rawLow !== null && rawLow !== undefined && rawLow !== '' && (low === null || low <= 0)) reasons.add('INVALID_NUMERIC');
    if (rawVolume !== null && rawVolume !== undefined && rawVolume !== '' && (volume === null || volume < 0)) {
      reasons.add(volume !== null && volume < 0 ? 'NEGATIVE_VOLUME' : 'INVALID_NUMERIC');
    }
    if (high !== null && low !== null && high < low) {
      reasons.add('INVALID_OHLC');
      high = null;
      low = null;
    }
    if (!(high > 0)) high = null;
    if (!(low > 0)) low = null;
    if (!(volume >= 0)) volume = null;

    const previous = lastKnownGood.get(storageKey);
    if (previous?.last > 0 && last > 0 && Math.abs(last - previous.last) / previous.last > maxPriceMoveRatio) reasons.add('DATA_ANOMALY');

    const guardReasons = [...reasons];
    if (normalized.reasons.includes('HISTORICAL_ANOMALY')) guardReasons.push('HISTORICAL_ANOMALY');
    const identityStatus = guardReasons.some(reason => ['SYMBOL_MISMATCH', 'MARKET_MISMATCH'].includes(reason))
      ? 'quarantined' : providerSymbol ? 'accepted' : 'unverified';
    const historyStatus = identityStatus === 'quarantined'
      ? 'blocked'
      : normalized.history.length === 0
        ? 'insufficient'
        : normalized.rejectedBars === 0 && normalized.reasons.length === 0
          ? 'usable'
          : normalized.history.length >= normalized.rejectedBars
            ? 'usable_with_warnings'
            : 'insufficient';
    const critical = providerTimeFuture || guardReasons.some(reason => [
      'SYMBOL_MISMATCH', 'MARKET_MISMATCH', 'INVALID_TIMESTAMP'
    ].includes(reason));
    if (critical || last === null && normalized.history.length === 0) {
      const value = fallback(storageKey, guardReasons, checkedAt, timestamp);
      return {
        value,
        guardStatus: 'quarantined',
        guardReasons,
        lastCheckedAt: checkedAt,
        anomalyCount: value?.anomalyCount || 1,
        fallbackFromLastKnown: Boolean(value)
      };
    }

    const stale = reasons.has('STALE_TIMESTAMP');
    const suspect = guardReasons.length > 0;
    const guardStatus = stale ? 'stale' : suspect ? 'suspect' : 'accepted';
    const value = {
      symbol,
      last,
      prior,
      time,
      fullName: meta.longName || meta.shortName || symbol,
      currency: meta.currency || 'THB',
      high,
      low,
      volume,
      exchange: meta.fullExchangeName || meta.exchangeName || 'SET',
      marketState: meta.marketState || 'UNKNOWN',
      provider: 'Yahoo Finance',
      source: 'Yahoo Finance',
      asOf: time ? new Date(time).toISOString() : null,
      receivedAt: checkedAt,
      lastValidAt: guardStatus === 'accepted' ? checkedAt : previous?.lastValidAt || null,
      lastCheckedAt: checkedAt,
      anomalyCount: Number(previous?.anomalyCount || 0),
      history: normalized.history,
      validatedHistory: normalized.history,
      rejectedBars: normalized.rejectedBars,
      historyReasons: normalized.reasons,
      historyStatus,
      identityStatus,
      stale,
      dataState: stale ? 'stale' : last === null ? 'partial' : suspect ? 'suspect' : 'delayed',
      guardStatus,
      quoteStatus: last === null ? 'quarantined' : guardStatus,
      guardReasons,
      fallbackFromLastKnown: false
    };
    if (guardStatus === 'accepted') remember(storageKey, { ...value, history: value.history.map(bar => ({ ...bar })) });
    return { value, guardStatus, guardReasons, lastCheckedAt: checkedAt, anomalyCount: value.anomalyCount, fallbackFromLastKnown: false };
  }

  return {
    assess,
    lastKnownSize() { return lastKnownGood.size; }
  };
}

module.exports = {
  DEFAULT_FUTURE_TOLERANCE_MS,
  DEFAULT_LAST_CLOSE_MISMATCH_RATIO,
  DEFAULT_LAST_KNOWN_GOOD_TTL_MS,
  DEFAULT_MAX_PRICE_MOVE_RATIO,
  DEFAULT_REGULAR_MARKET_STALE_MS,
  createMarketDataGuard,
  expectedProviderSymbol,
  finiteNumber,
  normalizeHistory
};
