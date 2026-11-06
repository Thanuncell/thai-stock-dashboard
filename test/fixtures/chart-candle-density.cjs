'use strict';

const { tradingDay } = require('../../server/automation-policy');

const day = 86400000;
const received = Date.UTC(2026, 10, 6, 9, 10);
const durations = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '60m': 3600000, '1d': day };
const months = { '1mo': 1, '3mo': 3, '6mo': 6, '1y': 12, '2y': 24 };
const localDay = time => Math.floor((time + 7 * 3600000) / day);

function barsBetween(start, end, interval) {
  const rows = [], periods = [];
  for (let date = Math.floor(start / day) * day; date < end; date += day) {
    const dayStart = new Date(date);
    if ([0, 6].includes(dayStart.getUTCDay()) || tradingDay(dayStart.toISOString().slice(0, 10)) === false) continue;
    const sessions = [[3, 5.5], [7, 9.5]].map(([open, close]) => ({
      start: (date + open * 3600000) / 1000, end: (date + close * 3600000) / 1000
    }));
    periods.push(sessions);
    for (const session of interval === '1d' ? sessions.slice(0, 1) : sessions) {
      for (let time = session.start * 1000; time < session.end * 1000; time += durations[interval]) {
        if (time < start || time >= end) continue;
        const close = 100 + Math.sin(time / 7130000) * 2;
        rows.push({ time, open: close - 0.2, high: close + 0.7, low: close - 0.9, close, volume: time / 1000 % 1021 });
      }
    }
  }
  return { rows, periods };
}

function payload(symbol, interval, rows, periods) {
  const last = rows.at(-1);
  const prior = rows.findLast(row => localDay(row.time) < localDay(last?.time));
  return {
    meta: { symbol, exchangeName: 'SET', currency: 'THB', exchangeTimezoneName: 'Asia/Bangkok',
      dataGranularity: interval, regularMarketPrice: last?.close, regularMarketTime: last?.time / 1000 || null,
      previousClose: prior?.close, tradingPeriods: { regular: periods } },
    timestamp: rows.map(row => row.time / 1000),
    indicators: { quote: [Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(field =>
      [field, rows.map(row => row[field])]))] }
  };
}

function responder(calls, { visibleLimit, mutate } = {}) {
  return async input => {
    const url = new URL(input), query = url.searchParams;
    const symbol = decodeURIComponent(url.pathname.split('/').at(-1));
    const range = query.get('range'), interval = query.get('interval');
    const warmup = query.has('period1'), visible = symbol === 'PTT.BK' && ['1mo', '3mo'].includes(range);
    const from = new Date(received);
    if (months[range]) from.setUTCMonth(from.getUTCMonth() - months[range]);
    else from.setUTCDate(from.getUTCDate() - (range === '5d' ? 5 : 1));
    const start = warmup ? Number(query.get('period1')) * 1000 : +from;
    const end = warmup ? Number(query.get('period2')) * 1000 : received + 1;
    const call = { symbol, range, interval, start, end, warmup, visible };
    calls.push(call);
    const { rows, periods } = barsBetween(start, end, interval);
    const shown = visible && visibleLimit !== undefined ? rows.slice(0, visibleLimit) : rows;
    const result = payload(symbol, interval, shown, periods);
    const response = mutate?.(result, call);
    return response || { ok: true, status: 200, json: async () => ({ chart: { result: [result] } }) };
  };
}

module.exports = { barsBetween, payload, received, responder };
