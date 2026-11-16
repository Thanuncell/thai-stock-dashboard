'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketDataGuard } = require('../server/data-guard');
const { PERIODS, createMarketService } = require('../server/market-service');
const { intervalMs, temporalBars } = require('../lib/market-time');
const { barsBetween, payload, received, responder } = require('./fixtures/chart-candle-density.cjs');

let technical;
test.before(async () => { technical = await import('../client/technical.mjs'); });
const getService = (calls, options = {}) => createMarketService({ env: {}, now: () => options.observedAt ?? received,
  fetchImpl: responder(calls, options) });
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
    assert.equal(market.technicalMeta.history.cadence, undefined);
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

for (const range of ['1M', '3M']) {
  for (const [state, observedAt] of [['REGULAR', received], ['CLOSED', received + 3600000]]) {
    for (const missing of [['dataGranularity'], ['exchangeTimezoneName'], ['dataGranularity', 'exchangeTimezoneName']]) {
      test(`${range} ${state} retains verified OHLCV when ${missing.join('/')} is absent`, async () => {
        const calls = [], options = { observedAt, mutate: (raw, call) => {
          raw.meta.marketState = state;
          if (call.visible || call.warmup) for (const key of missing) delete raw.meta[key];
        } };
        const expectedCalls = [], expected = await getService(expectedCalls, { observedAt,
          mutate: raw => { raw.meta.marketState = state; }
        }).getMarket(['PTT'], 'PTT', range);
        const market = await getService(calls, options).getMarket(['PTT'], 'PTT', range);
        assert.ok(market.history.length > 100);
        assert.deepEqual(market.history, expected.history);
        assert.deepEqual(market.indicatorHistory, expected.indicatorHistory);
        assert.deepEqual(market.levelsHistory, expected.levelsHistory);
        assert.deepEqual(market.errors, []);
        assert.equal(market.dataState, 'delayed');
        assert.equal(market.technicalMeta.history.cadence, undefined);
        assert.equal(market.history.at(-1).complete, state === 'CLOSED');
        assert.deepEqual(calls, expectedCalls, 'metadata recovery adds no requests or warm-up changes');
        const snapshot = technicalSnapshot(market, range), baseline = technicalSnapshot(expected, range);
        assert.deepEqual(snapshot.signalSeries, baseline.signalSeries);
        assert.deepEqual(snapshot.signalReference, baseline.signalReference);
        if (state === 'REGULAR') {
          const changed = structuredClone(market);
          for (const key of ['history', 'indicatorHistory', 'levelsHistory']) Object.assign(changed[key].at(-1), {
            open: 600, high: 700, low: 500, close: 650, volume: 99999
          });
          const replay = technicalSnapshot(changed, range);
          assert.notDeepEqual(replay.series, snapshot.series, 'price overlays retain provisional prices');
          for (const key of ['signalSeries', 'signalReference', 'summary', 'analysis', 'levels']) {
            assert.deepEqual(replay[key], snapshot[key], `provisional candle cannot change ${key}`);
          }
        }
      });
    }
  }


  test(range + ' uses the standard guard when granularity or timezone metadata conflicts', async () => {
    for (const meta of [
      { dataGranularity: '1d' }, { dataGranularity: '15m' }, { dataGranularity: '5m' },
      { dataGranularity: false }, { dataGranularity: 0 }, { dataGranularity: [] }, { dataGranularity: {} },
      { dataGranularity: range === '1M' ? '60m' : '30m' },
      { exchangeTimezoneName: 'UTC' }, { exchangeTimezoneName: 'Invalid/Zone' },
      { exchangeTimezoneName: false }
    ]) {
      const calls = [], market = await getService(calls, { mutate: (raw, call) => {
        if (call.visible || call.warmup) Object.assign(raw.meta, meta);
      } }).getMarket(['PTT'], 'PTT', range);
      const visible = calls.find(call => call.visible);
      assert.deepEqual(market.history.map(ohlcv), barsBetween(visible.start, visible.end, PERIODS[range][1]).rows);
      assert.deepEqual(market.indicatorHistory.slice(-market.history.length), market.history);
      assert.deepEqual(market.errors, []);
      assert.equal(market.dataState, 'delayed');
      assert.equal(market.technicalMeta.history.interval, PERIODS[range][1]);
      assert.equal(market.technicalMeta.history.cadence, undefined);
      assert.ok(calls.every(call => call.visible || call.warmup ? call.interval === PERIODS[range][1] : true));
    }
  });

  test(range + ' preserves sparse and irregular OHLCV without inferring cadence', () => {
    const interval = PERIODS[range][1], duration = intervalMs(interval);
    const first = fixtureBar(5, 10), afternoon = fixtureBar(5, 14), nextDay = fixtureBar(6, 10);
    const after = (bar, steps) => ({ ...bar, time: bar.time + steps * duration });
    for (const rows of [
      [first], [first, after(first, 1)], [first, after(first, 2)],
      [first, after(first, 0.5), after(first, 1)],
      [first, after(first, 1), nextDay],
      [first, after(first, 1), afternoon, after(afternoon, 2)],
      [first, after(first, 1), afternoon, after(afternoon, 1)],
      [2, 3, 4, 5, 6].map(date => fixtureBar(date, 10))
    ]) {
      for (const granularity of [undefined, null, '', interval]) {
        const raw = payload('PTT.BK', granularity, rows, undefined);
        delete raw.meta.exchangeTimezoneName;
        const result = getService([]).shapeChart(raw, 'PTT', 'chart:review:' + interval);
        assert.deepEqual(result.history.map(ohlcv), rows);
        assert.equal(result.provenance.cadence, undefined);
        assert.ok(!result.historyReasons.includes('INTERVAL_MISMATCH'));
        assert.equal(result.historyStatus, 'usable');
      }
    }
  });

  test(range + ' keeps one/two/three/forty bars visible and warms up on the native interval', async () => {
    for (const count of [1, 2, 3, 40]) {
      const calls = [], market = await getService(calls, { visibleLimit: count, mutate: (raw, call) => {
        if (call.visible || call.warmup) {
          delete raw.meta.dataGranularity;
          delete raw.meta.exchangeTimezoneName;
        }
      } }).getMarket(['PTT'], 'PTT', range);
      assert.equal(market.history.length, count);
      assert.equal(market.candleCount, count);
      assert.equal(market.candleTargetMet, false);
      assert.deepEqual(market.errors, []);
      assert.equal(calls.filter(call => call.warmup).length, 1);
      assert.equal(calls.at(-1).interval, PERIODS[range][1]);
      assert.deepEqual(market.indicatorHistory.slice(-count), market.history);
      assert.ok(market.indicatorHistory.length > 200);
      assert.equal(technicalSnapshot(market, range).availability.ema200.state, 'available');
    }
  });

  test(range + ' keeps shared OHLCV/timestamp filtering without special session or volume requirements', () => {
    const interval = PERIODS[range][1];
    const rows = [
      { ...fixtureBar(5, 10), time: null },
      { ...fixtureBar(5, 11), high: 98 },
      { ...fixtureBar(5, 12), volume: -1 },
      { ...fixtureBar(5, 13), volume: null },
      { ...fixtureBar(5, 14), volume: undefined },
      { ...fixtureBar(5, 15), volume: '' },
      fixtureBar(5, 16), fixtureBar(5, 16),
      { ...fixtureBar(6, 10), time: received + 3600000 },
      { ...fixtureBar(6, 11), time: fixtureBar(6, 11).time + 0.5 },
      fixtureBar(6, 12)
    ];
    const raw = payload('PTT.BK', undefined, rows, undefined);
    delete raw.meta.exchangeTimezoneName;
    delete raw.meta.regularMarketTime;
    const standard = createMarketDataGuard({ now: () => received }).assess(raw, 'PTT').value;
    const shaped = getService([]).shapeChart(raw, 'PTT', 'chart:review:' + interval);
    assert.deepEqual(shaped.history.map(ohlcv), standard.history);
    assert.deepEqual(shaped.historyReasons, standard.historyReasons);
    assert.equal(shaped.rejectedBars, 6);
    for (const reason of ['INVALID_TIMESTAMP', 'INVALID_OHLC', 'NEGATIVE_VOLUME', 'DUPLICATE_TIMESTAMP', 'FUTURE_TIMESTAMP']) {
      assert.ok(shaped.historyReasons.includes(reason), reason);
    }
    assert.ok(shaped.history.some(bar => bar.time % 1 !== 0), 'no extra timestamp precision rejection');
    assert.equal(shaped.history.filter(bar => bar.volume === null).length, 3);
  });

  test(range + ' rejects invalid OHLC bars with the shared guard when metadata is missing', async () => {
    const calls = [], market = await getService(calls, { mutate: (raw, call) => {
      if (!call.visible) return;
      delete raw.meta.dataGranularity;
      delete raw.meta.exchangeTimezoneName;
      const quote = raw.indicators.quote[0];
      quote.high = quote.low.map(low => low - 1);
    } }).getMarket(['PTT'], 'PTT', range);
    assert.deepEqual(market.history, []);
    assert.deepEqual(market.indicatorHistory, []);
    assert.ok(market.technicalMeta.history.historyReasons.includes('INVALID_OHLC'));
    assert.equal(calls.length, 3);
  });

  test(range + ' does not add exchange-name requirements when timezone is absent', () => {
    const interval = PERIODS[range][1];
    const { rows, periods } = barsBetween(received - 86400000, received, interval);
    const assess = (meta, timezone) => {
      const raw = payload('PTT.BK', interval, rows, periods);
      Object.assign(raw.meta, { exchangeTimezoneName: timezone, ...meta });
      return getService([]).shapeChart(raw, 'PTT', 'chart:review:' + interval);
    };
    for (const meta of [
      { exchangeName: 'SET', fullExchangeName: 'Thailand' },
      { exchangeName: 'SET' }, { exchangeName: 'BKK' },
      { exchangeName: undefined, fullExchangeName: 'Thailand' },
      { exchangeName: undefined, fullExchangeName: 'Stock Exchange of Thailand' },
      { exchangeName: ' set ', fullExchangeName: ' thailand ' },
      { exchangeName: 'SET Equity Market', fullExchangeName: 'The Stock Exchange of Thailand' },
      { exchangeName: undefined, fullExchangeName: 'The Stock Exchange of Thailand' },
      { exchangeName: 'Thailand Stock Exchange' },
      { exchangeName: undefined, fullExchangeName: undefined },
      { currency: undefined }, { symbol: undefined }
    ]) {
      const expected = assess(meta, 'Asia/Bangkok');
      assert.deepEqual(expected.history.map(ohlcv), rows);
      for (const missing of [undefined, null, '']) {
        assert.deepEqual(assess(meta, missing), expected, JSON.stringify(meta));
      }
    }
  });

  test(range + ' retains shared Data Guard identity/market rejection and its existing name-format limitation', () => {
    const interval = PERIODS[range][1];
    const { rows, periods } = barsBetween(received - 86400000, received, interval);
    for (const [meta, code] of [
      [{ symbol: 'MSFT' }, 'SYMBOL_MISMATCH'],
      [{ currency: 'USD' }, 'MARKET_MISMATCH'],
      [{ exchangeName: 'NASDAQ' }, 'MARKET_MISMATCH'],
      // These names describe the Thai market, but the unchanged shared guard
      // does not recognize them. Record that limitation without adding a gate.
      [{ exchangeName: 'Bangkok' }, 'MARKET_MISMATCH'],
      [{ exchangeName: undefined, fullExchangeName: 'ตลาดหลักทรัพย์แห่งประเทศไทย' }, 'MARKET_MISMATCH']
    ]) {
      for (const timezone of ['Asia/Bangkok', undefined, null, '']) {
        const raw = payload('PTT.BK', interval, rows, periods);
        Object.assign(raw.meta, { exchangeTimezoneName: timezone, ...meta });
        assert.throws(() => getService([]).shapeChart(raw, 'PTT', 'chart:review:' + interval),
          error => error.code === code, JSON.stringify({ meta, timezone }));
      }
    }
  });

  test(range + ' preserves quotes and isolates provider failure without retries or substitution', async () => {
    for (const status of [403, 429, 503, 'no-data']) {
      const calls = [], market = await getService(calls, { mutate: (raw, call) => {
        if (!call.visible) return;
        return status === 'no-data'
          ? { ok: true, json: async () => ({ chart: { error: { code: 'Not Found' }, result: null } }) }
          : { ok: false, status };
      } }).getMarket(['PTT'], 'PTT', range);
      assert.deepEqual(market.history, []);
      assert.deepEqual(market.indicatorHistory, []);
      assert.equal(market.stocks.length, 1);
      assert.ok(market.stocks[0].history.length > 0);
      assert.equal(market.dataState, 'unavailable');
      assert.match(market.errors.join(' '), /SOURCE_DENIED|SOURCE_RATE_LIMITED|ACQUISITION_GAP|SOURCE_NO_DATA/);
      assert.equal(calls.length, 3);
    }
  });
}

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


