'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let analyseTechnicals;
let computeEma;
let computeSmaSeries;
let createRequestSequence;
let findPriceLevels;
let trustedMarketBars;

test.before(async () => {
  ({
    analyseTechnicals,
    computeEma,
    computeSmaSeries,
    createRequestSequence,
    findPriceLevels,
    trustedMarketBars
  } = await import('../client/domain.mjs'));
});

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

test('Technical Analysis rejects invalid OHLC and duplicate or out-of-order timestamps', () => {
  const valid = Array.from({ length: 35 }, (_, index) => ({
    time: 1_760_000_000_000 + index * 86_400_000,
    open: 10 + index,
    high: 12 + index,
    low: 9 + index,
    close: 11 + index,
    volume: 1_000
  }));
  const badTime = valid[10].time;
  const guarded = trustedMarketBars([
    ...valid,
    { time: badTime, open: 20, high: 22, low: 19, close: 21, volume: 100 },
    { time: valid[5].time - 1, open: 30, high: 20, low: 25, close: 28, volume: -1 }
  ]);
  assert.equal(guarded.length, 35);
  assert.ok(guarded.every((bar, index) => index === 0 || bar.time > guarded[index - 1].time));
  assert.equal(analyseTechnicals(guarded).values.length, 35);
});

test('Technical Analysis rejects explicitly suspect bars and sanitizes level history', () => {
  const valid = Array.from({ length: 35 }, (_, index) => ({
    time: 1_760_000_000_000 + index * 86_400_000,
    open: 10 + index,
    high: 12 + index,
    low: 9 + index,
    close: 11 + index,
    volume: 1_000
  }));
  const suspect = { ...valid[0], time: valid.at(-1).time + 86_400_000, close: 500, high: 510, guardStatus: 'suspect' };
  const invalidLevel = { time: suspect.time + 1, open: 50, high: 40, low: 45, close: 48, volume: -1 };
  const result = analyseTechnicals([...valid, suspect], [...valid, invalidLevel]);
  assert.equal(result.values.length, 35);
  assert.equal(result.last, valid.at(-1).close);
  assert.ok([...result.levels.supports, ...result.levels.resistances].every(value => value !== 48));
});

test('price levels reject missing last price instead of fabricating zero', () => {
  assert.deepEqual(findPriceLevels([], null), {
    supports: [], resistances: [], supportDetails: [], resistanceDetails: []
  });
});
