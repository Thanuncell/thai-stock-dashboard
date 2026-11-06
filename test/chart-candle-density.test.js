'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PERIODS, createMarketService } = require('../server/market-service');
const { intervalMs, temporalBars } = require('../lib/market-time');
const { barsBetween, payload, received, responder } = require('./fixtures/chart-candle-density.cjs');

let technical;
test.before(async () => { technical = await import('../client/technical.mjs'); });
const getService = (calls, options) => createMarketService({ env: {}, now: () => received, fetchImpl: responder(calls, options) });
const technicalSnapshot = (market, timeframe) => technical.createTechnicalSnapshot({ ...market, symbol: 'PTT', timeframe });
const ohlcv = ({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume });

for (const [range, providerRange, interval] of [['1M', '1mo', '30m'], ['3M', '3mo', '60m']]) {
  test(range + ' preserves native OHLCV and keeps the visible range separate from warm-up', async () => {
    const calls = [], market = await getService(calls).getMarket(['PTT'], 'PTT', range);
    const visible = calls.find(call => call.visible);
    assert.deepEqual(PERIODS[range], [providerRange, interval]);
    assert.equal(technical.RANGE_INTERVAL[range], interval);
    assert.deepEqual(market.history.map(ohlcv), barsBetween(visible.start, visible.end, interval).rows);
    assert.equal(market.candleCount, market.history.length);
    assert.equal(market.candleTarget, 100);
    assert.equal(market.candleTargetMet, true);
    assert.equal(market.technicalMeta.history.interval, interval);
    assert.equal(market.technicalMeta.history.sessionStatus, 'SESSION_VERIFIED');
    assert.equal(market.technicalMeta.history.cadence.status, 'INTERVAL_CADENCE_VERIFIED');
    assert.equal(market.technicalMeta.indicator.interval, interval);
    assert.equal(new Set(market.indicatorHistory.map(row => row.time)).size, market.indicatorHistory.length);
    assert.deepEqual(market.indicatorHistory.slice(-market.history.length), market.history);
    assert.ok(calls.length <= 4);
    const snapshot = technicalSnapshot(market, range);
    for (const indicator of ['sma20', 'ema20', 'ema50', 'ema100', 'ema200', 'macd', 'rsi', 'bb', 'atr']) {
      assert.equal(snapshot.availability[indicator].state, 'available', indicator);
    }
    assert.equal(snapshot.latestCandle.complete, false);
    assert.ok(snapshot.signalReference.availableAt <= received);
    const changed = market.history.map((row, i) => i === market.history.length - 1 ? {
      ...row, open: 600, high: 700, low: 500, close: 650, volume: 99999
    } : row);
    const replay = technicalSnapshot({
      ...market, history: changed, indicatorHistory: [...market.indicatorHistory.slice(0, -changed.length), ...changed]
    }, range);
    assert.deepEqual(replay.signalSeries, snapshot.signalSeries);
    assert.deepEqual(replay.signalReference, snapshot.signalReference);
  });

  test(range + ' exposes a short chart honestly and makes at most one same-interval warm-up call', async () => {
    const calls = [], market = await getService(calls, { visibleLimit: 40 }).getMarket(['PTT'], 'PTT', range);
    const warmup = calls.filter(call => call.warmup);
    assert.equal(market.candleCount, 40);
    assert.equal(market.candleTargetMet, false);
    assert.equal(warmup.length, 1);
    assert.equal(warmup[0].interval, interval);
    assert.equal(warmup[0].end, market.history[0].time);
    if (range === '1M') assert.ok(received - warmup[0].start <= 59 * 86400000);
    assert.ok(market.indicatorHistory.length > 200);
    assert.deepEqual(market.indicatorHistory.slice(-40), market.history);
    assert.ok(market.indicatorHistory.at(-41).time < market.history[0].time);
    assert.equal(technicalSnapshot(market, range).availability.ema200.state, 'available');
    assert.equal(calls.length, 4);
  });
}

