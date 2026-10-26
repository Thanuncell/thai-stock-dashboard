'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createMarketDataGuard}=require('../server/data-guard');
const {createMarketService,PERIODS}=require('../server/market-service');
const NOW = Date.UTC(2026, 9, 25, 9);
function payload(price = 100, close = price, symbol = 'TEST.BK') {
  const t = NOW / 1000 - 900;
  return { meta: { symbol, currency: 'THB', exchangeName: 'SET', marketState: 'CLOSED', regularMarketPrice: price, previousClose: 100, regularMarketTime: t },
    timestamp: [t - 86400, t], indicators: { quote: [{ open: [100, close], high: [101, close + 1], low: [99, close - 1], close: [100, close], volume: [1, 1] }] } };
}
test('3% close disagreement and 40% price move preserve valid quote and every chart timeframe', async () => {
  for (const range of Object.keys(PERIODS)) {
    const guard = createMarketDataGuard({ now: () => NOW });
    guard.assess(payload(), 'TEST', { contextKey: range });
    for (const value of [payload(103, 100), payload(140, 140)]) {
      const result = guard.assess(value, 'TEST', { contextKey: range });
      assert.equal(result.guardStatus, 'suspect');
      assert.equal(result.value.last, value.meta.regularMarketPrice);
      assert.equal(result.value.history.length, 2);
      assert.equal(result.value.fallbackFromLastKnown, false);
    }
    const service = createMarketService({ now: () => NOW, fetchImpl: async input => {
      const symbol = decodeURIComponent(new URL(input).pathname.split('/').at(-1));
      return new Response(JSON.stringify({ chart: { result: [payload(103, 100, symbol)] } }));
    } });
    const market = await service.getMarket(['TEST'], 'TEST', range);
    assert.equal(market.history.length, 2);
    assert.equal(market.stocks[0].last, 103);
    assert.equal(market.dataState, 'suspect');
  }
});

test('invalid OHLC remains rejected while a healthy quote and remaining bars survive', () => {
  const value = payload();
  value.indicators.quote[0].high[0] = 50;
  const result = createMarketDataGuard({ now: () => NOW }).assess(value, 'TEST');
  assert.equal(result.value.last, 100);
  assert.equal(result.value.history.length, 1);
  assert.equal(result.value.rejectedBars, 1);
  assert.ok(result.value.historyReasons.includes('INVALID_OHLC'));
});

test('invalid quote numeric is isolated from healthy chart history', async () => {
  const value = payload();
  value.meta.regularMarketPrice = Infinity;
  const assessed = createMarketDataGuard({ now: () => NOW }).assess(value, 'TEST');
  assert.equal(assessed.value.last, null);
  assert.equal(assessed.value.quoteStatus, 'quarantined');
  assert.equal(assessed.value.historyStatus, 'usable');
  assert.equal(assessed.value.history.length, 2);
  assert.equal(assessed.value.dataState, 'partial');
  const service = createMarketService({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ chart: { result: [{ ...value, meta: { ...value.meta, regularMarketPrice: -1 } }] } })) });
  const readiness = await service.verifySymbol('TEST');
  assert.equal(readiness.quoteReady, false);
  assert.equal(readiness.chartReady, true);
  assert.equal(readiness.technicalReady, false);
});

test('weekend delayed EOD is usable; missing Technical history does not remove Chart', async () => {
  const service = createMarketService({ now: () => NOW, fetchImpl: async input => {
    const symbol = decodeURIComponent(new URL(input).pathname.split('/').at(-1));
    return new Response(JSON.stringify({ chart: { result: [payload(100, 100, symbol)] } }));
  } });
  assert.equal((await service.verifySymbol('TEST')).chartReady, true);
  assert.equal((await service.verifySymbol('TEST')).technicalReady, false);
  assert.equal((await service.getMarket(['TEST'], 'TEST', '1M')).history.length, 2);
});
