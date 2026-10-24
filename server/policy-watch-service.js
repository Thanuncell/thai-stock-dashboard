'use strict';

const { hash, classifyObservation, validateDocumentIdentity, validateRegistry } = require('../lib/policy-document');

function createPolicyWatchService({
  registry,
  store,
  acquire,
  enabled = false,
  shadow = false,
  fixtureMode = false,
  now = Date.now,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  maxAttempts = 2,
  baseDelayMs = 100,
  cooldownMs = 60_000,
  failureThreshold = 3,
  maxSourcesPerRun = 5,
  retainFixtureText = false,
  requireExistingState = false,
  random = Math.random
} = {}) {
  const sources = validateRegistry(registry || []);
  const sourceMap = new Map(sources.map(source => [source.sourceId, source]));
  const pending = new Map();
  if (!store || typeof store.transaction !== 'function') throw Error('POLICY_STORE_REQUIRED');
  if (typeof acquire !== 'function') throw Error('POLICY_FIXTURE_ACQUISITION_REQUIRED');
  if (!fixtureMode) throw Error('LIVE_POLICY_ACQUISITION_NOT_AUTHORIZED');

  const checkedAt = () => new Date(now()).toISOString();
  const recoveryDefault = () => ({ state: 'ACTIVE', failures: 0, nextAttemptAt: 0, reason: null });
  const observationId = (sourceId, status, contentHash, at) => hash(`${sourceId}|${status}|${contentHash || ''}|${at}`);
  const changeId = (sourceId, previousHash, currentHash, type) => hash(`${sourceId}|${previousHash || ''}|${currentHash || ''}|${type}`);

  async function recordFailure(source, failure, { block = false, retryAfterMs = cooldownMs } = {}) {
    const at = checkedAt();
    return store.transaction(state => {
      const prior = state.recovery[source.sourceId] || recoveryDefault();
      const failures = prior.failures + 1;
      const blocked = block || failures >= failureThreshold;
      state.recovery[source.sourceId] = {
        state: blocked ? 'RECOVERY_BLOCKED' : 'OPEN',
        failures,
        nextAttemptAt: blocked ? 0 : now() + retryAfterMs,
        reason: failure
      };
      const id = observationId(source.sourceId, failure, '', at);
      if (!state.observations.some(item => item.id === id)) {
        state.observations.push({ id, sourceId: source.sourceId, checkedAt: at, status: failure, verified: false });
      }
      return { sourceId: source.sourceId, status: blocked ? 'RECOVERY_BLOCKED' : 'UNAVAILABLE', reason: failure };
    }, { allowCreate: true });
  }

  async function persistObservation(source, identity, options = {}) {
    const at = checkedAt();
    return store.transaction(state => {
      const previous = state.baselines[source.sourceId] || null;
      const current = { ...identity, sourceId: source.sourceId };
      const classification = classifyObservation(previous, current);
      const id = observationId(source.sourceId, classification.status, identity.contentHash, at);
      if (!state.observations.some(item => item.id === id)) {
        state.observations.push({
          id,
          sourceId: source.sourceId,
          checkedAt: at,
          status: classification.status,
          verified: true,
          rawHash: identity.rawHash,
          contentHash: identity.contentHash,
          layoutHash: identity.layoutHash,
          finalUrl: identity.finalUrl,
          evidence: identity.evidence
        });
      }
      if (classification.status !== 'UNCHANGED') {
        const eventId = changeId(source.sourceId, previous?.contentHash, identity.contentHash, classification.changeType);
        if (!state.changes.some(item => item.id === eventId)) {
          state.changes.push({
            id: eventId,
            sourceId: source.sourceId,
            observedAt: at,
            status: classification.status,
            changeType: classification.changeType,
            previousContentHash: previous?.contentHash || null,
            contentHash: identity.contentHash,
            before: classification.before || previous?.evidence || null,
            after: classification.after || identity.evidence,
            evidenceRef: `observation:${id}`,
            reviewerStatus: 'PENDING'
          });
        }
      }
      state.baselines[source.sourceId] = {
        sourceId: source.sourceId,
        publisher: source.publisher,
        docType: source.docType,
        finalUrl: identity.finalUrl,
        rawHash: identity.rawHash,
        contentHash: identity.contentHash,
        layoutHash: identity.layoutHash,
        evidence: identity.evidence,
        normalizedText: retainFixtureText ? identity.normalizedText : undefined,
        verifiedAt: at,
        observationId: id
      };
      state.recovery[source.sourceId] = recoveryDefault();
      return { sourceId: source.sourceId, status: classification.status, changeType: classification.changeType, observationId: id };
    }, { allowCreate: true, fault: options.fault });
  }

  async function executeSource(source, options = {}) {
    let current;
    try { current = await store.read({ allowCreate: !requireExistingState }); }
    catch (error) { return { sourceId: source.sourceId, status: 'RECOVERY_BLOCKED', reason: error.message, requests: 0 }; }
    const recovery = current.payload.recovery[source.sourceId] || recoveryDefault();
    if (recovery.state === 'RECOVERY_BLOCKED') {
      return { sourceId: source.sourceId, status: 'RECOVERY_BLOCKED', reason: recovery.reason, requests: 0 };
    }
    if (recovery.nextAttemptAt > now()) {
      return { sourceId: source.sourceId, status: 'COOLDOWN', reason: recovery.reason, requests: 0 };
    }
    if (recovery.state === 'OPEN') {
      try {
        await store.transaction(state => {
          state.recovery[source.sourceId] = { ...recovery, state: 'HALF_OPEN' };
        });
      } catch (error) {
        return { sourceId: source.sourceId, status: 'RECOVERY_BLOCKED', reason: error.message, requests: 0 };
      }
    }

    let attempts = 0;
    let lastError;
    while (attempts < maxAttempts) {
      attempts += 1;
      let response;
      try { response = await acquire(source, { attempt: attempts, signal: options.signal }); }
      catch (error) {
        lastError = /timeout|timed out|abort/i.test(String(error?.message || '')) ? 'TIMEOUT' : 'FETCH_FAILURE';
        if (attempts < maxAttempts) {
          await sleep(baseDelayMs * (2 ** (attempts - 1)) + Math.floor(random() * Math.max(1, baseDelayMs / 4)));
          continue;
        }
        break;
      }

      const status = Number(response?.status);
      if (status === 401 || status === 403) {
        const saved = await recordFailure(source, `HTTP_${status}`, { block: true });
        return { ...saved.result, requests: attempts };
      }
      if (status === 429) {
        const saved = await recordFailure(source, 'HTTP_429', { retryAfterMs: cooldownMs });
        return { ...saved.result, requests: attempts };
      }
      if (status >= 500 || status === 0) {
        lastError = `HTTP_${status || 0}`;
        if (attempts < maxAttempts) {
          await sleep(baseDelayMs * (2 ** (attempts - 1)) + Math.floor(random() * Math.max(1, baseDelayMs / 4)));
          continue;
        }
        break;
      }

      const identity = validateDocumentIdentity(source, response);
      if (identity.status === 'ACCESS_DENIED') {
        const saved = await recordFailure(source, identity.reason, { block: true });
        return { ...saved.result, requests: attempts };
      }
      if (!identity.matched) {
        const at = checkedAt();
        const saved = await store.transaction(state => {
          const id = observationId(source.sourceId, identity.status, '', at);
          if (!state.observations.some(item => item.id === id)) {
            state.observations.push({ id, sourceId: source.sourceId, checkedAt: at, status: identity.status, reason: identity.reason, verified: false });
          }
          return { sourceId: source.sourceId, status: identity.status, reason: identity.reason };
        }, { allowCreate: true });
        return { ...saved.result, requests: attempts };
      }
      try {
        const saved = await persistObservation(source, identity, { fault: options.fault });
        return { ...saved.result, requests: attempts };
      } catch (error) {
        return { sourceId: source.sourceId, status: 'RECOVERY_REQUIRED', reason: error.message, requests: attempts };
      }
    }
    const saved = await recordFailure(source, lastError || 'FETCH_FAILURE');
    return { ...saved.result, requests: attempts };
  }

  function runSource(source, options) {
    if (pending.has(source.sourceId)) return pending.get(source.sourceId);
    const task = executeSource(source, options).finally(() => pending.delete(source.sourceId));
    pending.set(source.sourceId, task);
    return task;
  }

  async function runManual({ sourceIds, faultBySource = {} } = {}) {
    if (!enabled || !shadow) return { status: 'DISABLED', fixtureMode: true, requests: 0, results: [] };
    const ids = Array.isArray(sourceIds) && sourceIds.length ? [...new Set(sourceIds)] : sources.map(source => source.sourceId);
    const selected = ids.slice(0, maxSourcesPerRun).map(id => sourceMap.get(id)).filter(Boolean);
    if (selected.length === 0) return { status: 'UNVERIFIED', fixtureMode: true, requests: 0, results: [] };
    const results = [];
    for (const source of selected) results.push(await runSource(source, { fault: faultBySource[source.sourceId] }));
    const accepted = new Set(['FIRST_VERIFIED_BASELINE', 'UNCHANGED', 'CHANGED']);
    return {
      status: results.every(result => accepted.has(result.status)) ? 'FIXTURE_PASS' : 'PARTIAL',
      fixtureMode: true,
      requests: results.reduce((sum, result) => sum + result.requests, 0),
      results
    };
  }

  async function report() {
    let stored;
    try { stored = await store.read(); }
    catch (error) { return { status: 'UNVERIFIED', reason: error.message, verified: 0, changes: 0, blocked: 0 }; }
    const payload = stored.payload;
    const blocked = Object.values(payload.recovery).filter(item => item.state === 'RECOVERY_BLOCKED').length;
    const lastUnverified = payload.observations.at(-1)?.verified === false;
    return {
      status: Object.keys(payload.baselines).length > 0 && blocked === 0 && !lastUnverified ? 'FIXTURE_PASS' : 'PARTIAL',
      revision: stored.revision,
      verified: Object.keys(payload.baselines).length,
      changes: payload.changes.length,
      blocked,
      lastCheck: payload.observations.at(-1)?.checkedAt || null
    };
  }

  return { report, runManual };
}

module.exports = { createPolicyWatchService };