for (const [interval, duration] of [['30m', 1800000], ['60m', 3600000]]) {
  test(interval + ' closes at a provider session boundary or at the full interval without session evidence', () => {
    const time = Date.UTC(2026, 10, 6, 5);
    const sessionEnd = time + 600000;
    const bar = { time, open: 1, high: 2, low: 1, close: 2, volume: 5 };
    assert.equal(intervalMs(interval), duration);
    const timed = observedAt => temporalBars([{ ...bar, sessionEnd, sessionStatus: 'SESSION_VERIFIED' }], { interval, observedAt })[0];
    assert.equal(timed(sessionEnd - 1).complete, false);
    assert.equal(timed(sessionEnd).confirmationBasis, 'provider-session-end');
    assert.equal(timed(sessionEnd).availableAt, sessionEnd);
    assert.equal(timed(sessionEnd).complete, true);
    const unverified = temporalBars([{ ...bar, sessionEnd, sessionStatus: 'SESSION_UNVERIFIED' }],
      { interval, observedAt: sessionEnd })[0];
    assert.equal(unverified.availableAt, time + duration);
    assert.equal(unverified.complete, false);
  });
}

test('missing or conflicting provider cadence and timezone fail closed without daily substitution', async () => {
  for (const meta of [{ dataGranularity: '1d' }, { dataGranularity: undefined }, { exchangeTimezoneName: 'UTC' }]) {
    const calls = [], service = getService(calls, { mutate: (result, call) => {
      if (call.visible) Object.assign(result.meta, meta);
    } });
    const market = await service.getMarket(['PTT'], 'PTT', '1M');
    assert.deepEqual(market.history, []);
    assert.deepEqual(market.indicatorHistory, []);
    assert.equal(market.dataState, 'unavailable');
    assert.match(market.errors.join(' '), /PARSER_MISMATCH/);
    assert.equal(calls.length, 3);
  }
});

test('provider 1h alias is accepted for 60m, while overlapping 30m bars are rejected', () => {
  const service = getService([]);
  const { rows, periods } = barsBetween(received - 86400000, received, '60m');
  const hourly = payload('PTT.BK', '1h', rows, periods);
  assert.equal(service.shapeChart(hourly, 'PTT', 'chart:3mo:60m').history.length, rows.length);
  const overlapping = barsBetween(received - 86400000, received, '15m');
  assert.throws(() => service.shapeChart(payload('PTT.BK', '30m', overlapping.rows, overlapping.periods),
    'PTT', 'chart:1mo:30m'), /cadence shorter/);
});

test('range, trading sessions, duplicate timestamps, and invalid OHLCV are validated before counting', async () => {
  const calls = [], service = getService(calls, { mutate: (raw, call) => {
    if (!call.visible) return;
    const quote = raw.indicators.quote[0];
    raw.timestamp[1] = raw.timestamp[0];
    raw.timestamp[2] = (call.start - 86400000) / 1000;
    raw.timestamp[3] = Date.UTC(2026, 10, 5, 6, 15) / 1000;
    quote.high[4] = quote.low[4] - 1;
    quote.volume[5] = null;
    quote.volume[6] = -1;
    const swap = array => { [array[9], array[10]] = [array[10], array[9]]; };
    swap(raw.timestamp);
    Object.values(quote).forEach(swap);
  } });
  const market = await service.getMarket(['PTT'], 'PTT', '1M');
  const { start, end } = calls.find(call => call.visible);
  assert.deepEqual(market.history.map(ohlcv), barsBetween(start, end, '30m').rows.slice(7));
  for (const reason of ['DUPLICATE_TIMESTAMP', 'OUTSIDE_CHART_WINDOW', 'OUTSIDE_TRADING_SESSION',
    'INVALID_OHLC', 'INVALID_NUMERIC', 'NEGATIVE_VOLUME']) {
    assert.ok(market.technicalMeta.history.historyReasons.includes(reason), reason);
  }
});

test('failed warm-up leaves visible data usable and makes no retries or daily requests', async () => {
  const calls = [], market = await getService(calls, { visibleLimit: 40,
    mutate: (raw, call) => call.warmup ? { ok: false, status: 403 } : null
  }).getMarket(['PTT'], 'PTT', '1M');
  assert.equal(market.history.length, 40);
  assert.deepEqual(market.history, market.indicatorHistory);
  assert.match(market.errors.join(' '), /SOURCE_DENIED/);
  assert.equal(calls.length, 4);
  assert.equal(technicalSnapshot(market, '1M').availability.ema200.state, 'insufficient');
});

