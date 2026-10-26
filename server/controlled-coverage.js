'use strict';

const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const { createCoverageRepository, createCoverageRunner } = require('./coverage-service');
const { createMarketService } = require('./market-service');
const { createControlledCoverageStore, stopped, KEY, CONTROL_KEY } = require('./controlled-coverage-store');
const { manualRunKey } = require('./v156-manual-claim');
const { bangkokDay, executionWindow, selectCoverage, sessionReady, calendarReadiness } = require('./automation-policy');
const { JOB_BUDGET,readScalePolicy,planBatchScale } = require('./automation-scaling');
const canaryPolicy = require('./canary-policy');

function authorized(header, token) {
  if (typeof token !== 'string' || token.length < 32 || typeof header !== 'string' || header.length > 512) return false;
  const expected = createHash('sha256').update('Bearer ' + token).digest();
  return timingSafeEqual(expected, createHash('sha256').update(header).digest());
}

function createControlledCoverage({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now,
  onVerified = () => {}, retrySleep, canary = false } = {}) {
  let active = false;
  const recent = [];
  function enabled() {
    if (env.SETSCOPE_V156_MANUAL_VERIFY !== '1' || env.SETSCOPE_V156_KILL === '1') throw stopped('AUTOMATION_DISABLED');
  }
  async function execute({ tag = 'manual-1', resume = false, operation = 'run', runKey, mode = 'coverage', reviewed = false, targetSize = 5 } = {}) {
    enabled();
    if (canary && (operation!=='run' || resume || mode!=='coverage' || runKey)) throw stopped('CANARY_INPUT_INVALID');
    if (!['run', 'status', 'pause', 'stop','reconcile','plan'].includes(operation) || typeof resume !== 'boolean' || typeof reviewed !== 'boolean') throw stopped('INVALID_OPERATION');
    const scalePolicy=['run','plan'].includes(operation)?readScalePolicy(env):null;
    if (operation==='plan') return {...planBatchScale(targetSize,scalePolicy),calendar:calendarReadiness(Number(now()))};
    if (targetSize!==5) throw stopped('SCALE_APPROVAL_REQUIRED');
    if (!['coverage','eod'].includes(mode) || operation === 'run' && runKey && !resume) throw stopped('INVALID_OPERATION');
    const key = canary ? canaryPolicy.RUN_KEY : operation === 'run' ? resume && runKey || manualRunKey({ date: new Date(Number(now())), tag, type: mode }) : runKey;
    if (!KEY.test(key || '')) throw stopped('INVALID_JOB_KEY');
    if (operation === 'run' && key.split(':')[1] !== mode) throw stopped('JOB_INPUT_CONFLICT');
    const window = operation === 'run' ? executionWindow({ now: Number(now()), mode,
      session: key.split(':')[2], recover: Boolean(resume && runKey) }) : null;
    if (window && !window.eligible) return { runKey: key, skipped: true, reason: window.reason, schedulerEnabled: false };
    const start = Number(now());
    const metrics = { providerCalls: 0, databaseReads: 0, databaseWrites: 0 };
    const observedFetch = async (input, init = {}) => {
      enabled();
      if (Number(now()) - start >= JOB_BUDGET.durationMs) throw stopped('JOB_TIME_BUDGET');
      const host = new URL(String(input)).hostname;
      const database = host === new URL(env.SUPABASE_URL).hostname;
      if (database) {
        if (metrics.databaseReads + metrics.databaseWrites >= JOB_BUDGET.databaseRequests) throw stopped('DATABASE_BUDGET');
        metrics[!init.method || ['GET','HEAD'].includes(init.method) ? 'databaseReads' : 'databaseWrites']++;
      } else {
        if (host !== 'query1.finance.yahoo.com') throw stopped('UNEXPECTED_PROVIDER');
        if (metrics.providerCalls >= JOB_BUDGET.providerRequests) throw stopped('PROVIDER_BUDGET');
        metrics.providerCalls++;
      }
      return fetchImpl(input, init);
    };
    const store = createControlledCoverageStore({ env, fetchImpl: observedFetch, now });
    const coordinator = createControlledCoverageStore({ env, fetchImpl: observedFetch, now });
    const repository = createCoverageRepository({ env, fetchImpl: observedFetch, now });
    if (!store.configured) throw stopped('PERSISTENCE_UNCONFIGURED');
    if (operation !== 'run') return operation === 'status' ? store.status(key) : operation === 'reconcile' ? store.reconcile(key, reviewed)
      : store.control(key, operation === 'pause' ? 'paused' : 'stopped');
    if (active) throw stopped('LOCAL_JOB_ACTIVE');
    const current = Number(now());
    while (recent.length && current - recent[0] >= 60000) recent.shift();
    if (recent.length >= 3) throw stopped('TRIGGER_RATE_LIMIT');
    recent.push(current);
    active = true;
    let ownsCoordinator = false, jobStarted = false, metadata, canaryBefore;
    const coverageReserved=new Set();
    try {
      // A duplicate completed job must not consume another daily reservation.
      try {
        const previous = await store.status(key);
        if (previous.phase === 'completed') return { runKey: key, alreadyCompleted: true, attempted: 0, metrics, schedulerEnabled: false };
        if (canary) throw stopped('CANARY_ALREADY_ATTEMPTED');
        if (previous.mode !== mode) throw stopped('JOB_INPUT_CONFLICT');
      } catch (error) { if (error.code !== 'JOB_NOT_FOUND') throw error; }
      if (canary) { canaryBefore=await repository.listCandidates(); canaryPolicy.selectCanary(canaryBefore); }
      const gate = await coordinator.beginRun({ runKey: CONTROL_KEY, startedAt: new Date(Number(now())).toISOString(), batchSize: 5, concurrency: 1, resume: true });
      if (gate.alreadyRunning) return { runKey: key, alreadyRunning: true, attempted: 0, metrics, schedulerEnabled: false };
      ownsCoordinator = true;
      metadata = await coordinator.metadata();
      if (metadata.denied || Date.parse(metadata.blockedUntil || '') > Number(now())) throw stopped('PROVIDER_CIRCUIT_OPEN');
      if (metadata.activeJob && metadata.activeJob !== key) {
        const previous = await store.status(metadata.activeJob);
        if (previous.requiresReconciliation || !['completed','stopped'].includes(previous.phase)) throw stopped('JOB_RECOVERY_REQUIRED');
      }
      const day = bangkokDay(Number(now()));
      const reservations = metadata.day === day ? metadata.reservations || 0 : 0;
      // Reserve worst-case capacity before starting. Crashes never refund it.
      if (reservations >= scalePolicy.maxJobsPerDay
        || (reservations+1)*JOB_BUDGET.providerRequests>scalePolicy.providerDailyLimit
        || (reservations+1)*JOB_BUDGET.databaseRequests>scalePolicy.databaseDailyLimit) throw stopped('DAILY_JOB_BUDGET');
      const eodCompleted = metadata.day === day ? metadata.eodCompleted || [] : [];
      await coordinator.updateMetadata({ day, reservations: reservations + 1, activeJob: key, eodCompleted });
      metadata = { ...metadata, day, reservations: reservations + 1, activeJob: key, eodCompleted };
      const market = createMarketService({ env, fetchImpl: observedFetch, now });
      const runner = createCoverageRunner({ repository: { ...repository,
        beginRun: async args => {
          const result = await store.beginRun(args);
          jobStarted = !result.alreadyRunning && !result.alreadyCompleted;
          if (jobStarted) await store.updateMetadata({ mode, session: window.session });
          return result;
        },
        listBatch: async () => {
          const candidates=await repository.listCandidates();
          const coverageChecks={...metadata.coverageChecks};
          for(const row of candidates) if(row?.active===true && !Object.hasOwn(coverageChecks,row.symbol)) coverageChecks[row.symbol]=row.last_checked_at || null;
          if(JSON.stringify(coverageChecks)!==JSON.stringify(metadata.coverageChecks || {})){
            await coordinator.updateMetadata({coverageChecks});metadata.coverageChecks=coverageChecks;
          }
          if (canary) return canaryPolicy.selectCanary(candidates);
          return selectCoverage(candidates, { now: Number(now()), mode, session: window.session,coverageChecks,
            excludeSymbols: mode === 'eod' ? metadata.eodCompleted : [] });
        },
        finishRun: async payload => { await store.updateMetadata({ metrics: { ...metrics, elapsedMs: Math.max(0, Number(now()) - start) } }); await store.finishRun(payload); jobStarted = false; },
        saveResults: async (...args) => { await store.assertActive(); return repository.saveResults(...args); } },
        verifySymbol: async (...args) => {
          try {
            await store.assertActive();
            await coordinator.assertActive();
            if (metadata.denied || Date.parse(metadata.blockedUntil || '') > Number(now())) throw stopped('PROVIDER_CIRCUIT_OPEN');
            if (metrics.providerCalls >= JOB_BUDGET.providerRequests) throw stopped('PROVIDER_BUDGET');
          } catch (error) { error.notStarted = true; throw error; }
          // Reserve this stock's coverage clock before acquisition. Retry attempts
          // inside the same invocation do not create a new seven-day reservation.
          if(!canary && mode==='coverage' && !coverageReserved.has(args[0])){
            const coverageChecks={...metadata.coverageChecks,[args[0]]:new Date(Number(now())).toISOString()};
            await coordinator.updateMetadata({coverageChecks});metadata.coverageChecks=coverageChecks;coverageReserved.add(args[0]);
          }
          let verification;
          try {
            verification = await market.verifySymbol(...args);
          } catch (error) {
            const denied = [401,403,429].includes(error.status) || error.accessDenied;
            const transient = require('./reliability').isTransientProviderError(error);
            const failures = transient ? (metadata.providerFailures || 0) + 1 : 0;
            metadata = { ...metadata, providerFailures: failures,
              ...(denied || transient && failures >= 3 ? { blockedUntil: new Date(Number(now()) + 300000).toISOString(), denied: Boolean(denied),
                reason: denied ? 'SOURCE_DENIED' : 'TRANSIENT_FAILURES' } : {}) };
            await coordinator.updateMetadata({ providerFailures: failures, ...(metadata.blockedUntil ? {
              blockedUntil: metadata.blockedUntil, denied: Boolean(metadata.denied), reason: metadata.reason } : {}) });
            throw error;
          }
          if (metadata.providerFailures) { metadata.providerFailures = 0; await coordinator.updateMetadata({ providerFailures: 0 }); }
          if (mode === 'eod' && !sessionReady(verification, window.session)) {
            return { ...verification, quoteReady: false, chartReady: false, technicalReady: false,
              guardStatus: 'stale', guardReason: 'EOD_SESSION_NOT_READY' };
          }
          if (mode === 'eod' && !metadata.eodCompleted.includes(args[0])) {
            metadata.eodCompleted.push(args[0]);
            await coordinator.updateMetadata({ eodCompleted: metadata.eodCompleted });
          }
          onVerified(args[0], verification);
          return verification;
        },
        checkpointStore: store.checkpointStore, batchSize: 5, concurrency: 1, now, ...(retrySleep ? { retrySleep } : {}) });
      const result = await runner.run({ runKey: key, resume });
      let canaryCounts;
      if (canary) {
        const after=await repository.listCandidates();
        if (!canaryPolicy.unchangedOutside(canaryBefore,after)) throw stopped('CANARY_OUTSIDE_CHANGED');
        canaryCounts={before:canaryPolicy.counts(canaryBefore),after:canaryPolicy.counts(after),outsideUnchanged:true};
      }
      return { runKey: key, alreadyCompleted: Boolean(result.alreadyCompleted), alreadyRunning: Boolean(result.alreadyRunning),
        attempted: result.attempted || 0, verified: result.verified || 0, partial: result.partial || 0,
        temporaryFailed: result.temporaryFailed || 0, metrics, ...(canaryCounts?{canaryCounts}:{}),
        schedulerEnabled: false };
    } catch (error) {
      // Preserve uncertain entries; never turn a failed response into a replay.
      if (jobStarted) try { await store.updateMetadata({ metrics: { ...metrics, elapsedMs: Math.max(0, Number(now()) - start) } }); await store.failRun(); } catch { /* Keep uncertain state. */ }
      throw error;
    } finally {
      if (ownsCoordinator) try { await coordinator.failRun(); } catch { /* Expiry and CAS fence a lost coordinator. */ }
      metrics.elapsedMs = Math.max(0, Number(now()) - start);
      active = false;
    }
  }
  return { execute, enabled };
}

