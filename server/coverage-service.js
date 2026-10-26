'use strict';

const { normalizeSymbol } = require('../lib/validation');
const { coverageTruth } = require('./coverage-truth');
const { createCheckpointBatch } = require('./coverage-checkpoint');
const { isTransientProviderError, retryWithBackoff } = require('./reliability');

const DEFAULT_BATCH_SIZE = 125;
const DEFAULT_CONCURRENCY = 4;
const MAX_BATCH_SIZE = 200;
const MAX_CONCURRENCY = 10;
const RUN_LEASE_MS = 6 * 60 * 60 * 1000;
const SUMMARY_STALE_MS = 36 * 60 * 60 * 1000;
const PROVIDER = 'Yahoo Finance';

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
}

function boundedReason(value, fallback = null) {
  const normalized = String(value || fallback || '').trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function coverageCounts(rows = []) {
  const active = rows.filter(row => row?.active !== false && row?.symbol_verified && row?.chart_ready);
  return {
    currentVerified: active.length,
    technicalReady: active.filter(row => row.technical_ready).length
  };
}

function persistedCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function coverageRunKey(value = new Date(), provider = PROVIDER) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const part = type => parts.find(item => item.type === type)?.value;
  return `${provider}:${part('year')}-${part('month')}-${part('day')}`;
}

