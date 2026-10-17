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