function manualSignature(body, token, timestamp) {
  return createHmac('sha256', token).update(String(timestamp) + '\n' + JSON.stringify(body)).digest('hex');
}
function createManualCoverageHandler({ controller, env = process.env, readJson, send, now = Date.now } = {}) {
  return async function handle(req, res) {
    if (!authorized(req.headers.authorization, env.SETSCOPE_V156_TRIGGER_TOKEN)) return send(res, 401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    try {
      controller.enabled();
      const body = await readJson(req);
      if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).some(key => !['tag','resume','operation','runKey','mode','reviewed','targetSize'].includes(key))) return send(res, 400, { error: 'Invalid request' });
      const timestamp = req.headers['x-setscope-sent-at'], signature = req.headers['x-setscope-signature'];
      if (typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || Number(now()) - Number(timestamp) > 60000
        || Number(timestamp) - Number(now()) > 5000 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)
        || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(manualSignature(body, env.SETSCOPE_V156_TRIGGER_TOKEN, timestamp), 'hex'))) {
        return send(res, 401, { error: 'Unauthorized' });
      }
      return send(res, 200, await controller.execute(body));
    } catch (error) {
      // Provider/network/credential-bearing messages never cross the control boundary.
      const code = error.code;
      const status = code === 'AUTOMATION_DISABLED' ? 503 : code === 'TRIGGER_RATE_LIMIT' ? 429
        : ['INVALID_OPERATION','INVALID_JOB_KEY','INVALID_JOB_LIMITS'].includes(code) ? 400 : 409;
      return send(res, status, { error: 'Controlled job stopped; inspect status before retry', schedulerEnabled: false });
    }
  };
}

module.exports = { authorized, createControlledCoverage, createManualCoverageHandler, manualSignature };
