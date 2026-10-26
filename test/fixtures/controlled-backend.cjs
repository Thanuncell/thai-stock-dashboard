'use strict';
const assert = require('node:assert/strict');
const NOW = Date.parse('2026-10-26T10:00:00Z');

function backend({ symbols = ['PTT'], schemaReady = true } = {}) {
  const runs = new Map(), calls = [], registry = new Map(symbols.map(symbol => [symbol, {
    symbol, provider_symbol: symbol + '.BK', provider: 'Yahoo Finance', active: true, status: 'pending',
    symbol_verified: false, chart_ready: false, technical_ready: false, last_checked_at: null
  }]));
  let failApply = false, providerTime = NOW, price = 35;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET';
    calls.push({ url, method });
    if (url.hostname === 'query1.finance.yahoo.com') {
      const symbol = decodeURIComponent(url.pathname.split('/').pop());
      const times = Array.from({ length: 45 }, (_, i) => Math.floor(providerTime / 1000) - (44 - i) * 86400);
      return Response.json({ chart: { result: [{ meta: { symbol, currency: 'THB', regularMarketPrice: price,
        regularMarketTime: Math.floor(providerTime / 1000), previousClose: price, exchangeTimezoneName: 'Asia/Bangkok' },
      timestamp: times, indicators: { quote: [{ open: times.map(() => price), high: times.map(() => price + 1),
        low: times.map(() => price - 1), close: times.map(() => price), volume: times.map(() => 1000) }] } }], error: null } });
    }
    assert.equal(url.origin, 'https://fixture.supabase.co');
    if (url.pathname === '/auth/v1/user') return Response.json({id:'fixture-user'});
    if (url.pathname.endsWith('/coverage_runs')) {
      if (!schemaReady) return Response.json({ message: 'missing column' }, { status: 400 });
      if (method === 'POST') {
        assert.match(init.headers.Prefer, /resolution=ignore-duplicates/);
        const [payload] = JSON.parse(init.body);
        if (runs.has(payload.run_key)) return Response.json([]);
        runs.set(payload.run_key, structuredClone(payload));
        return Response.json([payload]);
      }
      const key = url.searchParams.get('run_key').slice(3), row = runs.get(key);
      if (method === 'PATCH') {
        if (!row || [...url.searchParams].some(([field, filter]) => {
          if (!field.startsWith('automation_state->>')) return false;
          return String(row.automation_state[field.split('->>')[1]]) !== filter.slice(3);
        })) return Response.json([]);
        Object.assign(row, JSON.parse(init.body));
      }
      return Response.json(row ? [row] : []);
    }
    assert.ok(url.pathname.endsWith('/security_coverage'));
    if (method === 'HEAD') return new Response(null, { headers: { 'content-range': '0-0/' + registry.size } });
    const symbol = url.searchParams.get('symbol')?.slice(3);
    if (method === 'PATCH') {
      if (failApply) throw Error('fixture lost DB response');
      const row = registry.get(symbol);
      Object.assign(row, JSON.parse(init.body));
      return Response.json([row]);
    }
    return Response.json(symbol ? [registry.get(symbol)].filter(Boolean) : [...registry.values()]);
  };
  return { fetchImpl, runs, calls, registry, failApply(value) { failApply = value; }, advance(time, value) { providerTime = time; price = value; } };
}

module.exports = { backend };
