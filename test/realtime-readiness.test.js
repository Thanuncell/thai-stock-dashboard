'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFanoutBoundary,
  createLatestDataKey,
  createLatestDataStore,
  createDelayedMarketProvider,
  createRealtimeProvider,
  createRealtimeReadiness,
  normalizeProviderResult,
  readRealtimeFlags
} = require('../server/realtime-readiness');

function provider(name, handlers = {}) {
  const fallback = async () => { throw Error(`${name} unavailable`); };
  return createRealtimeProvider({
    name,
    source: name,
    getLatestPrice: handlers.getLatestPrice || fallback,
    getChart: handlers.getChart || fallback,
    getMarketSnapshot: handlers.getMarketSnapshot || fallback
  });
}

test('production realtime flags default OFF and readiness cannot implicitly enable delivery', () => {
  assert.deepEqual(readRealtimeFlags({}), { realtimeReady: false, realtimeEnabled: false });
  assert.deepEqual(readRealtimeFlags({ REALTIME_READY: 'true' }), { realtimeReady: true, realtimeEnabled: false });
  assert.deepEqual(readRealtimeFlags({ REALTIME_ENABLED: 'true' }), { realtimeReady: false, realtimeEnabled: false });
  assert.deepEqual(readRealtimeFlags({ REALTIME_READY: 'true', REALTIME_ENABLED: 'true' }), {
    realtimeReady: true,
    realtimeEnabled: true
  });
});

test('normalization preserves missing values and never fabricates freshness', () => {
  const value = normalizeProviderResult({ price: null, asOf: null }, {
    provider: 'Delayed fixture',
    source: 'fixture'
  });

  assert.equal(value.price, null);
  assert.equal(value.asOf, null);
  assert.equal(value.provider, 'Delayed fixture');
  assert.equal(value.source, 'fixture');
  assert.equal(value.marketState, 'UNKNOWN');
  assert.equal(value.delayed, false);
  assert.equal(value.stale, false);
  assert.equal(value.partial, false);
  assert.equal(value.dataState, 'unknown');
});

test('provider contract requires latest-price, chart and market-snapshot boundaries', () => {
  assert.throws(() => createRealtimeProvider({ name: 'incomplete' }), /require a name/);
  assert.equal(provider('complete').name, 'complete');
});

test('current delayed market service adapts to all provider methods without changing metadata', async () => {
  const calls = [];
  const delayed = createDelayedMarketProvider({
    async getMarket(symbols, active, range) {
      calls.push({ symbols, active, range });
      return {
        stocks: [{ symbol: active, last: null, time: null, marketState: 'CLOSED' }],
        history: [],
        provider: 'Yahoo Finance',
        source: 'Yahoo Finance',
        asOf: null,
        delayed: true,
        stale: false,
        partial: false,
        dataState: 'delayed'
      };
    }
  });

  const latest = await delayed.getLatestPrice({ symbol: 'ptt' });
  const chart = await delayed.getChart({ symbol: 'AOT', range: '1M' });
  const snapshot = await delayed.getMarketSnapshot({ symbols: ['PTT', 'AOT'], active: 'AOT', range: '1D' });

  assert.equal(latest.last, null);
  assert.equal(latest.asOf, null);
  assert.equal(latest.delayed, true);
  assert.deepEqual(chart.history, []);
  assert.equal(chart.asOf, null);
  assert.equal(snapshot.source, 'Yahoo Finance');
  assert.deepEqual(calls, [
    { symbols: ['PTT'], active: 'PTT', range: '1D' },
    { symbols: ['AOT'], active: 'AOT', range: '1M' },
    { symbols: ['PTT', 'AOT'], active: 'AOT', range: '1D' }
  ]);
});

test('latest-data store keys isolate request scope and remain bounded', () => {
  const store = createLatestDataStore({ maxEntries: 2 });
  const pttDay = createLatestDataKey('chart', { symbol: 'ptt', range: '1D' });
  const pttMonth = createLatestDataKey('chart', { symbol: 'PTT', range: '1M' });
  const aotDay = createLatestDataKey('chart', { symbol: 'AOT', range: '1D' });

  assert.notEqual(pttDay, pttMonth);
  assert.notEqual(pttDay, aotDay);
  store.set(pttDay, { asOf: '2026-10-18T00:00:00.000Z' });
  store.set(pttMonth, { asOf: '2026-10-18T00:01:00.000Z' });
  assert.equal(store.get(pttDay).asOf, '2026-10-18T00:00:00.000Z');
  store.set(aotDay, { asOf: '2026-10-18T00:02:00.000Z' });
  assert.equal(store.size(), 2);
  assert.equal(store.get(pttMonth), null);
  assert.equal(store.get(pttDay).asOf, '2026-10-18T00:00:00.000Z');
});

