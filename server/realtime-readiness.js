'use strict';

const PROVIDER_METHODS = Object.freeze(['getLatestPrice', 'getChart', 'getMarketSnapshot']);
const KIND_METHODS = Object.freeze({
  latestPrice: 'getLatestPrice',
  chart: 'getChart',
  marketSnapshot: 'getMarketSnapshot'
});

class CapacityError extends Error {
  constructor() {
    super('Realtime readiness capacity limit reached');
    this.name = 'CapacityError';
    this.code = 'REALTIME_CAPACITY_LIMIT';
  }
}

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function readRealtimeFlags(env = {}) {
  const realtimeReady = enabled(env.REALTIME_READY);
  return {
    realtimeReady,
    realtimeEnabled: realtimeReady && enabled(env.REALTIME_ENABLED)
  };
}

function normalizedText(value, fallback = null) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizedAsOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeProviderResult(payload, defaults = {}) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const declaredState = normalizedText(input.dataState, '').toLowerCase();
  const asOf = normalizedAsOf(input.asOf);
  const stale = Boolean(input.stale) || declaredState === 'stale';
  const partial = Boolean(input.partial) || declaredState === 'partial';
  const delayed = Boolean(input.delayed) || declaredState === 'delayed';
  let dataState = 'unknown';
  if (declaredState === 'unavailable') dataState = 'unavailable';
  else if (stale) dataState = 'stale';
  else if (partial) dataState = 'partial';
  else if (delayed) dataState = 'delayed';
  else if (asOf) dataState = 'fresh';

  return {
    ...input,
    provider: normalizedText(input.provider, normalizedText(defaults.provider)),
    source: normalizedText(input.source, normalizedText(defaults.source, normalizedText(defaults.provider))),
    asOf,
    marketState: normalizedText(input.marketState, 'UNKNOWN'),
    delayed,
    stale,
    partial,
    dataState
  };
}

function normalizeSymbol(value) {
  return normalizedText(value, '').toUpperCase();
}

function normalizeSymbols(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeSymbol).filter(Boolean);
}

function createPublicRequest(kind, scope = {}) {
  if (!Object.hasOwn(KIND_METHODS, kind)) throw new TypeError(`Unsupported realtime data kind: ${kind}`);
  const input = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
  if (kind === 'latestPrice') {
    return { symbol: normalizeSymbol(input.symbol) };
  }
  if (kind === 'chart') {
    return {
      symbol: normalizeSymbol(input.symbol),
      range: normalizedText(input.range, ''),
      interval: normalizedText(input.interval, '')
    };
  }
  return {
    market: normalizeSymbol(input.market),
    symbols: normalizeSymbols(input.symbols),
    active: normalizeSymbol(input.active),
    range: normalizedText(input.range, '')
  };
}

function createLatestDataKey(kind, scope = {}) {
  return `${kind}:${JSON.stringify(createPublicRequest(kind, scope))}`;
}

function createLatestDataStore({ maxEntries = 200 } = {}) {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, 1000) : 200;
  const entries = new Map();

  function get(key) {
    if (!entries.has(key)) return null;
    const value = entries.get(key);
    entries.delete(key);
    entries.set(key, value);
    return value;
  }

  function set(key, value) {
    if (typeof key !== 'string' || !key || !value || typeof value !== 'object') {
      throw new TypeError('Latest-data store requires a key and object value');
    }
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  return Object.freeze({
    get,
    set,
    delete(key) { return entries.delete(key); },
    clear() { entries.clear(); },
    size() { return entries.size; }
  });
}

function createFanoutBoundary({ publish = async () => {} } = {}) {
  if (typeof publish !== 'function') throw new TypeError('Fanout boundary requires a publish function');
  return Object.freeze({ publish });
}

function createRealtimeProvider({ name, source = name, getLatestPrice, getChart, getMarketSnapshot } = {}) {
  const provider = {
    name: normalizedText(name),
    source: normalizedText(source, normalizedText(name)),
    getLatestPrice,
    getChart,
    getMarketSnapshot
  };
  if (!provider.name || PROVIDER_METHODS.some(method => typeof provider[method] !== 'function')) {
    throw new TypeError('Realtime providers require a name and latest-price, chart and market-snapshot methods');
  }
  return Object.freeze(provider);
}

