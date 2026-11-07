'use strict';

const { tradingDay } = require('../../server/automation-policy');
const { createMarketService } = require('../../server/market-service');
const { providerChart, observedAt, session, coverage } = require('./screener.cjs');
const { chartHistoryToRecords } = require('../../server/daily-ohlcv');

function historyBars(count, last = session, base = 25) {
  const bars = [];
  for (let time = Date.parse(last + 'T03:00:00Z'); bars.length < count; time -= 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    if ([0, 6].includes(new Date(time).getUTCDay()) || tradingDay(date) === false) continue;
    bars.unshift({ time });
  }
  return bars.map((bar, index) => {
    const close = base + index * .1 + index * index * .002;
    return { ...bar, open: close, high: close + 1, low: close - 1, close, volume: 1000000 };
  });
}

function dailySource(symbol = 'PTT', { count = 65, last = session, fetchedAt = observedAt, base = 25 } = {}) {
  const bars = historyBars(count, last, base);
  const raw = providerChart(symbol + '.BK', '1d', bars).chart.result[0];
  raw.meta.regularMarketTime = (bars.at(-1).time + 6.5 * 3600000) / 1000;
  const market = createMarketService({ now: () => fetchedAt, fetchImpl: () => { throw Error('Provider forbidden in offline fixture'); } });
  const result = market.shapeChart(raw, symbol, 'chart:1y:1d');
  return { meta: raw.meta, result, records: chartHistoryToRecords(symbol, raw.meta, result) };
}

module.exports = { dailySource, historyBars, observedAt, session, coverage };
