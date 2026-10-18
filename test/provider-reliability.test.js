'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createMarketService } = require('../server/market-service');
const { createNewsService } = require('../server/news-service');
const { createSettradeService } = require('../server/settrade-service');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('every Yahoo chart request has a bounded abort signal', async () => {
  let requestInit;
  const service = createMarketService({
    fetchImpl: async (_url, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}] } }], error: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await service.yahooChart('PTT.BK', '1d', '5m');
  assert.ok(requestInit.signal instanceof AbortSignal);
  assert.equal(requestInit.signal.aborted, false);
});

test('coverage verification requests enough daily history to measure technical readiness', async () => {
  const now = Date.UTC(2026, 9, 18, 9);
  const day = 24 * 60 * 60;
  const timestamps = Array.from({ length: 31 }, (_, index) => Math.floor((now - (31 - index) * day * 1000) / 1000));
  const closes = timestamps.map((_, index) => 35 + index * 0.01);
  let requestedUrl;
  const service = createMarketService({
    now: () => now,
    fetchImpl: async input => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ chart: { result: [{
        meta: {
          symbol: 'PTT.BK', currency: 'THB', exchangeName: 'SET', marketState: 'CLOSED',
          regularMarketPrice: closes.at(-1), previousClose: closes.at(-2),
          regularMarketChange: closes.at(-1) - closes.at(-2),
          regularMarketChangePercent: (closes.at(-1) - closes.at(-2)) / closes.at(-2) * 100,
          regularMarketTime: Math.floor((now - 30 * 60 * 1000) / 1000)
        },
        timestamp: timestamps,
        indicators: { quote: [{
          open: closes, high: closes.map(value => value + 0.1), low: closes.map(value => value - 0.1),
          close: closes, volume: closes.map(() => 1000)
        }] }
      }], error: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await service.verifySymbol('PTT');
  assert.equal(requestedUrl.searchParams.get('range'), '3mo');
  assert.equal(requestedUrl.searchParams.get('interval'), '1d');
  assert.equal(result.symbolVerified, true);
  assert.equal(result.chartReady, true);
  assert.equal(result.technicalReady, true);
});

test('Yahoo chart shaping rejects incomplete candles and preserves missing volume', () => {
  const service = createMarketService();
  const shaped = service.shapeChart({
    meta: { regularMarketPrice: 35.25 },
    timestamp: [1, 2],
    indicators: { quote: [{
      open: [null, 35], high: [35.5, 35.5], low: [34.75, 34.75], close: [35.25, 35.25], volume: [1000, null]
    }] }
  }, 'PTT');

  assert.equal(shaped.history.length, 1);
  assert.equal(shaped.history[0].time, 2_000);
  assert.equal(shaped.history[0].volume, null);
});

test('quarantined anomaly cannot overwrite last-known-good or feed Technical Analysis', async () => {
  let anomalyMode = false;
  const now = Date.UTC(2026, 9, 18, 9);
  const service = createMarketService({
    now: () => now,
    fetchImpl: async input => {
      const url = String(input);
      const isIndex = /%5ESET\.BK|\^SET\.BK/.test(url);
      const last = !isIndex && anomalyMode ? 80 : 35.25;
      const symbol = isIndex ? '^SET.BK' : 'PTT.BK';
      return new Response(JSON.stringify({ chart: { result: [{
        meta: {
          symbol,
          currency: 'THB',
          exchangeName: 'SET',
          marketState: 'CLOSED',
          regularMarketPrice: last,
          chartPreviousClose: 35,
          regularMarketTime: Math.floor((now - 15 * 60 * 1000) / 1000)
        },
        timestamp: [Math.floor((now - 15 * 60 * 1000) / 1000)],
        indicators: { quote: [{ open: [35], high: [35.5], low: [34.75], close: [35.25], volume: [1000] }] }
      }], error: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const first = await service.getMarket(['PTT'], 'PTT', '1D');
  anomalyMode = true;
  const second = await service.getMarket(['PTT'], 'PTT', '1D');
  assert.equal(first.stocks[0].last, 35.25);
  assert.equal(second.stocks[0].last, 35.25);
  assert.equal(second.stocks[0].stale, true);
  assert.equal(second.stocks[0].fallbackFromLastKnown, true);
  assert.equal(second.dataState, 'stale');
  assert.equal(second.stale, true);
  assert.deepEqual(second.indicatorHistory, []);
  assert.deepEqual(second.levelsHistory, []);
});

test('a guarded index identity failure does not wipe a valid selected stock', async () => {
  const now = Date.UTC(2026, 9, 18, 9);
  const service = createMarketService({
    now: () => now,
    fetchImpl: async input => {
      const isIndex = /%5ESET\.BK|\^SET\.BK/.test(String(input));
      return new Response(JSON.stringify({ chart: { result: [{
        meta: {
          symbol: isIndex ? 'AOT.BK' : 'PTT.BK',
          currency: 'THB',
          exchangeName: 'SET',
          marketState: 'CLOSED',
          regularMarketPrice: 35.25,
          chartPreviousClose: 35,
          regularMarketTime: Math.floor((now - 15 * 60 * 1000) / 1000)
        },
        timestamp: [Math.floor((now - 15 * 60 * 1000) / 1000)],
        indicators: { quote: [{ open: [35], high: [35.5], low: [34.75], close: [35.25], volume: [1000] }] }
      }], error: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const market = await service.getMarket(['PTT'], 'PTT', '1D');
  assert.equal(market.stocks[0].symbol, 'PTT');
  assert.deepEqual(market.indices, []);
  assert.equal(market.partial, true);
  assert.ok(market.errors.some(error => error.includes('SYMBOL_MISMATCH')));
});

test('a rejected selected range never masquerades as chart data for that range', async () => {
  const now = Date.UTC(2026, 9, 18, 9);
  const service = createMarketService({
    now: () => now,
    fetchImpl: async input => {
      const url = String(input);
      const isIndex = /%5ESET\.BK|\^SET\.BK/.test(url);
      const wrongRange = url.includes('interval=1m');
      const symbol = isIndex ? '^SET.BK' : wrongRange ? 'AOT.BK' : 'PTT.BK';
      return new Response(JSON.stringify({ chart: { result: [{
        meta: {
          symbol,
          currency: 'THB',
          exchangeName: 'SET',
          marketState: 'CLOSED',
          regularMarketPrice: 35.25,
          chartPreviousClose: 35,
          regularMarketTime: Math.floor((now - 15 * 60 * 1000) / 1000)
        },
        timestamp: [Math.floor((now - 15 * 60 * 1000) / 1000)],
        indicators: { quote: [{ open: [35], high: [35.5], low: [34.75], close: [35.25], volume: [1000] }] }
      }], error: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const market = await service.getMarket(['PTT'], 'PTT', '1D');
  assert.deepEqual(market.history, []);
  assert.deepEqual(market.indicatorHistory, []);
  assert.deepEqual(market.levelsHistory, []);
  assert.equal(market.dataState, 'unavailable');
  assert.ok(market.errors.some(error => error.includes('SYMBOL_MISMATCH')));
});

test('every Google News feed request has a bounded abort signal', async () => {
  const requestSignals = [];
  const service = createNewsService({
    fetchImpl: async (_url, init) => {
      requestSignals.push(init.signal);
      return new Response('<rss><channel></channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    }
  });

  await service.getNews();
  assert.ok(requestSignals.length > 0);
  assert.ok(requestSignals.every(signal => signal instanceof AbortSignal && !signal.aborted));
});

test('partial SETTRADE refresh never relabels prior fields with a new timestamp', async () => {
  let round = 1;
  const response = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
  const service = createSettradeService({
    fetchImpl: async input => {
      const url = String(input);
      if (round === 2 && url.includes('/market-summary/overview')) throw Error('overview timeout');
      if (url.includes('/market-summary/overview')) return response(fixture('settrade-overview.html'));
      if (url.includes('/nvdr/value')) return response(fixture('settrade-nvdr.html'));
      if (url.includes('/historical-report/investor-type')) return response(fixture('settrade-foreign.html'));
      return response('<div></div>');
    }
  });

  const first = await service.getOverview(true);
  assert.ok(first.value.indices.length > 0);
  round = 2;
  const partial = await service.getOverview(true);

  assert.deepEqual(partial.value.indices, []);
  assert.equal(partial.value.dataState, 'partial');
  assert.equal(partial.value.partial, true);
  assert.ok(partial.value.errors.some(error => error.includes('/market-summary/overview')));
});
