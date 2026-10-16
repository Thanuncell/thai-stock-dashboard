'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyseTechnicals,
  computeEma,
  computeSmaSeries,
  createRequestSequence,
  findPriceLevels
} = require('../lib/indicators');

test('a slower stale response cannot overwrite the newest request state', async () => {
  const sequence = createRequestSequence();
  const applied = [];
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });

  const run = async (value, pending) => {
    const requestId = sequence.begin();
    const result = await pending;
    if (!sequence.isCurrent(requestId)) return;
    applied.push({ value, result });
  };

  const requestA = run('A', slow);
  const requestB = run('B', Promise.resolve('newer'));
  await requestB;
  releaseSlow('older');
  await requestA;

  assert.deepEqual(applied, [{ value: 'B', result: 'newer' }]);
});

test('SMA and EMA preserve the current warm-up contract', () => {
  assert.deepEqual(computeSmaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(computeEma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('technical analysis keeps insufficient history unavailable', () => {
  const bars = Array.from({ length: 29 }, (_, index) => ({ close: index + 1 }));
  assert.equal(analyseTechnicals(bars), null);
});

test('technical analysis produces finite RSI, SMA, EMA and MACD values', () => {
  const bars = Array.from({ length: 80 }, (_, index) => ({
    time: Date.UTC(2026, 0, index + 1),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 1_000 + index
  }));
  const result = analyseTechnicals(bars);

  assert.ok(result);
  assert.equal(result.rsi, 100);
  assert.equal(result.sma20, 170.5);
  assert.ok(Number.isFinite(result.emas.ema20));
  assert.ok(Number.isFinite(result.emas.ema50));
  assert.ok(Number.isFinite(result.macd));
  assert.ok(Number.isFinite(result.macdSignal));
  assert.equal(result.emas.ema100, null);
  assert.equal(result.emas.ema200, null);
  assert.equal(result.signals.rsi, 'ขาย');
});

test('invalid market rows never become chart or indicator values', () => {
  const bars = [
    ...Array.from({ length: 35 }, (_, index) => ({ close: 10 + index })),
    { close: null },
    { close: Number.NaN },
    { close: Number.POSITIVE_INFINITY },
    { close: 0 }
  ];
  const result = analyseTechnicals(bars);
  assert.equal(result.values.length, 35);
  assert.ok(result.values.every(Number.isFinite));
});

test('price levels reject missing last price instead of fabricating zero', () => {
  assert.deepEqual(findPriceLevels([], null), {
    supports: [], resistances: [], supportDetails: [], resistanceDetails: []
  });
});