test('all timeframes apply the same standard assessment to valid rows outside special session/range windows', () => {
  const rows = [
    { ...fixtureBar(6, 10), time: Date.UTC(2026, 9, 23, 3) },
    fixtureBar(1, 10), fixtureBar(6, 0, 1), fixtureBar(6, 9, 30),
    fixtureBar(6, 12, 30), fixtureBar(6, 13, 54), fixtureBar(6, 14)
  ].sort((a, b) => a.time - b.time);
  for (const interval of ['1m', '15m', '30m', '60m', '1d']) {
    const raw = payload('PTT.BK', undefined, rows, undefined);
    delete raw.meta.exchangeTimezoneName;
    const standard = createMarketDataGuard({ now: () => received }).assess(raw, 'PTT').value;
    const shaped = getService([]).shapeChart(raw, 'PTT', 'chart:review:' + interval, undefined,
      { start: fixtureBar(6, 14).time, end: received });
    assert.deepEqual(shaped.history.map(ohlcv), rows);
    assert.deepEqual(shaped.history.map(ohlcv), standard.history);
    assert.deepEqual(shaped.historyReasons, standard.historyReasons);
    assert.equal(shaped.rejectedBars, 0);
    for (const field of ['guardStatus', 'guardReasons', 'historyStatus', 'identityStatus', 'quoteStatus', 'dataState']) {
      assert.deepEqual(shaped[field], standard[field], field);
    }
  }
});