test('1D, 1W and 1Y keep their provider contracts and cadence', async () => {
  for (const [range, providerRange, interval] of [['1D', '1d', '1m'], ['1W', '5d', '15m'], ['1Y', '1y', '1d']]) {
    const calls = [], market = await getService(calls).getMarket(['PTT'], 'PTT', range);
    assert.deepEqual(PERIODS[range], [providerRange, interval]);
    assert.equal(market.technicalMeta.history.interval, interval);
    assert.equal(market.candleTarget, undefined);
    assert.equal(calls.length, 3);
    assert.equal(calls.at(-1).range, providerRange);
  }
});

const fixtureBar = (date, hour, minute = 0) => ({
  time: Date.UTC(2026, 10, date, hour - 7, minute), open: 100, high: 101, low: 99, close: 100, volume: 5
});
const period = (first, last) => ({ start: first.time / 1000, end: last.time / 1000 });
const shape = (rows, periods, interval = '30m', extraMeta = {}) => {
  const result = payload('PTT.BK', interval, rows, periods);
  Object.assign(result.meta, extraMeta);
  return getService([]).shapeChart(result, 'PTT', 'chart:1mo:' + interval);
};

test('missing session metadata preserves valid OHLCV and rejects off-hours, lunch, weekend and known holiday', () => {
  const holiday = { ...fixtureBar(6, 10), time: Date.UTC(2026, 9, 23, 3) };
  const valid = [fixtureBar(6, 9, 55), fixtureBar(6, 13, 55)];
  const invalid = [holiday, fixtureBar(1, 10), fixtureBar(6, 0, 1), fixtureBar(6, 9, 30),
    fixtureBar(6, 12, 30), fixtureBar(6, 13, 54)];
  const result = shape([...valid, ...invalid].sort((a,b) => a.time - b.time), undefined);
  assert.deepEqual(result.history.map(ohlcv), valid);
  assert.equal(result.rejectedBars, invalid.length);
  assert.equal(result.provenance.sessionStatus, 'SESSION_UNVERIFIED');
  assert.ok(result.history.every(row => row.sessionStatus === 'SESSION_UNVERIFIED' && row.sessionEnd === null));
  assert.ok(result.historyReasons.includes('OUTSIDE_TRADING_SESSION'));
});

test('partial metadata verifies individual windows and whole-day or conflicting metadata cannot verify a window', () => {
  const morning = fixtureBar(6, 12), afternoon = fixtureBar(6, 14);
  const open = fixtureBar(6, 10), lunch = fixtureBar(6, 12, 30), close = fixtureBar(6, 16, 30);
  const verifiedMorning = period(open, lunch);
  const partial = shape([morning, afternoon], [[verifiedMorning]], '60m');
  assert.equal(partial.provenance.sessionStatus, 'SESSION_UNVERIFIED');
  assert.deepEqual(partial.history.map(row => row.sessionStatus), ['SESSION_VERIFIED', 'SESSION_UNVERIFIED']);
  assert.equal(partial.history[0].barCloseTime, lunch.time);
  assert.equal(partial.history[1].barCloseTime, afternoon.time + 3600000);

  const broad = shape([morning, fixtureBar(6, 13), afternoon], [[period(open, close)]], '60m');
  assert.deepEqual(broad.history.map(ohlcv), [morning, afternoon]);
  assert.ok(broad.history.every(row => row.sessionStatus === 'SESSION_UNVERIFIED'));
  const conflict = shape([morning, afternoon], [[verifiedMorning]], '60m', {
    currentTradingPeriod: { regular: period(open, fixtureBar(6, 12, 15)) }
  });
  assert.equal(conflict.history[0].sessionStatus, 'SESSION_UNVERIFIED');
  assert.equal(conflict.history[0].barCloseTime, morning.time + 3600000);
});

