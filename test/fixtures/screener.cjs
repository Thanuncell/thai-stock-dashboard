'use strict';

const { tradingDay } = require('../../server/automation-policy');
const session = '2026-11-06';
const observedAt = Date.parse(session + 'T11:30:00Z');
const coverage = symbol => ({
  symbol, provider_symbol: symbol + '.BK', provider: 'Yahoo Finance', active: true,
  status: 'verified', guard_status: 'accepted', symbol_verified: true, chart_ready: true
});

function dailyBars(last = session, count = 65, base = 25) {
  const bars = [];
  for (let time = Date.parse(last + 'T03:00:00Z'); bars.length < count; time -= 86400000) {
    if (!tradingDay(new Date(time).toISOString().slice(0, 10))) continue;
    bars.unshift({ time, complete: true, availableAt: time + 7.25 * 3600000 });
  }
  return bars.map((bar, index) => {
    const close = base + 0.1 * index + 0.002 * index ** 2;
    return { ...bar, close, open: close, high: close + 1, low: close - 1, volume: 1000 };
  });
}

function guardedDaily(symbol, bars = dailyBars()) {
  return {
    meta: { symbol: symbol + '.BK', dataGranularity: '1d', exchangeTimezoneName: 'Asia/Bangkok' },
    result: {
      history: bars, historyStatus: 'usable', identityStatus: 'accepted',
      guardStatus: 'accepted', dataState: 'delayed', guardReasons: [],
      provenance: { provider: 'Yahoo Finance', interval: '1d', receivedAt: new Date(observedAt).toISOString() }
    }
  };
}

function providerChart(symbol, interval, bars) {
  const last = bars.at(-1);
  return { chart: { result: [{
    meta: {
      symbol, dataGranularity: interval, currency: 'THB', exchangeName: 'SET',
      exchangeTimezoneName: 'Asia/Bangkok', regularMarketPrice: last.close,
      regularMarketTime: Date.parse(session + 'T09:30:00Z') / 1000, marketState: 'CLOSED', currentTradingPeriod: { regular: { start: last.time / 1000, end: (last.time + 6.5 * 3600000) / 1000 } }
    },
    timestamp: bars.map(bar => bar.time / 1000),
    indicators: { quote: [Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(
      field => [field, bars.map(bar => bar[field])]
    ))] }
  }], error: null } };
}

module.exports = { session, observedAt, coverage, dailyBars, guardedDaily, providerChart };
