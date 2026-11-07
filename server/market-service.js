'use strict';

const { createMarketDataGuard } = require('./data-guard');
const { tradingDay } = require('./automation-policy');
const { intervalMs, temporalBars } = require('../lib/market-time');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const BANGKOK_OFFSET = 7 * 60 * MINUTE;
const exchangeDate = time => Math.floor((time + BANGKOK_OFFSET) / DAY);
// SET/mai ordinary equities: earliest randomized opens, regular ends, then the closing auction.
const EQUITY_WINDOWS = [[9 * 60 + 55, 12 * 60 + 30], [13 * 60 + 55, 16 * 60 + 30], [16 * 60 + 30, 16 * 60 + 40]];
const SESSION_VERIFIED = 'SESSION_VERIFIED';
const SESSION_UNVERIFIED = 'SESSION_UNVERIFIED';
const DENSE_INTERVALS = new Set(['30m', '60m']);

function monthsBefore(time, months) {
  const date = new Date(time + BANGKOK_OFFSET);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return +date - BANGKOK_OFFSET;
}

function normalEquityWindow(time) {
  const date = exchangeDate(time);
  const midnight = date * DAY - BANGKOK_OFFSET;
  const minute = (time - midnight) / MINUTE;
  return EQUITY_WINDOWS.findIndex(([start, end], index) => minute >= start
    && (minute < end || index === EQUITY_WINDOWS.length - 1 && minute === end));
}

function regularSessions(meta) {
  const sessions = new Map();
  const historical = meta.tradingPeriods;
  const regular = Array.isArray(historical) ? historical : historical?.regular;
  const periods = [...(Array.isArray(regular) ? regular.flat() : []), meta.currentTradingPeriod?.regular];
  for (const period of periods) {
    const start = Number(period?.start) * 1000, end = Number(period?.end) * 1000;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= start
      || exchangeDate(start) !== exchangeDate(end - 1)) continue;
    const window = normalEquityWindow(start);
    // A whole-day period cannot verify either side of the lunch break.
    if (window < 0 || normalEquityWindow(end - 1) !== window) continue;
    const key = exchangeDate(start) * EQUITY_WINDOWS.length + window;
    const previous = sessions.get(key);
    if (previous === null || previous?.some(item => item.start === start && item.end === end)) continue;
    if (previous?.some(item => start < item.end && end > item.start)) sessions.set(key, null);
    else sessions.set(key, [...(previous || []), { start, end }]);
  }
  return sessions;
}

function sessionKey(time) {
  return exchangeDate(time) * EQUITY_WINDOWS.length + normalEquityWindow(time);
}

function cadenceEvidence(rows, interval, sessionFor) {
  const duration = intervalMs(interval);
  const sessions = new Set();
  let nativeGaps = 0, skippedGaps = 0, offGridGaps = 0, doubleGaps = 0, alternateGridGaps = 0;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1].time, time = rows[i].time;
    const key = sessionKey(time);
    const providerEnd = sessionFor(previous)?.end;
    if (key !== sessionKey(previous) || (providerEnd && time >= providerEnd)) continue;
    sessions.add(key);
    const gap = time - previous;
    if (gap < duration) {
      throw Object.assign(Error('Yahoo bar cadence shorter than requested within a session'), { code: 'PARSER_MISMATCH' });
    }
    if (gap === duration) nativeGaps++;
    else if (gap % duration === 0) skippedGaps++;
    else offGridGaps++;
    if (gap === 2 * duration) doubleGaps++;
    if (gap % (2 * duration) === 0) alternateGridGaps++;
  }
  const samples = nativeGaps + skippedGaps + offGridGaps;
  const dailyLike = rows.length >= 5 && rows.every((bar, i) => i === 0
    || bar.time % DAY === rows[0].time % DAY && exchangeDate(bar.time) !== exchangeDate(rows[i - 1].time));
  // Repeated alternate spacing is ambiguous for illiquid symbols. Keep the
  // provider bars visible with a warning and withhold interval-based signals.
  const alternate = sessions.size >= 2 && doubleGaps >= 4 && alternateGridGaps === samples;
  const repeatedOffGrid = sessions.size >= 2 && offGridGaps >= 4 && offGridGaps === samples;
  const status = dailyLike || alternate || repeatedOffGrid ? 'INTERVAL_CADENCE_SUSPECT'
    : nativeGaps && !offGridGaps ? 'INTERVAL_CADENCE_VERIFIED' : 'INTERVAL_CADENCE_UNVERIFIED';
  return { status, samples, nativeGaps, skippedGaps, offGridGaps, doubleGaps, dailyLike };
}