function createCoverageRepository({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const configured = Boolean(/^https:\/\//.test(baseUrl) && secretKey);

  function headers(extra = {}) {
    return { apikey: secretKey, ...(secretKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secretKey}` }), ...extra };
  }

  async function request(path, init = {}) {
    if (!configured) throw Error('Coverage persistence is not configured');
    const response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
      ...init,
      headers: headers(init.headers),
      signal: init.signal || AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      const error = Error(`Coverage persistence ${path.split('?')[0]} HTTP ${response.status}`);
      error.status = response.status;
      error.retryable = [429, 502, 503, 504].includes(response.status);
      throw error;
    }
    return response;
  }

  async function countExact(filter) {
    const response = await request(`security_coverage?select=symbol&${filter}`, {
      method: 'HEAD',
      headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }
    });
    const match = String(response.headers.get('content-range') || '').match(/\/(\d+|\*)$/);
    return match && match[1] !== '*' ? Number(match[1]) : 0;
  }

  async function counts() {
    const [configuredSymbols, universe, currentVerified, technicalReady, success, partial, stale, error, inactive, unsupported] = await Promise.all([
      countExact(''),
      countExact('active=eq.true'),
      countExact('active=eq.true&symbol_verified=eq.true&chart_ready=eq.true'),
      countExact('active=eq.true&symbol_verified=eq.true&chart_ready=eq.true&technical_ready=eq.true'),
      countExact('active=eq.true&status=eq.verified'),
      countExact('active=eq.true&status=eq.partial'),
      countExact('active=eq.true&guard_status=eq.stale'),
      countExact('active=eq.true&status=eq.temporary_failed'),
      countExact('status=eq.inactive'),
      countExact('status=eq.unsupported')
    ]);
    return { configuredSymbols, universe, currentVerified, technicalReady, success, partial, stale, error, inactive, unsupported };
  }

  async function summary() {
    if (!configured) return {
      configured: false,
      universe: null,
      currentVerified: null,
      technicalReady: null,
      lastChecked: null,
      provider: PROVIDER,
      dataState: 'unavailable'
    };
    const rows = [];
    let offset = 0, total;
    do {
      const response = await request('security_coverage?select=symbol,active,status,symbol_verified,chart_ready,technical_ready,last_verified_at,last_success_at,last_checked_at,guard_status&order=symbol&limit=1000&offset=' + offset,
        { headers: { Prefer: 'count=exact' } });
      const page = await response.json();
      if (!Array.isArray(page)) throw Error('Invalid coverage snapshot');
      const rawTotal = String(response.headers.get('content-range') || '').match(/\/(\d+)$/);
      total = rawTotal ? Number(rawTotal[1]) : page.length < 1000 ? offset + page.length : null;
      if (total === null || total > 10000 || !page.length && offset < total) throw Error('Incomplete coverage snapshot');
      rows.push(...page); offset += page.length;
    } while (offset < total);
    if (rows.length !== total || new Set(rows.map(r => r.symbol)).size !== rows.length
      || rows.some(r => !normalizeSymbol(r.symbol) || typeof r.active !== 'boolean'
        || !['pending','verified','partial','temporary_failed','inactive','unsupported'].includes(r.status))) throw Error('Invalid coverage snapshot');
    const current = coverageCounts(rows), truth = coverageTruth(rows, { now: Number(now()) });
    const checked = rows.map(r => Date.parse(r.last_checked_at || '')).filter(t => Number.isFinite(t) && t <= Number(now()));
    const latest = checked.length ? Math.max(...checked) : null;
    return {
      configured: true, configuredSymbols: rows.length, universe: rows.filter(r => r.active).length,
      ...current, ...truth, lastChecked: latest === null ? null : new Date(latest).toISOString(),
      provider: PROVIDER, dataState: latest === null ? 'unavailable' : Number(now()) - latest <= SUMMARY_STALE_MS ? 'fresh' : 'stale'
    };
  }

  async function seedSymbols(symbols = []) {
    if (!configured) throw Error('Coverage persistence is not configured');
    const rows = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))].map(symbol => ({
      symbol,
      provider_symbol: `${symbol}.BK`,
      provider: PROVIDER,
      active: true
    }));
    if (!rows.length) return 0;
    await request('security_coverage?on_conflict=symbol', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    return rows.length;
  }

  async function listBatch(limit = DEFAULT_BATCH_SIZE) {
    const safeLimit = clampInteger(limit, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
    const params = new URLSearchParams({
      select: 'symbol,provider_symbol,provider,symbol_verified,chart_ready,technical_ready,status,last_verified_at,last_success_at,last_checked_at,failure_count,active,guard_status,guard_reason',
      active: 'eq.true',
      order: 'last_checked_at.asc.nullsfirst,symbol.asc',
      limit: String(safeLimit)
    });
    const response = await request(`security_coverage?${params}`);
    return response.json();
  }

  async function listCandidates() {
    const response = await request('security_coverage?select=symbol,provider_symbol,provider,symbol_verified,chart_ready,technical_ready,status,last_verified_at,last_success_at,last_checked_at,failure_count,active,guard_status,guard_reason&order=symbol&limit=1000',
      { headers: { Prefer: 'count=exact' } });
    const rows = await response.json();
    const total = String(response.headers.get('content-range') || '').match(/\/(\d+)$/);
    if (!Array.isArray(rows) || rows.length > 1000 || rows.length === 1000 && !total
      || total && Number(total[1]) !== rows.length) throw Error('Incomplete bounded registry snapshot');
    return rows;
  }

  async function findRun(runKey) {
    const params = new URLSearchParams({ select: '*', run_key: `eq.${runKey}`, limit: '1' });
    const response = await request(`coverage_runs?${params}`);
    return (await response.json())[0] || null;
  }

  async function beginRun({ runKey, startedAt, batchSize, concurrency, resume = false }) {
    const existing = await findRun(runKey);
    if (existing?.status === 'completed') return {
      alreadyCompleted: true,
      summary: { currentVerified: existing.current_verified, technicalReady: existing.technical_ready }
    };
    if (existing?.status === 'running' && resume) return { alreadyCompleted: false, alreadyRunning: false };
    if (existing?.status === 'running') {
      const leaseAge = Date.parse(startedAt) - Date.parse(existing.started_at);
      if (!Number.isFinite(leaseAge) || leaseAge < RUN_LEASE_MS) return { alreadyRunning: true };
    }
    const payload = {
      run_key: runKey,
      provider: PROVIDER,
      status: 'running',
      started_at: startedAt,
      finished_at: null,
      batch_size: batchSize,
      concurrency,
      attempted: 0,
      verified: 0,
      temporary_failed: 0,
      partial: 0,
      configured_symbols: 0,
      universe: 0,
      inactive: 0,
      unsupported: 0,
      stale: 0,
      error: 0,
      current_verified: 0,
      technical_ready: 0
    };
    await request('coverage_runs?on_conflict=run_key', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([payload])
    });
    return { alreadyCompleted: false, alreadyRunning: false };
  }

  async function saveResults(rows, { expectedRows = [] } = {}) {
    if (!rows.length) return;
    if (rows.length > MAX_BATCH_SIZE) throw Error('Coverage write batch exceeds limit');
    const expected = new Map(expectedRows.map(row => [row.symbol, row]));
    const mutable = ['status','symbol_verified','chart_ready','technical_ready','last_checked_at','last_verified_at',
      'last_success_at','failure_count','failure_reason','guard_status','guard_reason','updated_at'];
    for (const row of rows) {
      if (normalizeSymbol(row.symbol) !== row.symbol || !/^[A-Z0-9&.-]{1,32}\.BK$/.test(row.provider_symbol)) throw Error('Invalid coverage write identity');
      const params = new URLSearchParams({ symbol: `eq.${row.symbol}`, provider_symbol: `eq.${row.provider_symbol}`, active: 'eq.true' });
      if (expected.has(row.symbol)) {
        const checked = expected.get(row.symbol).last_checked_at;
        params.set('last_checked_at', checked ? `eq.${checked}` : 'is.null');
      }
      const body = Object.fromEntries(mutable.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
      if (row.active === false && ['inactive','unsupported'].includes(row.status)) body.active = false;
      const response = await request(`security_coverage?${params}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body)
      });
      const saved = await response.json();
      if (Array.isArray(saved) && saved.length === 1 && saved[0].symbol === row.symbol) continue;
      // Crash after PATCH but before checkpoint completion: confirm exact applied state, never overwrite it.
      const lookup = new URLSearchParams({ symbol: `eq.${row.symbol}`, provider_symbol: `eq.${row.provider_symbol}`, select: '*', limit: '1' });
      const current = await (await request(`security_coverage?${lookup}`)).json();
      const same = (key, value, actual) => key.endsWith('_at') && value != null && actual != null
        ? Date.parse(value) === Date.parse(actual) : value === actual;
      if (!Array.isArray(current) || current.length !== 1 || current[0].active !== (body.active ?? true)
        || !Object.entries(body).every(([key, value]) => same(key, value, current[0][key]))) throw Error('Coverage row changed; reconcile before replay');
    }
  }

  async function finishRun(payload) {
    const runKey = payload.runKey;
    const body = {
      status: payload.status || 'completed',
      finished_at: payload.finishedAt,
      attempted: payload.attempted,
      verified: payload.verified,
      temporary_failed: payload.temporaryFailed,
      partial: payload.partial,
      configured_symbols: payload.configuredSymbols,
      universe: payload.universe,
      inactive: payload.inactive,
      unsupported: payload.unsupported,
      stale: payload.stale,
      error: payload.error,
      current_verified: payload.currentVerified,
      technical_ready: payload.technicalReady,
      failure_reason: payload.failureReason || null
    };
    await request(`coverage_runs?run_key=eq.${encodeURIComponent(runKey)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body)
    });
  }

  return { beginRun, configured, counts, finishRun, listBatch, listCandidates, saveResults, seedSymbols, summary };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = Array(items.length);
  let cursor = 0;
  let failure;
  const worker = async () => {
    while (!failure && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { failure = failure || error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  if (failure) throw failure;
  return results;
}

function createCoverageRunner({
  repository,
  verifySymbol,
  now = Date.now,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  provider = PROVIDER,
  retrySleep,
  checkpointStore
} = {}) {
  const safeBatchSize = clampInteger(batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const safeConcurrency = clampInteger(concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);

  async function run({ runKey = coverageRunKey(new Date(Number(now())), provider), resume = false } = {}) {
    const startedAt = new Date(Number(now())).toISOString();
    const gate = await repository.beginRun({ runKey, startedAt, batchSize: safeBatchSize, concurrency: safeConcurrency, resume: Boolean(checkpointStore && resume) });
    if (gate.alreadyCompleted) return { alreadyCompleted: true, ...gate.summary, attempted: 0, temporaryFailed: 0 };
    if (gate.alreadyRunning) return { alreadyRunning: true, attempted: 0, temporaryFailed: 0 };

    const manifestKey = 'coverage-manifest:' + runKey;
    let manifest = checkpointStore ? await checkpointStore.load(manifestKey) : null;
    if (!manifest) {
      manifest = { rows: await repository.listBatch(safeBatchSize), batchSize: safeBatchSize, provider };
      if (checkpointStore) await checkpointStore.save(manifestKey, manifest);
    }
    if (!Array.isArray(manifest.rows) || manifest.batchSize !== safeBatchSize || manifest.provider !== provider) throw Error('Coverage manifest conflict');
    const rows = manifest.rows;
    const verifyRow = async row => {
      const checkedAt = new Date(Number(now())).toISOString();
      const base = {
        symbol: row.symbol,
        provider_symbol: row.provider_symbol || `${row.symbol}.BK`,
        provider: row.provider || provider,
        active: row.active !== false,
        last_checked_at: checkedAt,
        updated_at: checkedAt
      };
      try {
        const verification = await retryWithBackoff(
          () => verifySymbol(row.symbol, row.provider_symbol),
          {
            maxAttempts: 2,
            baseDelayMs: 250,
            shouldRetry: error => !error.stopBatch && !error.skipAttempt && ![401,403,429].includes(error.status) && !error.accessDenied && isTransientProviderError(error),
            ...(retrySleep ? { sleep: retrySleep } : {})
          }
        );
        const lifecycleStatus = ['inactive', 'unsupported'].includes(verification.lifecycleStatus)
          && verification.lifecycleConfirmed === true
          ? verification.lifecycleStatus
          : null;
        if (lifecycleStatus) {
          return {
            ...base,
            active: false,
            symbol_verified: false,
            chart_ready: false,
            technical_ready: false,
            status: lifecycleStatus,
            last_verified_at: row.last_verified_at || null,
            last_success_at: row.last_success_at || null,
            failure_count: Number(row.failure_count || 0),
            failure_reason: boundedReason(verification.lifecycleReason, lifecycleStatus.toUpperCase()),
            guard_status: verification.guardStatus || 'unavailable',
            guard_reason: boundedReason(verification.guardReason || verification.lifecycleReason, lifecycleStatus.toUpperCase())
          };
        }
        const accepted = ['accepted', 'delayed'].includes(verification.guardStatus);
        const verified = accepted && verification.symbolVerified && verification.chartReady;
        // Warning-only chart evidence is PARTIAL, not a provider failure or price verification.
        if (!accepted && verification.symbolVerified && verification.chartReady) {
          return {
            ...base, symbol_verified: true, chart_ready: true,
            technical_ready: Boolean(verification.technicalReady), status: 'partial',
            last_verified_at: row.last_verified_at || null,
            last_success_at: row.last_success_at || null,
            failure_count: Number(row.failure_count || 0), failure_reason: null,
            guard_status: verification.guardStatus || 'suspect',
            guard_reason: boundedReason(verification.guardReason)
          };
        }
        if (!verified && (row.symbol_verified && row.chart_ready || !accepted)) {
          return {
            ...base,
            symbol_verified: Boolean(row.symbol_verified),
            chart_ready: Boolean(row.chart_ready),
            technical_ready: Boolean(row.technical_ready),
            status: 'temporary_failed',
            last_verified_at: row.last_verified_at || null,
            last_success_at: row.last_success_at || null,
            failure_count: Number(row.failure_count || 0) + 1,
            failure_reason: boundedReason(verification.guardReason, 'VERIFICATION_INCOMPLETE'),
            guard_status: verification.guardStatus || 'suspect',
            guard_reason: boundedReason(verification.guardReason, 'VERIFICATION_INCOMPLETE')
          };
        }
        return {
          ...base,
          symbol_verified: Boolean(verification.symbolVerified),
          chart_ready: Boolean(verification.chartReady),
          technical_ready: Boolean(verification.technicalReady),
          status: verified ? 'verified' : 'partial',
          last_verified_at: verified ? checkedAt : row.last_verified_at || null,
          last_success_at: verified ? checkedAt : row.last_success_at || null,
          failure_count: verified ? 0 : Number(row.failure_count || 0) + 1,
          failure_reason: verified ? null : boundedReason(verification.guardReason, 'CHART_NOT_READY'),
          guard_status: verification.guardStatus || 'accepted',
          guard_reason: boundedReason(verification.guardReason)
        };
      } catch (error) {
        // A stopped provider path or exhausted shared budget is not a failed security.
        if (error.stopBatch || error.skipAttempt) throw error;
        return {
          ...base,
          symbol_verified: Boolean(row.symbol_verified),
          chart_ready: Boolean(row.chart_ready),
          technical_ready: Boolean(row.technical_ready),
          status: 'temporary_failed',
          last_verified_at: row.last_verified_at || null,
          last_success_at: row.last_success_at || null,
          failure_count: Number(row.failure_count || 0) + 1,
          failure_reason: isTransientProviderError(error) ? 'TRANSIENT_PROVIDER_ERROR' : boundedReason(error.code, 'VERIFICATION_ERROR'),
          guard_status: error.guardStatus || row.guard_status || null,
          guard_reason: boundedReason(error.guardReasons?.[0] || error.guardReason || row.guard_reason)
        };
      }
    };
    let results;
    if (checkpointStore && rows.length) {
      const batch = createCheckpointBatch({ store: checkpointStore,
        verify: (symbol, providerSymbol) => verifyRow(rows.find(row => row.symbol === symbol && row.provider_symbol === providerSymbol)),
        apply: (row, result) => repository.saveResults([result], { expectedRows: [row] }) });
      const completed = await batch.run({ runKey: 'coverage-items:' + runKey, rows });
      results = rows.map(row => completed.entries[row.symbol].result);
    } else {
      results = await mapWithConcurrency(rows, safeConcurrency, verifyRow);
      await repository.saveResults(results, { expectedRows: rows });
    }
    const current = await repository.counts();
    const verified = results.filter(row => row.status === 'verified').length;
    const temporaryFailed = results.filter(row => row.status === 'temporary_failed').length;
    const partial = results.filter(row => row.status === 'partial').length;
    const finishedAt = new Date(Number(now())).toISOString();
    await repository.finishRun({
      runKey,
      status: 'completed',
      finishedAt,
      attempted: results.length,
      verified,
      temporaryFailed,
      partial,
      ...current
    });
    return {
      alreadyCompleted: false,
      runKey,
      attempted: results.length,
      verified,
      temporaryFailed,
      partial,
      ...current,
      finishedAt
    };
  }

  return { run };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  PROVIDER,
  SUMMARY_STALE_MS,
  boundedReason,
  coverageCounts,
  coverageRunKey,
  createCoverageRepository,
  createCoverageRunner,
  mapWithConcurrency,
  persistedCount
};