test('disabled realtime skips the live provider and fanout while retaining delayed fallback', async () => {
  let liveCalls = 0;
  let delayedCalls = 0;
  let publications = 0;
  const runtime = createRealtimeReadiness({
    env: { REALTIME_READY: 'true', REALTIME_ENABLED: 'false' },
    liveProvider: provider('Licensed live fixture', {
      getLatestPrice: async () => { liveCalls += 1; return { price: 35, asOf: '2026-10-18T03:00:00.000Z' }; }
    }),
    delayedProvider: provider('Delayed fixture', {
      getLatestPrice: async () => {
        delayedCalls += 1;
        return { price: 34.5, asOf: '2026-10-18T02:45:00.000Z', delayed: true };
      }
    }),
    fanout: { publish: async () => { publications += 1; } }
  });

  const result = await runtime.getLatestPrice({ symbol: 'PTT' });
  assert.equal(result.meta.resolution, 'delayed-provider');
  assert.equal(result.value.price, 34.5);
  assert.equal(result.value.dataState, 'delayed');
  assert.equal(liveCalls, 0);
  assert.equal(delayedCalls, 1);
  assert.equal(publications, 0);
});

test('enabled readiness publishes normalized live data only through the injected fanout boundary', async () => {
  const events = [];
  const providerRequests = [];
  const runtime = createRealtimeReadiness({
    env: { REALTIME_READY: 'true', REALTIME_ENABLED: 'true' },
    liveProvider: provider('Licensed live fixture', {
      getLatestPrice: async request => {
        providerRequests.push(request);
        return { price: 35, asOf: '2026-10-18T03:00:00.000Z', marketState: 'REGULAR' };
      }
    }),
    delayedProvider: provider('Delayed fixture'),
    fanout: createFanoutBoundary({ publish: async event => { events.push(event); } })
  });

  const result = await runtime.getLatestPrice({ symbol: 'PTT', accessToken: 'must-not-enter-key' });
  assert.equal(result.meta.resolution, 'live-provider');
  assert.equal(events.length, 1);
  assert.deepEqual(providerRequests, [{ symbol: 'PTT' }]);
  assert.equal(events[0].kind, 'latestPrice');
  assert.doesNotMatch(events[0].key, /accessToken|must-not-enter-key/);
  assert.equal(events[0].value.dataState, 'fresh');
});

test('fallback order is live, delayed, last-known, then explicitly unavailable', async () => {
  const store = createLatestDataStore();
  let liveFails = false;
  let delayedFails = false;
  const runtime = createRealtimeReadiness({
    env: { REALTIME_READY: 'true', REALTIME_ENABLED: 'true' },
    store,
    liveProvider: provider('Licensed live fixture', {
      getMarketSnapshot: async () => {
        if (liveFails) throw Error('live outage');
        return { index: 1300, asOf: '2026-10-18T03:00:00.000Z', marketState: 'REGULAR' };
      }
    }),
    delayedProvider: provider('Delayed fixture', {
      getMarketSnapshot: async () => {
        if (delayedFails) throw Error('delayed outage');
        return { index: 1298, asOf: '2026-10-18T02:45:00.000Z', delayed: true, partial: true };
      }
    })
  });

  const live = await runtime.getMarketSnapshot({ market: 'SET' });
  assert.equal(live.meta.resolution, 'live-provider');
  assert.equal(live.value.index, 1300);

  liveFails = true;
  const delayed = await runtime.getMarketSnapshot({ market: 'SET' });
  assert.equal(delayed.meta.resolution, 'delayed-provider');
  assert.equal(delayed.value.index, 1298);
  assert.equal(delayed.value.dataState, 'partial');

  delayedFails = true;
  const lastKnown = await runtime.getMarketSnapshot({ market: 'SET' });
  assert.equal(lastKnown.meta.resolution, 'last-known');
  assert.equal(lastKnown.value.index, 1298);
  assert.equal(lastKnown.value.asOf, '2026-10-18T02:45:00.000Z');
  assert.equal(lastKnown.value.stale, true);
  assert.equal(lastKnown.value.dataState, 'stale');

  const unavailable = await runtime.getMarketSnapshot({ market: 'MAI' });
  assert.equal(unavailable.meta.resolution, 'unavailable');
  assert.equal(unavailable.value.asOf, null);
  assert.equal(unavailable.value.dataState, 'unavailable');
  assert.equal(unavailable.value.index, undefined);
});

test('identical reads coalesce and capacity limits prevent request storms', async () => {
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = createRealtimeReadiness({
    env: {},
    maxInFlight: 1,
    delayedProvider: provider('Delayed fixture', {
      getChart: async request => {
        calls += 1;
        await gate;
        return { symbol: request.symbol, points: [], asOf: null, delayed: true };
      }
    })
  });

  const first = runtime.getChart({ symbol: 'PTT', range: '1D' });
  const duplicate = runtime.getChart({ range: '1D', symbol: 'PTT' });
  const overCapacity = await runtime.getChart({ symbol: 'AOT', range: '1D' });
  assert.equal(overCapacity.meta.resolution, 'unavailable');
  assert.equal(overCapacity.meta.capacityLimited, true);
  assert.equal(calls, 1);

  release();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.value.symbol, 'PTT');
  assert.strictEqual(firstResult, duplicateResult);
  assert.equal(calls, 1);
  assert.equal(runtime.pendingSize(), 0);
});