function densityHistoryPolicy(result, interval, bounds) {
  const meta = result?.meta || {};
  const reported = String(meta.dataGranularity || '').toLowerCase();
  if (reported !== interval && !(interval === '60m' && reported === '1h')) {
    throw Object.assign(Error('Yahoo interval differs from the requested interval'), { code: 'PARSER_MISMATCH' });
  }
  if (meta.exchangeTimezoneName !== 'Asia/Bangkok') {
    throw Object.assign(Error('Thai intraday chart timezone mismatch'), { code: 'PARSER_MISMATCH' });
  }

  const sessions = regularSessions(meta);
  const calendar = new Map();
  const sessionFor = time => sessions.get(sessionKey(time))?.find(period => time >= period.start && time < period.end);
  const barTimeIssue = time => {
    if (!Number.isSafeInteger(time) || time % 1000 !== 0) return 'INVALID_TIMESTAMP';
    if (bounds && (time < bounds.start || time >= bounds.end)) return 'OUTSIDE_CHART_WINDOW';
    if (normalEquityWindow(time) < 0) return 'OUTSIDE_TRADING_SESSION';
    const date = exchangeDate(time);
    if (!calendar.has(date)) {
      const day = new Date(date * DAY);
      const weekday = day.getUTCDay();
      calendar.set(date, weekday !== 0 && weekday !== 6 && tradingDay(day.toISOString().slice(0, 10)) !== false);
    }
    return calendar.get(date) ? null : 'OUTSIDE_TRADING_SESSION';
  };
  return { barTimeIssue, sessionFor, requireVolume: true };
}

const historySessionStatus = rows => rows.length > 0 && rows.every(row => row.sessionStatus === SESSION_VERIFIED)
  ? SESSION_VERIFIED : SESSION_UNVERIFIED;

const PUBLIC_ERROR_CODES = new Set([
  'SOURCE_NO_DATA', 'SOURCE_DENIED', 'SOURCE_RATE_LIMITED', 'ACQUISITION_GAP', 'PARSER_MISMATCH',
  'DATA_GUARD_REJECTED', 'SYMBOL_UNVERIFIED', 'SYMBOL_MISMATCH', 'MARKET_MISMATCH',
  'INVALID_TIMESTAMP', 'FUTURE_TIMESTAMP', 'STALE_TIMESTAMP', 'INVALID_NUMERIC', 'INVALID_OHLC',
  'NEGATIVE_VOLUME', 'LAST_CLOSE_MISMATCH', 'PRICE_CHANGE_MISMATCH', 'DATA_ANOMALY', 'HISTORICAL_ANOMALY'
]);

function publicMarketError(error, context) {
  const code = PUBLIC_ERROR_CODES.has(error?.code) ? error.code : 'PROVIDER_UNAVAILABLE';
  return `${context}: ${code}`;
}

const PERIODS = Object.freeze({
  '1D': ['1d', '1m'],
  '1W': ['5d', '15m'],
  '1M': ['1mo', '30m'],
  '3M': ['3mo', '60m'],
  '1Y': ['1y', '1d']
});
const LEVEL_FALLBACK_PERIODS = Object.freeze({
  '1D': ['1mo', '1d'],
  '1W': ['3mo', '1d'],
  '1M': ['6mo', '1d'],
  '3M': ['1y', '1d'],
  '1Y': ['2y', '1d']
});