function createDelayedMarketProvider(marketService) {
  if (!marketService || typeof marketService.getMarket !== 'function') {
    throw new TypeError('Delayed market adapter requires a market service');
  }

  async function snapshot(request = {}) {
    const symbols = normalizeSymbols(request.symbols);
    const active = normalizeSymbol(request.active || request.symbol || symbols[0]);
    const scopedSymbols = symbols.length ? [...symbols] : (active ? [active] : []);
    if (active && !scopedSymbols.includes(active)) scopedSymbols.push(active);
    return marketService.getMarket(scopedSymbols, active, normalizedText(request.range, '1D'));
  }

  return createRealtimeProvider({
    name: 'Yahoo Finance',
    source: 'Yahoo Finance',
    async getLatestPrice(request = {}) {
      const result = await snapshot({ symbol: request.symbol, range: '1D' });
      const symbol = normalizeSymbol(request.symbol);
      const stock = result.stocks?.find(item => normalizeSymbol(item.symbol) === symbol) || {};
      return {
        ...stock,
        provider: result.provider,
        source: result.source,
        asOf: result.asOf,
        marketState: stock.marketState,
        delayed: result.delayed,
        stale: result.stale,
        partial: result.partial,
        dataState: result.dataState
      };
    },
    async getChart(request = {}) {
      const result = await snapshot(request);
      return {
        symbol: normalizeSymbol(request.symbol),
        history: result.history,
        provider: result.provider,
        source: result.source,
        asOf: result.asOf,
        delayed: result.delayed,
        stale: result.stale,
        partial: result.partial,
        dataState: result.dataState
      };
    },
    getMarketSnapshot: snapshot
  });
}

function createCapacityGuard(maxInFlight) {
  const limit = Number.isInteger(maxInFlight) && maxInFlight > 0 ? Math.min(maxInFlight, 100) : 8;
  let active = 0;

  async function run(action) {
    if (active >= limit) throw new CapacityError();
    active += 1;
    try { return await action(); }
    finally { active -= 1; }
  }

  return Object.freeze({ run, active: () => active, limit });
}

function unavailableResult(meta = {}) {
  return {
    value: normalizeProviderResult({ dataState: 'unavailable', asOf: null }),
    meta: { resolution: 'unavailable', ...meta }
  };
}

function createRealtimeReadiness({
  env = process.env,
  liveProvider = null,
  delayedProvider = null,
  store = createLatestDataStore(),
  fanout = createFanoutBoundary(),
  maxInFlight = 8
} = {}) {
  const flags = Object.freeze(readRealtimeFlags(env));
  const capacity = createCapacityGuard(maxInFlight);
  const pending = new Map();

  async function resolveProvider(provider, kind, method, request, resolution, key) {
    const payload = await provider[method](request);
    const value = normalizeProviderResult(payload, { provider: provider.name, source: provider.source });
    if (value.dataState === 'unavailable') return null;
    store.set(key, value);
    let fanoutFailed = false;
    if (flags.realtimeEnabled && fanout && typeof fanout.publish === 'function') {
      try { await fanout.publish({ kind, key, value }); }
      catch (_) { fanoutFailed = true; }
    }
    return { value, meta: { resolution, fanoutFailed } };
  }

  async function resolveFallback(kind, method, request, key) {
    const failures = [];
    if (flags.realtimeEnabled && liveProvider) {
      try {
        const live = await resolveProvider(liveProvider, kind, method, request, 'live-provider', key);
        if (live) return live;
        failures.push('live-provider-unavailable');
      } catch (_) { failures.push('live-provider-failed'); }
    }
    if (delayedProvider) {
      try {
        const delayed = await resolveProvider(delayedProvider, kind, method, request, 'delayed-provider', key);
        if (delayed) return delayed;
        failures.push('delayed-provider-unavailable');
      } catch (_) { failures.push('delayed-provider-failed'); }
    }

    const previous = store.get(key);
    if (previous) {
      return {
        value: normalizeProviderResult({ ...previous, stale: true, dataState: 'stale' }),
        meta: { resolution: 'last-known', failures }
      };
    }
    return unavailableResult({ failures });
  }

  function read(kind, request = {}) {
    const method = KIND_METHODS[kind];
    const publicRequest = createPublicRequest(kind, request);
    const key = createLatestDataKey(kind, publicRequest);
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve()
      .then(() => capacity.run(() => resolveFallback(kind, method, publicRequest, key)))
      .catch(error => {
        if (!(error instanceof CapacityError)) throw error;
        const previous = store.get(key);
        if (previous) {
          return {
            value: normalizeProviderResult({ ...previous, stale: true, dataState: 'stale' }),
            meta: { resolution: 'last-known', capacityLimited: true }
          };
        }
        return unavailableResult({ capacityLimited: true });
      });
    pending.set(key, task);
    task.then(() => pending.delete(key), () => pending.delete(key));
    return task;
  }

  return Object.freeze({
    flags,
    getLatestPrice: request => read('latestPrice', request),
    getChart: request => read('chart', request),
    getMarketSnapshot: request => read('marketSnapshot', request),
    pendingSize: () => pending.size,
    activeRequests: () => capacity.active(),
    capacityLimit: capacity.limit
  });
}

module.exports = {
  CapacityError,
  PROVIDER_METHODS,
  createFanoutBoundary,
  createLatestDataKey,
  createLatestDataStore,
  createDelayedMarketProvider,
  createPublicRequest,
  createRealtimeProvider,
  createRealtimeReadiness,
  normalizeProviderResult,
  readRealtimeFlags
};
