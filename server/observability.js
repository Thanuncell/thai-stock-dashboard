'use strict';

const { randomUUID } = require('node:crypto');

const SAFE_FIELDS = Object.freeze([
  'requestId', 'method', 'route', 'provider', 'operation', 'durationMs', 'status',
  'cacheStatus', 'staleAgeMs', 'dataState', 'timedOut', 'coalesced'
]);

function providerFromUrl(input) {
  let hostname = '';
  try { hostname = new URL(String(input)).hostname.toLowerCase(); }
  catch (_) { return 'unknown'; }
  if (hostname.endsWith('supabase.co')) return 'Supabase';
  if (hostname.endsWith('finance.yahoo.com')) return 'Yahoo Finance';
  if (hostname === 'www.settrade.com') return 'SETTRADE';
  if (hostname === 'marketplace.set.or.th') return 'SET';
  if (hostname === 'news.google.com') return 'Google News';
  if (hostname === 'api.openai.com') return 'OpenAI';
  return 'external';
}

function operationFromUrl(input) {
  try { return new URL(String(input)).pathname.slice(0, 160); }
  catch (_) { return 'unknown'; }
}

function createObservability({ logger = console, now = Date.now, requestId = randomUUID } = {}) {
  const contexts = new WeakMap();

  function emit(event, fields = {}) {
    const record = { event };
    for (const key of SAFE_FIELDS) {
      if (fields[key] !== undefined && fields[key] !== null) record[key] = fields[key];
    }
    logger.info(JSON.stringify(record));
    return record;
  }

  function startRequest(req, res, route) {
    const context = {
      requestId: requestId(),
      method: req.method,
      route,
      startedAt: now(),
      cacheStatus: 'bypass',
      dataState: 'unknown'
    };
    contexts.set(res, context);
    res.setHeader('x-request-id', context.requestId);
    res.once('finish', () => emit('http_request', {
      ...context,
      durationMs: Math.max(0, now() - context.startedAt),
      status: res.statusCode
    }));
    return context;
  }

  function markCache(res, meta = {}) {
    const context = contexts.get(res);
    if (!context) return;
    context.cacheStatus = meta.status || context.cacheStatus;
    context.coalesced = Boolean(meta.coalesced);
    if (Number.isFinite(meta.staleAgeMs)) context.staleAgeMs = Math.max(0, Math.round(meta.staleAgeMs));
  }

  function markPayload(res, body) {
    const context = contexts.get(res);
    if (!context || !body || typeof body !== 'object') return;
    context.provider = body.provider || body.source || context.provider;
    const fetchedAt = Date.parse(body.fetchedAt);
    if (Number.isFinite(fetchedAt)) context.staleAgeMs = Math.max(0, now() - fetchedAt);
    if (body.stale) context.dataState = 'stale';
    else if (Array.isArray(body.errors) && body.errors.length) context.dataState = 'partial';
    else if (Number.isFinite(fetchedAt)) context.dataState = 'fresh';
  }

  function observedFetch(fetchImpl = globalThis.fetch) {
    return async (input, init) => {
      const startedAt = now();
      const provider = providerFromUrl(input);
      const operation = operationFromUrl(input);
      try {
        const response = await fetchImpl(input, init);
        emit('provider_request', {
          provider,
          operation,
          durationMs: Math.max(0, now() - startedAt),
          status: response.status,
          timedOut: false
        });
        return response;
      } catch (error) {
        const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError' || /timeout/i.test(String(error?.message || ''));
        emit('provider_request', {
          provider,
          operation,
          durationMs: Math.max(0, now() - startedAt),
          status: 0,
          timedOut
        });
        throw error;
      }
    };
  }

  return { emit, markCache, markPayload, observedFetch, startRequest };
}

module.exports = { SAFE_FIELDS, createObservability, providerFromUrl };
