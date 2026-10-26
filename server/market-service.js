'use strict';

const { createMarketDataGuard } = require('./data-guard');

const PERIODS = Object.freeze({
  '1D': ['1d', '1m'],
  '1W': ['5d', '15m'],
  '1M': ['1mo', '1d'],
  '3M': ['3mo', '1d'],
  '1Y': ['1y', '1d']
});
const LEVEL_FALLBACK_PERIODS = Object.freeze({
  '1D': ['1mo', '1d'],
  '1W': ['3mo', '1d'],
  '1M': ['6mo', '1d'],
  '3M': ['1y', '1d'],
  '1Y': ['2y', '1d']
});

function createMarketService({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
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
    endpoint.searchParams.set('range', range);
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

  async function search(query) {
    const items = await searchOnce(query);
    const canonical = String(query || '').trim().toUpperCase();
    // Ambiguous short tickers can be crowded out by foreign equities in Yahoo's first page.
    if (!items.length && /^[A-Z0-9&.-]{1,20}$/.test(canonical) && !canonical.endsWith('.BK')) {
      return searchOnce(`${canonical}.BK`);
    }
    return items;
  }

  async function searchOnce(query) {
    const endpoint = new URL('https://query1.finance.yahoo.com/v1/finance/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('quotesCount', '20');
    endpoint.searchParams.set('newsCount', '0');
    const response = await fetchImpl(endpoint, {
      headers: { 'user-agent': 'Mozilla/5.0 SETscope stock search', accept: 'application/json' },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) {
      const stopped = [401,403,429].includes(response.status);
      throw Object.assign(Error(`Yahoo Finance search HTTP ${response.status}`), {
        status: response.status, accessDenied: [401,403].includes(response.status), stopBatch: stopped
      });
    }
    const body = await response.json();
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

  function shapeChart(result, symbol, contextKey = 'default', providerSymbol) {
    const assessed = dataGuard.assess(result, symbol, { contextKey, providerSymbol });
    if (assessed.value) return assessed.value;
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
      asOf: value.time ? new Date(value.time).toISOString() : null
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
    const errors = base.filter(result => result.status === 'rejected').map(result => result.reason.message);
    stocks.filter(stock => stock.guardStatus !== 'accepted')
      .forEach(stock => errors.push(`${stock.symbol}: ${stock.guardReasons.join(',') || stock.guardStatus}`));
    if (!stocks.length) throw Error(errors.join(' · ') || 'Yahoo Finance ยังไม่คืนข้อมูลหุ้นไทย');

    const indexTry = await Promise.allSettled([yahooChart('^SET.BK', '1d', '5m')]);
    let index = null;
    if (indexTry[0].status === 'fulfilled') {
      try { index = shapeChart(indexTry[0].value, 'SET', 'quote:1d:5m'); }
      catch (error) { errors.push(error.message); }
    } else errors.push(indexTry[0].reason.message);

    let turnoverMillionBaht = null;
    if (env.SET_API_KEY) {
      try { turnoverMillionBaht = await getSetTurnoverMillionBaht(); }
      catch (error) { errors.push(`SET turnover: ${error.message}`); }
    }
    if (index) index.turnoverMillionBaht = turnoverMillionBaht;

    let selected = stocks.find(stock => stock.symbol === active);
    if (selected && (rangeName !== '1d' || interval !== '5m')) {
      try {
        const historyResult = shapeChart(await yahooChart(`${active}.BK`, rangeName, interval), active, `chart:${rangeName}:${interval}`);
        selected = {
          ...selected,
          history: historyResult.history,
          validatedHistory: historyResult.validatedHistory,
          rejectedBars: historyResult.rejectedBars,
          historyReasons: historyResult.historyReasons,
          historyStatus: historyResult.historyStatus,
          identityStatus: historyResult.identityStatus,
          quoteStatus: historyResult.quoteStatus,
          guardStatus: historyResult.guardStatus,
          guardReasons: historyResult.guardReasons,
          dataState: historyResult.dataState,
          stale: historyResult.stale
        };
      } catch (error) {
        errors.push(error.message);
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
    const trustedTechnicalHistory = ['usable', 'usable_with_warnings'].includes(selected?.historyStatus);
    let levelsHistory = trustedTechnicalHistory ? history : [];
    let indicatorHistory = trustedTechnicalHistory ? history : [];
    if (trustedTechnicalHistory && history.length < 40) {
      const [fallbackRange, fallbackInterval] = LEVEL_FALLBACK_PERIODS[range] || LEVEL_FALLBACK_PERIODS['1M'];
      try {
        const fallback = shapeChart(await yahooChart(`${active}.BK`, fallbackRange, fallbackInterval), active, `chart:${fallbackRange}:${fallbackInterval}`);
        if (['usable', 'usable_with_warnings'].includes(fallback.historyStatus) && fallback.history.length > history.length) {
          levelsHistory = fallback.history;
          indicatorHistory = fallback.history;
        }
      } catch (error) { errors.push(`ข้อมูลย้อนหลังสำหรับการวิเคราะห์: ${error.message}`); }
    }
    const fetchedAt = new Date().toISOString();
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