test('provider periods cannot make a weekend or reviewed holiday tradable', () => {
  const saturday = { ...fixtureBar(6, 10), time: Date.UTC(2026, 9, 24, 3) };
  const holiday = { ...saturday, time: saturday.time - 86400000 };
  const periods = [holiday, saturday].map(bar => [period(bar, { time: bar.time + 2 * 3600000 })]);
  const result = shape([holiday, saturday], periods);
  assert.equal(result.history.length, 0);
  assert.equal(result.rejectedBars, 2);
  assert.equal(result.provenance.sessionStatus, 'SESSION_UNVERIFIED');
});

test('within-session distribution permits skipped bars and excludes lunch and overnight gaps', () => {
  const rows = [fixtureBar(5, 10), fixtureBar(5, 10, 30), fixtureBar(5, 11, 30),
    fixtureBar(5, 14), fixtureBar(5, 15), fixtureBar(6, 10), fixtureBar(6, 10, 30)];
  const result = shape(rows, undefined);
  assert.deepEqual(result.history.map(ohlcv), rows);
  assert.deepEqual(result.provenance.cadence, { status: 'INTERVAL_CADENCE_VERIFIED', samples: 4,
    nativeGaps: 2, skippedGaps: 2, offGridGaps: 0, doubleGaps: 2, dailyLike: false });
});

test('systematic hourly cadence in a 30m response preserves source rows and withholds indicator signals', async () => {
  const rows = [5, 6].flatMap(date => [10, 11, 12, 14, 15, 16].map(hour => fixtureBar(date, hour)));
  const calls = [], market = await getService(calls, { mutate: (raw, call) => {
    if (call.visible) Object.assign(raw, payload('PTT.BK', '30m', rows, undefined));
  } }).getMarket(['PTT'], 'PTT', '1M');
  assert.deepEqual(market.history.map(ohlcv), rows);
  assert.equal(market.technicalMeta.history.cadence.status, 'INTERVAL_CADENCE_SUSPECT');
  assert.equal(market.technicalMeta.history.cadence.doubleGaps, 8);
  assert.equal(market.technicalMeta.history.cadence.nativeGaps, 0);
  assert.deepEqual(market.indicatorHistory, []);
  assert.deepEqual(market.levelsHistory, []);
  const snapshot = technicalSnapshot(market, '1M');
  assert.equal(snapshot.summary.actionable, false);
  assert.ok(snapshot.quality.warnings.includes('INTERVAL_MISMATCH'));
  assert.equal(calls.length, 3);
});

test('daily-looking timestamps cannot verify a native intraday cadence', () => {
  const rows = [2, 3, 4, 5, 6].map(date => fixtureBar(date, 10));
  const result = shape(rows, undefined);
  assert.equal(result.provenance.cadence.status, 'INTERVAL_CADENCE_SUSPECT');
  assert.equal(result.provenance.cadence.dailyLike, true);
  assert.ok(result.historyReasons.includes('INTERVAL_MISMATCH'));
});

test('a verified pause inside the trading window ends the bar without a cadence mismatch', () => {
  const rows = [fixtureBar(6, 10), fixtureBar(6, 10, 25), fixtureBar(6, 10, 55)];
  const periods = [[period(rows[0], fixtureBar(6, 10, 20)), period(rows[1], fixtureBar(6, 12, 30))]];
  const result = shape(rows, periods);
  assert.equal(result.history[0].barCloseTime, fixtureBar(6, 10, 20).time);
  assert.equal(result.provenance.sessionStatus, 'SESSION_VERIFIED');
  assert.equal(result.provenance.cadence.nativeGaps, 1);
  assert.equal(result.provenance.cadence.samples, 1);
});

test('invalid OHLCV rows cannot create false cadence evidence', () => {
  const rows = [fixtureBar(5, 10), { ...fixtureBar(5, 10, 15), volume: -1 }, fixtureBar(5, 10, 30)];
  const result = shape(rows, undefined);
  assert.equal(result.rejectedBars, 1);
  assert.equal(result.provenance.cadence.status, 'INTERVAL_CADENCE_VERIFIED');
  assert.equal(result.provenance.cadence.nativeGaps, 1);
});