test('session metadata only annotates completion and never rejects provider OHLCV', () => {
  const morning = fixtureBar(6, 12), lunchBar = fixtureBar(6, 13), afternoon = fixtureBar(6, 14);
  const open = fixtureBar(6, 10), lunch = fixtureBar(6, 12, 30), close = fixtureBar(6, 16, 30);
  const partial = shape([morning, afternoon], [[period(open, lunch)]], '60m');
  assert.deepEqual(partial.history.map(ohlcv), [morning, afternoon]);
  assert.deepEqual(partial.history.map(row => row.sessionStatus), ['SESSION_VERIFIED', 'SESSION_UNVERIFIED']);
  assert.equal(partial.history[0].barCloseTime, lunch.time);
  assert.equal(partial.history[1].barCloseTime, afternoon.time + 3600000);
  const broad = shape([morning, lunchBar, afternoon], [[period(open, close)]], '60m');
  assert.deepEqual(broad.history.map(ohlcv), [morning, lunchBar, afternoon]);
  assert.ok(broad.history.every(row => row.sessionStatus === 'SESSION_UNVERIFIED'));
  const conflict = shape([morning, afternoon], [[period(open, lunch)]], '60m', {
    currentTradingPeriod: { regular: period(open, fixtureBar(6, 12, 15)) }
  });
  assert.deepEqual(conflict.history.map(ohlcv), [morning, afternoon]);
  assert.equal(conflict.history[0].sessionStatus, 'SESSION_UNVERIFIED');
  assert.equal(conflict.history[0].barCloseTime, morning.time + 3600000);
});

