'use strict';

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

function createMarketService({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  async function yahooChart(symbol, range, interval) {
    const endpoint = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
    endpoint.searchParams.set('range', range);
    endpoint.searchParams.set('interval', interval);
    endpoint.searchParams.set('events', 'div,splits');
    const response = await fetchImpl(endpoint, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        accept: 'application/json'
      }
    });
    if (!response.ok) throw Error(`Yahoo Finance ${symbol}: HTTP ${response.status}`);
    const body = await response.json(), result = body?.chart?.result?.[0];
    if (!result) throw Error(body?.chart?.error?.description || `ไม่มีข้อมูล ${symbol} จาก Yahoo Finance`);
    return result;
  }

  async function search(query) {
    const endpoint = new URL('https://query1.finance.yahoo.com/v1/finance/search');
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('quotesCount', '20');
    endpoint.searchParams.set('newsCount', '0');
    const response = await fetchImpl(endpoint, {
      headers: { 'user-agent': 'Mozilla/5.0 SETscope stock search', accept: 'application/json' },
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok) throw Error(`Yahoo Finance search HTTP ${response.status}`);
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

  function shapeChart(result, symbol) {
    const quote = result.indicators?.quote?.[0] || {}, timestamps = result.timestamp || [];
    const bars = timestamps.map((time, index) => ({
      time: time * 1000,
      open: quote.open?.[index] ?? null,
      high: quote.high?.[index] ?? null,
      low: quote.low?.[index] ?? null,
      close: quote.close?.[index] ?? null,
      volume: quote.volume?.[index] ?? null
    })).filter(row => row.close !== null);
    const meta = result.meta || {};
    const last = meta.regularMarketPrice ?? bars.at(-1)?.close ?? null;
    const prior = meta.chartPreviousClose ?? meta.previousClose ?? null;
    return {
      symbol,
      last,
      prior,
      time: (meta.regularMarketTime ? meta.regularMarketTime * 1000 : bars.at(-1)?.time) || null,
      fullName: meta.longName || meta.shortName || symbol,
      currency: meta.currency || 'THB',
      high: meta.regularMarketDayHigh ?? null,
      low: meta.regularMarketDayLow ?? null,
      volume: meta.regularMarketVolume ?? null,
      exchange: meta.fullExchangeName || 'SET',
      marketState: meta.marketState || 'UNKNOWN',
      history: bars
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
    const base = await Promise.allSettled(symbols.map(async symbol => shapeChart(await yahooChart(`${symbol}.BK`, '1d', '5m'), symbol)));
    const stocks = base.filter(result => result.status === 'fulfilled').map(result => result.value);
    const errors = base.filter(result => result.status === 'rejected').map(result => result.reason.message);
    if (!stocks.length) throw Error(errors.join(' · ') || 'Yahoo Finance ยังไม่คืนข้อมูลหุ้นไทย');

    const indexTry = await Promise.allSettled([yahooChart('^SET.BK', '1d', '5m')]);
    let index = null;
    if (indexTry[0].status === 'fulfilled') index = shapeChart(indexTry[0].value, 'SET');
    else errors.push(indexTry[0].reason.message);

    let turnoverMillionBaht = null;
    if (env.SET_API_KEY) {
      try { turnoverMillionBaht = await getSetTurnoverMillionBaht(); }
      catch (error) { errors.push(`SET turnover: ${error.message}`); }
    }
    if (index) index.turnoverMillionBaht = turnoverMillionBaht;

    let selected = stocks.find(stock => stock.symbol === active);
    if (selected && (rangeName !== '1d' || interval !== '5m')) {
      try {
        const historyResult = shapeChart(await yahooChart(`${active}.BK`, rangeName, interval), active);
        selected = { ...selected, history: historyResult.history };
      } catch (error) { errors.push(error.message); }
    }
    const history = selected?.history || [];
    let levelsHistory = history, indicatorHistory = history;
    if (selected && history.length < 40) {
      const [fallbackRange, fallbackInterval] = LEVEL_FALLBACK_PERIODS[range] || LEVEL_FALLBACK_PERIODS['1M'];
      try {
        const fallback = shapeChart(await yahooChart(`${active}.BK`, fallbackRange, fallbackInterval), active);
        if (fallback.history.length > history.length) {
          levelsHistory = fallback.history;
          indicatorHistory = fallback.history;
        }
      } catch (error) { errors.push(`ข้อมูลย้อนหลังสำหรับการวิเคราะห์: ${error.message}`); }
    }
    return {
      stocks,
      indices: index ? [index] : [],
      history,
      levelsHistory,
      indicatorHistory,
      fetchedAt: new Date().toISOString(),
      provider: 'Yahoo Finance',
      delayMinutes: 15,
      errors
    };
  }

  return { getMarket, search, shapeChart, yahooChart };
}

module.exports = { LEVEL_FALLBACK_PERIODS, PERIODS, createMarketService };
