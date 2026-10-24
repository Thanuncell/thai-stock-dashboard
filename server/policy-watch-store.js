'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { hash } = require('../lib/policy-document');

const SCHEMA_VERSION = 1;

function initialState() {
  return { baselines: {}, observations: [], changes: [], recovery: {} };
}

function stateChecksum(payload) {
  return hash(JSON.stringify(payload));
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object'
    || !payload.baselines || typeof payload.baselines !== 'object'
    || !Array.isArray(payload.observations)
    || !Array.isArray(payload.changes)
    || !payload.recovery || typeof payload.recovery !== 'object') {
    throw Error('POLICY_STATE_INVALID');
  }
  const observationIds = new Set(payload.observations.map(item => item?.id).filter(Boolean));
  for (const baseline of Object.values(payload.baselines)) {
    if (!baseline?.observationId || !observationIds.has(baseline.observationId)) throw Error('POLICY_STATE_BASELINE_LINK_MISSING');
  }
  for (const change of payload.changes) {
    const observationId = String(change?.evidenceRef || '').replace(/^observation:/, '');
    if (!observationId || !observationIds.has(observationId)) throw Error('POLICY_STATE_EVIDENCE_MISSING');
  }
  return payload;
}

function createPolicyWatchStore({ filePath, fsImpl = fs, maxObservations = 500, maxChanges = 250 } = {}) {
  if (!filePath || !path.isAbsolute(filePath)) throw Error('POLICY_STATE_PATH_REQUIRED');

  async function read({ allowCreate = false } = {}) {
    let raw;
    try { raw = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT' && allowCreate) return { revision: 0, payload: initialState() };
      if (error?.code === 'ENOENT') throw Error('POLICY_STATE_MISSING');
      throw error;
    }
    let envelope;
    try { envelope = JSON.parse(raw); }
    catch (_) { throw Error('POLICY_STATE_CORRUPT'); }
    if (envelope.schemaVersion !== SCHEMA_VERSION) throw Error('POLICY_STATE_SCHEMA_MISMATCH');
    if (!Number.isSafeInteger(envelope.revision) || envelope.revision < 0) throw Error('POLICY_STATE_INVALID_REVISION');
    const payload = validatePayload(envelope.payload);
    if (envelope.checksum !== stateChecksum(payload)) throw Error('POLICY_STATE_CHECKSUM_MISMATCH');
    return { revision: envelope.revision, payload };
  }

  async function write(revision, payload, { fault } = {}) {
    const bounded = {
      ...validatePayload(payload),
      observations: payload.observations.slice(-maxObservations),
      changes: payload.changes.slice(-maxChanges)
    };
    const envelope = {
      schemaVersion: SCHEMA_VERSION,
      revision,
      payload: bounded,
      checksum: stateChecksum(bounded)
    };
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await fsImpl.mkdir(directory, { recursive: true });
    if (fault === 'before-write') throw Error('INJECTED_BEFORE_WRITE');
    try {
      await fsImpl.writeFile(temporary, JSON.stringify(envelope), { encoding: 'utf8', flag: 'wx' });
      if (fault === 'partial-write') {
        await fsImpl.writeFile(temporary, '{"schemaVersion":1', 'utf8');
        throw Error('INJECTED_PARTIAL_WRITE');
      }
      if (fault === 'before-rename') throw Error('INJECTED_BEFORE_RENAME');
      await fsImpl.rename(temporary, filePath);
    } finally {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
    }
    if (fault === 'after-commit') throw Error('INJECTED_AFTER_COMMIT');
    return envelope;
  }

  async function transaction(mutator, options = {}) {
    const current = await read({ allowCreate: options.allowCreate === true });
    const draft = structuredClone(current.payload);
    const result = await mutator(draft, current);
    const envelope = await write(current.revision + 1, draft, options);
    return { result, revision: envelope.revision, payload: envelope.payload };
  }

  return { filePath, read, transaction, write };
}

module.exports = { SCHEMA_VERSION, createPolicyWatchStore, initialState, stateChecksum };
