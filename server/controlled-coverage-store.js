'use strict';

const { randomUUID } = require('node:crypto');
const { RUN_TYPE } = require('./v156-manual-claim');
const { safeCheckpoint } = require('./checkpoint-safety');

const KEY = /^v156:(?:coverage|eod):\d{4}-\d{2}-\d{2}:[a-zA-Z0-9_-]{1,24}$/;
const CONTROL_KEY = 'v156:control';
const LEASE_MS = 120000;
const MAX_STATE_BYTES = 1048576;

function stopped(code) {
  return Object.assign(Error(code), { code, stopBatch: true });
}

// Requires the approved nullable automation_state column. No DDL here.
function createControlledCoverageStore({ env = process.env, fetchImpl = globalThis.fetch,
  now = Date.now, leaseMs = LEASE_MS, maxRequests = 200 } = {}) {
  const origin = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const configured = /^https:\/\/[^/]+$/.test(origin) && Boolean(secret);
  const metrics = { reads: 0, writes: 0 };
  let held = null;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30000 || leaseMs > 600000
    || !Number.isSafeInteger(maxRequests) || maxRequests < 10 || maxRequests > 1000) throw Error('Invalid persistence limits');

  function enabled() {
    if (env.SETSCOPE_V156_MANUAL_VERIFY !== '1' || env.SETSCOPE_V156_KILL === '1') throw stopped('AUTOMATION_DISABLED');
    if (!configured) throw stopped('PERSISTENCE_UNCONFIGURED');
  }
  async function request(params, init = {}) {
    enabled();
    if (metrics.reads + metrics.writes >= maxRequests) throw stopped('PERSISTENCE_BUDGET');
    metrics[init.method ? 'writes' : 'reads']++;
    let response;
    try {
      response = await fetchImpl(`${origin}/rest/v1/coverage_runs?${params}`, {
        ...init, signal: AbortSignal.timeout(12000),
        headers: { apikey: secret, ...(secret.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secret}` }), 'content-type': 'application/json',
          Prefer: 'return=representation', ...init.headers }
      });
    } catch { throw stopped('PERSISTENCE_UNCERTAIN'); }
    if (!response.ok) throw stopped(response.status === 400 ? 'PERSISTENCE_SCHEMA_OR_INPUT' : 'PERSISTENCE_UNAVAILABLE');
    let rows;
    try { rows = await response.json(); } catch { throw stopped('PERSISTENCE_UNCERTAIN'); }
    if (!Array.isArray(rows) || rows.length > 1) throw stopped('PERSISTENCE_UNCERTAIN');
    return rows;
  }
  function validateKey(key) {
    if (!KEY.test(key || '') && key !== CONTROL_KEY) throw stopped('INVALID_JOB_KEY');
  }
  function validate(row) {
    const state = row?.automation_state;
    if (!state || state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0
      || typeof state.owner !== 'string' || !Number.isFinite(Date.parse(state.leaseUntil))
      || !['running', 'paused', 'stopped', 'completed', 'failed'].includes(state.phase)
      || !state.documents || typeof state.documents !== 'object' || Array.isArray(state.documents)) throw stopped('CHECKPOINT_INVALID');
    const expectedStatus = state.phase === 'running' ? 'running' : state.phase === 'completed' ? 'completed' : 'failed';
    if (row.status !== expectedStatus) throw stopped('CHECKPOINT_STATUS_CONFLICT');
    return state;
  }
  async function read(key) {
    validateKey(key);
    const rows = await request(new URLSearchParams({ run_key: `eq.${key}`, select: '*', limit: '1' }));
    if (rows.length !== 1 || rows[0].run_key !== key) throw stopped('JOB_NOT_FOUND');
    validate(rows[0]);
    return rows[0];
  }
  async function cas(row, next, extra = {}) {
    const previous = validate(row);
    next = structuredClone({ ...next, revision: previous.revision + 1 });
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_STATE_BYTES) throw stopped('CHECKPOINT_TOO_LARGE');
    const params = new URLSearchParams({ run_key: `eq.${row.run_key}`,
      'automation_state->>owner': `eq.${previous.owner}`,
      'automation_state->>revision': `eq.${previous.revision}` });
    const saved = await request(params, { method: 'PATCH', body: JSON.stringify({ ...extra, automation_state: next }) });
    if (saved.length !== 1 || saved[0].run_key !== row.run_key
      || JSON.stringify(saved[0].automation_state) === undefined) throw stopped('LEASE_LOST');
    const actual = validate(saved[0]);
    if (actual.owner !== next.owner || actual.revision !== next.revision) throw stopped('LEASE_LOST');
    return saved[0];
  }
  async function current() {
    enabled();
    if (!held) throw stopped('LEASE_REQUIRED');
    const row = await read(held.key), state = validate(row);
    if (state.owner !== held.owner || Date.parse(state.leaseUntil) <= Number(now())) throw stopped('LEASE_LOST');
    if (state.phase !== 'running') throw stopped('JOB_' + state.phase.toUpperCase());
    return row;
  }
  async function beginRun({ runKey, startedAt, batchSize, concurrency, resume = false }) {
    validateKey(runKey);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20 || concurrency !== 1
      || !Number.isFinite(Date.parse(startedAt || ''))) throw stopped('INVALID_JOB_LIMITS');
    if (held) throw stopped('LEASE_ALREADY_HELD');
    const owner = randomUUID();
    const state = { version: 1, revision: 0, owner, phase: 'running',
      leaseUntil: new Date(Number(now()) + leaseMs).toISOString(), documents: {} };
    const inserted = await request(new URLSearchParams({ on_conflict: 'run_key' }), {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ run_key: runKey, provider: 'Yahoo Finance', status: 'running',
        started_at: startedAt, batch_size: batchSize, concurrency, automation_state: state }])
    });
    let row;
    if (inserted.length) {
      row = inserted[0];
      if (row.run_key !== runKey || row.status !== 'running' || validate(row).owner !== owner) throw stopped('CLAIM_UNCERTAIN');
    } else {
      row = await read(runKey);
      if (row.status === 'completed') return { alreadyCompleted: true, summary: {
        currentVerified: row.current_verified, technicalReady: row.technical_ready } };
      const old = validate(row);
      if (row.batch_size !== batchSize || row.concurrency !== concurrency) throw stopped('JOB_INPUT_CONFLICT');
      if (old.phase === 'stopped') throw stopped('JOB_STOPPED');
      if (!resume || Date.parse(old.leaseUntil) > Number(now())) return { alreadyRunning: true };
      // An unknown external response is deliberately never replayed after a restart.
      if (Object.values(old.documents).some(doc => Object.values(doc?.entries || {}).some(item => item?.status === 'inflight'))) {
        throw stopped('PROVIDER_RECONCILIATION_REQUIRED');
      }
      row = await cas(row, { ...old, owner, phase: 'running', leaseUntil: state.leaseUntil },
        { status: 'running', finished_at: null, failure_reason: null });
    }
    held = { key: runKey, owner };
    return { alreadyCompleted: false, alreadyRunning: false };
  }
  const checkpointStore = {
    async load(key) { return structuredClone(validate(await current()).documents[key] ?? null); },
    async save(key, value) {
      if (!held || !['coverage-manifest:' + held.key, 'coverage-items:' + held.key].includes(key)) throw stopped('CHECKPOINT_KEY_CONFLICT');
      const row = await current(), state = validate(row);
      const documents = { ...state.documents, [key]: safeCheckpoint(value, env) };
      await cas(row, { ...state, documents, leaseUntil: new Date(Number(now()) + leaseMs).toISOString() });
    },
    async withLease(key, action) {
      if (!held || key !== 'coverage-items:' + held.key) throw stopped('CHECKPOINT_KEY_CONFLICT');
      await current();
      return action();
    }
  };
  async function metadata() { return structuredClone(validate(await current()).metadata || {}); }
  async function updateMetadata(patch) {
    const allowed = new Set(['day','reservations','activeJob','providerFailures','blockedUntil','denied','reason','metrics','mode','session','eodCompleted','coverageChecks']);
    if (!patch || Object.keys(patch).some(key => !allowed.has(key))) throw stopped('INVALID_METADATA');
    for (const key of ['reservations','providerFailures']) if (patch[key] !== undefined && (!Number.isSafeInteger(patch[key]) || patch[key] < 0 || patch[key] > 100000)) throw stopped('INVALID_METADATA');
    if (patch.activeJob != null && !KEY.test(patch.activeJob)) throw stopped('INVALID_METADATA');
    for (const key of ['day','session']) if (patch[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch[key])) throw stopped('INVALID_METADATA');
    if (patch.mode !== undefined && !['coverage','eod'].includes(patch.mode)) throw stopped('INVALID_METADATA');
    if (patch.reason != null && !/^[A-Z_]{1,60}$/.test(patch.reason)) throw stopped('INVALID_METADATA');
    if (patch.blockedUntil != null && !Number.isFinite(Date.parse(patch.blockedUntil))) throw stopped('INVALID_METADATA');
    if (patch.denied !== undefined && typeof patch.denied !== 'boolean') throw stopped('INVALID_METADATA');
    if (patch.eodCompleted !== undefined && (!Array.isArray(patch.eodCompleted) || patch.eodCompleted.length > 500
      || patch.eodCompleted.some(symbol=>typeof symbol !== 'string' || !/^[A-Z0-9&.-]{1,20}$/.test(symbol))
      || new Set(patch.eodCompleted).size !== patch.eodCompleted.length)) throw stopped('INVALID_METADATA');
    if(patch.coverageChecks!==undefined){
      if(!patch.coverageChecks || typeof patch.coverageChecks!=='object' || Array.isArray(patch.coverageChecks)
        || Object.keys(patch.coverageChecks).length>1000) throw stopped('INVALID_METADATA');
      for(const [symbol,checked] of Object.entries(patch.coverageChecks)){
        if(!/^[A-Z0-9&.-]{1,20}$/.test(symbol) || checked!==null && (typeof checked!=='string'
          || !/^\d{4}-\d\d-\d\dT/.test(checked) || !Number.isFinite(Date.parse(checked)) || Date.parse(checked)>Number(now()))) throw stopped('INVALID_METADATA');
      }
    }
    if (patch.metrics) for (const [key,value] of Object.entries(patch.metrics)) {
      if (!['providerCalls','databaseReads','databaseWrites','elapsedMs'].includes(key) || !Number.isSafeInteger(value) || value < 0) throw stopped('INVALID_METADATA');
    }
    const row = await current(), state = validate(row);
    await cas(row, { ...state, metadata: { ...state.metadata, ...patch }, leaseUntil: new Date(Number(now()) + leaseMs).toISOString() });
  }
  async function finishRun(payload) {
    if (!held || payload.runKey !== held.key) throw stopped('JOB_INPUT_CONFLICT');
    const row = await current(), state = validate(row);
    await cas(row, { ...state, phase: 'completed', leaseUntil: new Date(Number(now())).toISOString() }, {
      status: 'completed', finished_at: payload.finishedAt,
      ...Object.fromEntries([['attempted','attempted'], ['verified','verified'], ['temporary_failed','temporaryFailed'],
        ['partial','partial'], ['configured_symbols','configuredSymbols'], ['universe','universe'], ['inactive','inactive'],
        ['unsupported','unsupported'], ['stale','stale'], ['error','error'], ['current_verified','currentVerified'],
        ['technical_ready','technicalReady']].map(([to, from]) => [to, payload[from]]))
    });
    held = null;
  }
  async function failRun() {
    const row = await current(), state = validate(row);
    await cas(row, { ...state, phase: 'failed', leaseUntil: new Date(Number(now())).toISOString() }, {
      status: 'failed', failure_reason: 'CONTROLLED_RUN_INTERRUPTED'
    });
    held = null;
  }
  async function control(runKey, phase) {
    if (!['paused', 'stopped'].includes(phase)) throw stopped('INVALID_CONTROL');
    const row = await read(runKey), state = validate(row);
    if (['completed', 'stopped'].includes(state.phase)) return { phase: state.phase };
    await cas(row, { ...state, phase, leaseUntil: new Date(Number(now())).toISOString() }, {
      status: 'failed', failure_reason: phase === 'paused' ? 'OPERATOR_PAUSED' : 'OPERATOR_STOPPED'
    });
    return { phase };
  }
  async function reconcile(runKey, reviewed) {
    if (reviewed !== true) throw stopped('RECONCILIATION_REVIEW_REQUIRED');
    const row = await read(runKey), state = validate(row);
    if (Date.parse(state.leaseUntil) > Number(now())) throw stopped('JOB_STILL_LEASED');
    if (state.phase === 'completed') return { phase: 'completed' };
    const documents = structuredClone(state.documents);
    for (const document of Object.values(documents)) for (const entry of Object.values(document?.entries || {})) {
      if (entry.status === 'inflight') entry.status = 'abandoned';
    }
    // Retain uncertainty as evidence. No synthetic result, registry write or replay.
    await cas(row, { ...state, documents, phase: 'stopped', leaseUntil: new Date(Number(now())).toISOString() },
      { status: 'failed', failure_reason: 'OPERATOR_RECONCILED_WITHOUT_REPLAY' });
    return { phase: 'stopped', reconciled: true, replayed: false };
  }
  async function status(runKey) {
    const row = await read(runKey), state = validate(row);
    const entries = Object.values(state.documents['coverage-items:' + runKey]?.entries || {});
    return { runKey, phase: state.phase, attempted: entries.length, mode: state.metadata?.mode || 'coverage', session: state.metadata?.session || runKey.split(':')[2],
      applied: entries.filter(entry => entry.status === 'applied').length,
      metrics: state.metadata?.metrics || null,
      metricsScope: 'before-finalization',
      requiresReconciliation: entries.some(entry => entry.status === 'inflight'), schedulerEnabled: false };
  }
  return { configured, beginRun, checkpointStore, finishRun, failRun, control, reconcile, status, enabled,
    assertActive: current, metadata, updateMetadata, metrics, runType: RUN_TYPE };
}

module.exports = { createControlledCoverageStore, KEY, CONTROL_KEY, LEASE_MS, stopped };