function createMarketService({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, onDailyHistory } = {}) {
  const dataGuard = createMarketDataGuard({
    now,
    futureToleranceMs: Number(env.DATA_GUARD_FUTURE_TOLERANCE_MS) || undefined,
    regularMarketStaleMs: Number(env.DATA_GUARD_REGULAR_STALE_MS) || undefined,
    maxPriceMoveRatio: Number(env.DATA_GUARD_MAX_PRICE_MOVE_RATIO) || undefined,
    lastKnownGoodTtlMs: Number(env.DATA_GUARD_LAST_KNOWN_TTL_MS) || undefined,
    lastCloseMismatchRatio: Number(env.DATA_GUARD_LAST_CLOSE_MISMATCH_RATIO) || undefined
  });
  async function yahooChart(symbol, range, interval) {
    const endpoint = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    if (range && typeof range === 'object') {
      // Yahoo's 30m lookback is limited; preserve the visible 1M window separately.
      if (!Number.isInteger(range.period1) || !Number.isInteger(range.period2) || range.period1 >= range.period2)
        throw Error('Invalid bounded history request');
      endpoint.searchParams.set('period1', String(range.period1));
      endpoint.searchParams.set('period2', String(range.period2));
    } else endpoint.searchParams.set('range', range);
    endpoint.searchParams.set('interval', interval);
    endpoint.searchParams.set('events', 'div,splits');
    const response = await fetchImpl(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) {
      const error = Error(`Yahoo Finance ${symbol}: HTTP ${response.status}`);
      error.status = response.status;
      error.code = [404, 410].includes(response.status) ? 'SOURCE_NO_DATA'
        : [401, 403].includes(response.status) ? 'SOURCE_DENIED'
          : response.status === 429 ? 'SOURCE_RATE_LIMITED' : 'ACQUISITION_GAP';
      error.accessDenied = [401, 403].includes(response.status);
      error.stopBatch = error.accessDenied || response.status === 429;
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch { throw Object.assign(Error('Yahoo Finance response schema unavailable'), { code: 'PARSER_MISMATCH', stopBatch: true }); }
    const result = body?.chart?.result?.[0];
    if (!result) {
      const providerError = body?.chart?.error;
      const denied = /unauthorized|forbidden/i.test(providerError?.code || '');
      throw Object.assign(Error(providerError?.description || `ไม่มีข้อมูล ${symbol} จาก Yahoo Finance`), {
        code: denied ? 'SOURCE_DENIED' : providerError ? 'SOURCE_NO_DATA' : 'PARSER_MISMATCH',
        accessDenied: denied, stopBatch: denied || !providerError
      });
    }
    return result;
  }

  async function search(query, { allowSuffixFallback = true, signal } = {}) {
    signal?.throwIfAborted();
    const items = await searchOnce(query, signal);
    signal?.throwIfAborted();
    const canonical = String(query || '').trim().toUpperCase();
    // Ambiguous short tickers can be crowded out by foreign equities in Yahoo's first page.
    if (allowSuffixFallback && !items.length && /^[A-Z0-9&.-]{1,20}$/.test(canonical) && !canonical.endsWith('.BK')) {
      return searchOnce(`${canonical}.BK`, signal);
    }
    return items;
  }

  async function searchOnce(query, signal) {
    signal?.throwIfAborted();
    const endpoint = new URL('https://query1.finance.yahoo.com/v1/finance/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('quotesCount', '20');
    endpoint.searchParams.set('newsCount', '0');
    const response = await fetchImpl(endpoint, {
      headers: { 'user-agent': 'Mozilla/5.0 SETscope stock search', accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000)
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      const stopped = [401,403,429].includes(response.status);
      throw Object.assign(Error(`Yahoo Finance search HTTP ${response.status}`), {
        status: response.status, accessDenied: [401,403].includes(response.status), stopBatch: stopped
      });
    }
    const body = await response.json();
    signal?.throwIfAborted();
    return (body.quotes || [])
      .filter(quote => /\.BK$/i.test(quote.symbol || '') && quote.quoteType === 'EQUITY')
      .slice(0, 12)
      .map(quote => ({
        symbol: quote.symbol.replace(/\.BK$/i, ''),
        name: quote.longname || quote.shortname || quote.symbol.replace(/\.BK$/i, ''),
        exchange: quote.exchange || 'SET',
        type: quote.quoteType
      }));
  }

  function shapeChart(result, symbol, contextKey = 'default', providerSymbol, bounds) {
    const interval = contextKey.match(/:(1m|5m|15m|30m|60m|1d)$/)?.[1] || '1d';
    const densityPolicy = DENSE_INTERVALS.has(interval) ? densityHistoryPolicy(result, interval, bounds) : null;
    let cadence = null;
    const validateHistory = densityPolicy ? rows => { cadence = cadenceEvidence(rows, interval, densityPolicy.sessionFor); } : undefined;
    const assessed = dataGuard.assess(result, symbol, { contextKey, providerSymbol, ...densityPolicy, validateHistory });
    if (assessed.value) {
      const value=assessed.value,meta=result?.meta||{};
      const end=!value.fallbackFromLastKnown&&Number(meta.currentTradingPeriod?.regular?.end)>0?Number(meta.currentTradingPeriod.regular.end)*1000:null;
      const start=!value.fallbackFromLastKnown&&Number(meta.currentTradingPeriod?.regular?.start)>0?Number(meta.currentTradingPeriod.regular.start)*1000:null;
      const timeZone=meta.exchangeTimezoneName||'Asia/Bangkok';
      const rows = densityPolicy ? value.history.filter(bar => !densityPolicy.barTimeIssue(bar.time)).map(bar => {
        const period = !value.fallbackFromLastKnown && densityPolicy.sessionFor(bar.time);
        return { ...bar, sessionEnd: period ? period.end : null, sessionStatus: period ? SESSION_VERIFIED : SESSION_UNVERIFIED };
      }) : value.history;
      const densityEvidence = densityPolicy ? {
        sessionStatus: historySessionStatus(rows),
        cadence: value.fallbackFromLastKnown ? null : cadence
      } : {};
      const historyReasons = [...(value.historyReasons || [])];
      if (densityEvidence.sessionStatus === SESSION_UNVERIFIED) historyReasons.push(SESSION_UNVERIFIED);
      if (densityEvidence.cadence?.status === 'INTERVAL_CADENCE_SUSPECT') historyReasons.push('INTERVAL_MISMATCH');
      else if (densityEvidence.cadence?.status === 'INTERVAL_CADENCE_UNVERIFIED') historyReasons.push('INTERVAL_CADENCE_UNVERIFIED');
      const history=temporalBars(rows,{interval,observedAt:value.receivedAt,regularStart:start,regularEnd:end,timeZone});
      const shaped = {...value,history,validatedHistory:history,historyReasons,provenance:{provider:'Yahoo Finance',priceBasis:'provider-quote-ohlc',adjustment:'provider-defined; no local adjustment',
        interval,receivedAt:value.receivedAt,timestampKind:'bar-open',regularStart:start,regularEnd:end,timeZone,corporateActionCount:Object.keys(result?.events?.splits||{}).length,
        dividendCount:Object.keys(result?.events?.dividends||{}).length,adjustedClosePresent:Array.isArray(result?.indicators?.adjclose?.[0]?.adjclose),historyReasons,...densityEvidence}};
      if (interval === '1d') onDailyHistory?.(symbol, meta, shaped);
      return shaped;
    }
    const error = Error(`Data Guard ${symbol}: ${assessed.guardReasons.join(',') || 'UNAVAILABLE'}`);
    error.code = assessed.guardReasons[0] || 'DATA_GUARD_REJECTED';
    error.guardStatus = assessed.guardStatus;
    error.guardReasons = assessed.guardReasons;
    throw error;
  }

  async function verifySymbol(symbol, providerSymbol) {
    const canonical = String(symbol || '').trim().toUpperCase().replace(/\.BK$/, '');
    const mapped = providerSymbol || `${canonical}.BK`;
    if (!/^[A-Z0-9&.-]{1,32}\.BK$/.test(mapped)) throw Error('Invalid stored provider mapping');
    const value = shapeChart(await yahooChart(mapped, '3mo', '1d'), canonical, `chart:${mapped}:3mo:1d`, mapped);
    const trusted = value.identityStatus === 'accepted';
    const chartReady = trusted && ['usable', 'usable_with_warnings'].includes(value.historyStatus) && value.history.length > 0;
    return {
      symbolVerified: trusted,
      quoteReady: trusted && value.quoteStatus === 'accepted',
      chartReady,
      technicalReady: chartReady && value.history.length >= 30,
      guardStatus: value.guardStatus,
      guardReason: value.guardReasons[0] || null,
      asOf: value.time ? new Date(value.time).toISOString() : null,
      historyAsOf: value.history.at(-1)?.time ? new Date(value.history.at(-1).time).toISOString() : null
    };
  }

  async function getSetTurnoverMillionBaht() {
    if (!env.SET_API_KEY) return null;
    const endpoint = new URL('https://marketplace.set.or.th/api/public/delay-data/index');
    endpoint.searchParams.set('market', 'SET');
    const response = await fetchImpl(endpoint, {
      headers: { 'api-key': env.SET_API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(7000)
    });
    if (!response.ok) throw Error(`SET delayed index API HTTP ${response.status}`);
    const payload = await response.json();
    const findRecord = value => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findRecord(item);
          if (found) return found;
        }
        return null;
      }
      if (value && typeof value === 'object') {
        if (String(value.symbol || '').toUpperCase() === 'SET') return value;
        for (const child of Object.values(value)) {
          const found = findRecord(child);
          if (found) return found;
        }
      }
      return null;
    };
    const row = findRecord(payload), total = Number(row?.totalValue ?? row?.value);
    return Number.isFinite(total) && total >= 0 ? total / 1_000_000 : null;
  }

  async function getMarket(symbols, active, range) {
    const [rangeName, interval] = PERIODS[range] || PERIODS['1D'];
    const base = await Promise.allSettled(symbols.map(async symbol => shapeChart(await yahooChart(`${symbol}.BK`, '1d', '5m'), symbol, 'quote:1d:5m')));
    const stocks = base.filter(result => result.status === 'fulfilled').map(result => result.value);
    const errors = base.flatMap((result, index) => result.status === 'rejected'
      ? [publicMarketError(result.reason, symbols[index])] : []);
    stocks.filter(stock => stock.guardStatus !== 'accepted')
      .forEach(stock => errors.push(`${stock.symbol}: ${stock.guardReasons.join(',') || stock.guardStatus}`));
    if (!stocks.length) throw Error(errors.join(' · ') || 'Yahoo Finance ยังไม่คืนข้อมูลหุ้นไทย');

    const indexTry = await Promise.allSettled([yahooChart('^SET.BK', '1d', '5m')]);
    let index = null;
    if (indexTry[0].status === 'fulfilled') {
      try { index = shapeChart(indexTry[0].value, 'SET', 'quote:1d:5m'); }
      catch (error) { errors.push(publicMarketError(error, 'SET')); }
    } else errors.push(publicMarketError(indexTry[0].reason, 'SET'));

    let turnoverMillionBaht = null;
    if (env.SET_API_KEY) {
      try { turnoverMillionBaht = await getSetTurnoverMillionBaht(); }
      catch (error) { errors.push(publicMarketError(error, 'SET turnover')); }
    }
    if (index) index.turnoverMillionBaht = turnoverMillionBaht;

    const dense = DENSE_INTERVALS.has(interval);
    const chartAt = now();
    const visibleBounds = dense ? { start: monthsBefore(chartAt, range === '1M' ? 1 : 3), end: chartAt + 1 } : undefined;
    let selected = stocks.find(stock => stock.symbol === active);
    if (selected && (rangeName !== '1d' || interval !== '5m')) {
      try {
        const historyResult = shapeChart(await yahooChart(`${active}.BK`, rangeName, interval),
          active, `chart:${rangeName}:${interval}`, undefined, visibleBounds);
        selected = {
          ...selected,
          history: historyResult.history,
          validatedHistory: historyResult.validatedHistory,
          rejectedBars: historyResult.rejectedBars,
          historyReasons: historyResult.historyReasons,
          historyStatus: historyResult.historyStatus,
          provenance: historyResult.provenance,
          identityStatus: historyResult.identityStatus,
          quoteStatus: historyResult.quoteStatus,
          guardStatus: historyResult.guardStatus,
          guardReasons: historyResult.guardReasons,
          dataState: historyResult.dataState,
          stale: historyResult.stale
        };
      } catch (error) {
        errors.push(publicMarketError(error, active));
        selected = {
          ...selected,
          history: [],
          validatedHistory: [],
          historyStatus: 'blocked',
          guardStatus: 'unavailable',
          guardReasons: error.guardReasons || [error.code || 'RANGE_UNAVAILABLE'],
          dataState: 'unavailable',
          stale: false
        };
      }
    }
    const history = selected?.history || [];
    const trustedTechnicalHistory = ['usable', 'usable_with_warnings'].includes(selected?.historyStatus)
      && selected?.provenance?.cadence?.status !== 'INTERVAL_CADENCE_SUSPECT';
    let levelsHistory = trustedTechnicalHistory ? history : [];
    let indicatorHistory = trustedTechnicalHistory ? history : [];
    let indicatorProvenance=selected?.provenance||null;
    let levelProvenance=selected?.provenance||null;
    if (!dense && trustedTechnicalHistory && history.length < 40) {
      const [fallbackRange, fallbackInterval] = LEVEL_FALLBACK_PERIODS[range] || LEVEL_FALLBACK_PERIODS['1M'];
      try {
        const fallback = shapeChart(await yahooChart(`${active}.BK`, fallbackRange, fallbackInterval), active, `chart:${fallbackRange}:${fallbackInterval}`);
        if (['usable', 'usable_with_warnings'].includes(fallback.historyStatus) && fallback.history.length > history.length) {
          // Longer history may inform price levels, but technical indicators must stay
          // on the selected chart interval: daily candles are not intraday candles.
          levelsHistory = fallback.history;
          levelProvenance=fallback.provenance;
          if (fallbackInterval === interval) { indicatorHistory = fallback.history; indicatorProvenance=fallback.provenance; }
        }
      } catch (error) { errors.push(publicMarketError(error, 'ข้อมูลย้อนหลังสำหรับการวิเคราะห์')); }
    }
    if (dense && trustedTechnicalHistory && selected.guardStatus === 'accepted'
      && history.filter(bar => bar.complete).length < 200) {
      // Acquire only the prefix missing from the visible window. The selected
      // receipt remains the observation cutoff for confirmed signals.
      const period1 = Math.ceil((range === '1M' ? chartAt - 59 * 86400000 : monthsBefore(chartAt, 6)) / 1000);
      const period2 = history[0].time / 1000;
      if (period1 < period2) {
        try {
          const fallback = shapeChart(await yahooChart(`${active}.BK`, { period1, period2 }, interval), active,
            `chart:warmup:${interval}`, undefined, { start: period1 * 1000, end: history[0].time });
          if (['usable', 'usable_with_warnings'].includes(fallback.historyStatus)
            && fallback.guardStatus === 'accepted' && fallback.identityStatus === 'accepted'
            && fallback.provenance.cadence?.status !== 'INTERVAL_CADENCE_SUSPECT') {
            const cutoff = Date.parse(selected.provenance.receivedAt);
            const older = fallback.history.filter(bar => bar.complete && bar.availableAt <= cutoff);
            if (older.length) {
              indicatorHistory = [...older, ...history];
              levelsHistory = indicatorHistory;
              indicatorProvenance = levelProvenance = {
                ...selected.provenance,
                sessionStatus: historySessionStatus(indicatorHistory),
                historyReasons: [...new Set([...selected.provenance.historyReasons, ...fallback.provenance.historyReasons])],
                corporateActionCount: Math.max(selected.provenance.corporateActionCount, fallback.provenance.corporateActionCount)
              };
            }
          }
        } catch (error) { errors.push(publicMarketError(error, 'ข้อมูลย้อนหลังสำหรับการวิเคราะห์')); }
      }
    }
    const fetchedAt = new Date(now()).toISOString();
    const latestProviderTime = [...stocks, index].filter(Boolean)
      .map(item => Number(item.time)).filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), 0);
    const partial = errors.length > 0;
    const selectedDataState = selected?.dataState;
    const dataState = selectedDataState === 'stale'
      ? 'stale'
      : selectedDataState === 'unavailable'
        ? 'unavailable'
      : selectedDataState === 'suspect' || selectedDataState === 'quarantined'
        ? 'suspect'
        : partial ? 'partial' : 'delayed';
    return {
      stocks,
      indices: index ? [index] : [],
      history,
      levelsHistory,
      indicatorHistory,
      ...(dense ? { candleTarget: 100, candleCount: history.length, candleTargetMet: history.length >= 100 } : {}),
      technicalMeta:{history:selected?.provenance||null,indicator:indicatorProvenance,levels:levelProvenance},
      fetchedAt,
      asOf: latestProviderTime ? new Date(latestProviderTime).toISOString() : fetchedAt,
      provider: 'Yahoo Finance',
      source: 'Yahoo Finance',
      delayMinutes: 15,
      delayed: true,
      stale: dataState === 'stale',
      partial,
      dataState,
      errors
    };
  }

  return { getMarket, search, shapeChart, verifySymbol, yahooChart };
}

module.exports = { LEVEL_FALLBACK_PERIODS, PERIODS, createMarketService };
