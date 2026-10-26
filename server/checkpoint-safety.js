'use strict';

const ROW_FIELDS = new Set(['symbol','provider_symbol','provider','symbol_verified','chart_ready','technical_ready',
  'status','last_verified_at','last_success_at','last_checked_at','failure_count','active','guard_status','guard_reason',
  'failure_reason','updated_at']);
const SENSITIVE = /secret|token|password|authorization|cookie|credential|private.?key/i;
function safeCheckpoint(value, env = {}) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 524288) throw Error('CHECKPOINT_TOO_LARGE');
  for (const name of ['SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SETSCOPE_V156_TRIGGER_TOKEN']) {
    const secret = env[name];
    if (typeof secret === 'string' && secret.length >= 8 && serialized.includes(secret)) throw Error('CHECKPOINT_SENSITIVE_VALUE');
  }
  function walk(item) {
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw Error('CHECKPOINT_INVALID');
    for (const [key, child] of Object.entries(item)) {
      if (SENSITIVE.test(key) || ['__proto__','constructor','prototype'].includes(key)) throw Error('CHECKPOINT_SENSITIVE_FIELD');
      walk(child);
    }
  }
  walk(value);
  function keys(object, allowed) {
    if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.has(key))) throw Error('CHECKPOINT_FIELDS_INVALID');
  }
  function row(object) {
    keys(object, ROW_FIELDS);
    for (const [key, item] of Object.entries(object)) {
      if (item === null) continue;
      if (['symbol_verified','chart_ready','technical_ready','active'].includes(key)) {
        if (typeof item !== 'boolean') throw Error('CHECKPOINT_VALUE_INVALID');
      } else if (key === 'failure_count') {
        if (!Number.isSafeInteger(item) || item < 0) throw Error('CHECKPOINT_VALUE_INVALID');
      } else if (key.endsWith('_at')) {
        if (typeof item !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(item) || !Number.isFinite(Date.parse(item))) throw Error('CHECKPOINT_VALUE_INVALID');
      } else {
        const patterns = { symbol: /^[A-Z0-9&.-]{1,20}$/, provider_symbol: /^[A-Z0-9&.-]{1,32}\.BK$/,
          provider: /^Yahoo Finance$/, status: /^(pending|verified|partial|temporary_failed|inactive|unsupported)$/,
          guard_status: /^(accepted|delayed|stale|suspect|quarantined|unavailable)$/,
          guard_reason: /^[A-Z][A-Z0-9_]{0,119}$/, failure_reason: /^[A-Z][A-Z0-9_]{0,119}$/ };
        if (typeof item !== 'string' || !patterns[key]?.test(item)) throw Error('CHECKPOINT_VALUE_INVALID');
      }
    }
  }
  if (Object.hasOwn(value, 'rows')) {
    keys(value, new Set(['rows','batchSize','provider']));
    if (!Array.isArray(value.rows) || value.rows.length > 20) throw Error('CHECKPOINT_MANIFEST_INVALID');
    if (!Number.isSafeInteger(value.batchSize) || value.batchSize < 1 || value.batchSize > 20 || value.provider !== 'Yahoo Finance') throw Error('CHECKPOINT_MANIFEST_INVALID');
    value.rows.forEach(row);
  } else {
    keys(value, new Set(['version','fingerprint','status','entries']));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint || '') || !['running','completed'].includes(value.status)) throw Error('CHECKPOINT_INVALID');
    if (!value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries) || Object.keys(value.entries).length > 20) throw Error('CHECKPOINT_ENTRIES_INVALID');
    for (const [symbol, entry] of Object.entries(value.entries)) {
      if (!/^[A-Z0-9&.-]{1,20}$/.test(symbol)) throw Error('CHECKPOINT_IDENTITY_INVALID');
      keys(entry, new Set(['status','result']));
      if (!['inflight','checked','applied'].includes(entry.status)) throw Error('CHECKPOINT_INVALID');
      if (entry.result) row(entry.result);
    }
  }
  return structuredClone(value);
}
module.exports = { safeCheckpoint };