test('provider session end still confirms a shortened provisional candle at the exact boundary', () => {
  const rows = [fixtureBar(6, 10), fixtureBar(6, 10, 25), fixtureBar(6, 10, 55)];
  const end = fixtureBar(6, 10, 20);
  const periods = [[period(rows[0], end), period(rows[1], fixtureBar(6, 12, 30))]];
  for (const interval of ['30m', '60m']) {
    const raw = payload('PTT.BK', interval, rows.slice(0, 1), periods);
    const timed = observedAt => getService([], { observedAt }).shapeChart(raw, 'PTT', 'chart:review:' + interval).history;
    assert.equal(timed(end.time - 1)[0].complete, false);
    assert.equal(timed(end.time)[0].barCloseTime, end.time);
    assert.equal(timed(end.time)[0].confirmationBasis, 'provider-session-end');
    assert.equal(timed(end.time)[0].complete, true);
    assert.deepEqual(shape(rows, periods, interval).history.map(ohlcv), rows);
  }
});

test('sparse alternate cadence no longer withholds same-interval indicators or warm-up', async () => {
  for (const range of ['1M', '3M']) {
    const rows = [5, 6].flatMap(date => [10, 11, 12, 14, 15, 16].map(hour => fixtureBar(date, hour)));
    const calls = [], market = await getService(calls, { mutate: (raw, call) => {
      if (call.visible) Object.assign(raw, payload('PTT.BK', undefined, rows, undefined));
    } }).getMarket(['PTT'], 'PTT', range);
    assert.deepEqual(market.history.map(ohlcv), rows);
    assert.equal(market.technicalMeta.history.cadence, undefined);
    assert.deepEqual(market.indicatorHistory.slice(-rows.length), market.history);
    assert.deepEqual(market.levelsHistory, market.indicatorHistory);
    assert.equal(calls.filter(call => call.warmup).length, 1);
    const snapshot = technicalSnapshot(market, range);
    assert.equal(snapshot.availability.ema200.state, 'available');
    assert.ok(!snapshot.quality.warnings.includes('INTERVAL_MISMATCH'));
  }
});
