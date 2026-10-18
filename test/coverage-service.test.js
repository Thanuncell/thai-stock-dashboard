'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  coverageCounts,
  createCoverageRepository,
  createCoverageRunner
} = require('../server/coverage-service');

test('Current Verified Coverage counts symbol_verified plus chart_ready and keeps technical readiness separate', () => {
  const counts = coverageCounts([
    { active: true, symbol_verified: true, chart_ready: true, technical_ready: true },
    { active: true, symbol_verified: true, chart_ready: true, technical_ready: false },
    { active: true, symbol_verified: true, chart_ready: false, technical_ready: true },
    { active: false, symbol_verified: true, chart_ready: true, technical_ready: true }
  ]);
  assert.deepEqual(counts, { currentVerified: 2, technicalReady: 1 });
});

test('rolling verification preserves verified coverage on one transient failure and isolates symbols', async () => {
  const saved = [];
  const repository = {
    async beginRun() { return { alreadyCompleted: false }; },
    async listBatch() {
      return [
        { symbol: 'PTT', provider_symbol: 'PTT.BK', active: true, symbol_verified: true, chart_ready: true, technical_ready: true, failure_count: 0 },
        { symbol: 'AOT', provider_symbol: 'AOT.BK', active: true, symbol_verified: false, chart_ready: false, technical_ready: false, failure_count: 1 }
      ];
    },
    async saveResults(rows) { saved.push(...rows); },
    async counts() { return coverageCounts(saved); },
    async finishRun(payload) { this.finished = payload; }
  };
  const calls = [];
  const runner = createCoverageRunner({
    repository,
    batchSize: 125,
    concurrency: 2,
    now: () => Date.UTC(2026, 9, 18, 12),
    retrySleep: async () => {},
    verifySymbol: async symbol => {
      calls.push(symbol);
      if (symbol === 'PTT') throw Error('Yahoo Finance PTT.BK: HTTP 503');
      return { symbolVerified: true, chartReady: true, technicalReady: false, guardStatus: 'accepted', guardReason: null };
    }
  });

  const result = await runner.run({ runKey: 'Yahoo Finance:2026-10-18' });
  assert.deepEqual(calls.sort(), ['AOT', 'PTT', 'PTT']);
  const ptt = saved.find(row => row.symbol === 'PTT');
  assert.equal(ptt.status, 'temporary_failed');
  assert.equal(ptt.symbol_verified, true);
  assert.equal(ptt.chart_ready, true);
  assert.equal(ptt.technical_ready, true);
  const aot = saved.find(row => row.symbol === 'AOT');
  assert.equal(aot.status, 'verified');
  assert.equal(aot.technical_ready, false);
  assert.equal(result.attempted, 2);
  assert.equal(result.temporaryFailed, 1);
  assert.equal(result.currentVerified, 2);
});

test('completed run is idempotent and causes zero provider calls', async () => {
  let calls = 0;
  const runner = createCoverageRunner({
    repository: {
      async beginRun() { return { alreadyCompleted: true, summary: { currentVerified: 41, technicalReady: 36 } }; }
    },
    verifySymbol: async () => { calls += 1; }
  });
  const result = await runner.run({ runKey: 'Yahoo Finance:2026-10-18' });
  assert.equal(calls, 0);
  assert.equal(result.alreadyCompleted, true);
  assert.equal(result.currentVerified, 41);
});

test('rolling verification retries one transient failure without request amplification', async () => {
  let calls = 0;
  const sleeps = [];
  const saved = [];
  const runner = createCoverageRunner({
    repository: {
      async beginRun() { return { alreadyCompleted: false }; },
      async listBatch() { return [{ symbol: 'PTT', active: true }]; },
      async saveResults(rows) { saved.push(...rows); },
      async counts() { return { ...coverageCounts(saved), configuredSymbols: 1, universe: 1, success: 1, partial: 0, stale: 0, error: 0, inactive: 0, unsupported: 0 }; },
      async finishRun() {}
    },
    retrySleep: async delay => sleeps.push(delay),
    verifySymbol: async () => {
      calls += 1;
      if (calls === 1) throw Error('Yahoo Finance PTT.BK: HTTP 503');
      return { symbolVerified: true, chartReady: true, technicalReady: false, guardStatus: 'accepted' };
    }
  });
  const result = await runner.run({ runKey: 'Yahoo Finance:retry' });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [250]);
  assert.equal(result.currentVerified, 1);
});

test('coverage verification does not retry a non-transient symbol failure', async () => {
  let calls = 0;
  const saved = [];
  const runner = createCoverageRunner({
    repository: {
      async beginRun() { return { alreadyCompleted: false }; },
      async listBatch() { return [{ symbol: 'BAD', active: true, failure_count: 0 }]; },
      async saveResults(rows) { saved.push(...rows); },
      async counts() { return { ...coverageCounts(saved), configuredSymbols: 1, universe: 1, success: 0, partial: 0, stale: 0, error: 1, inactive: 0, unsupported: 0 }; },
      async finishRun() {}
    },
    retrySleep: async () => { throw Error('non-transient failures must not sleep'); },
    verifySymbol: async () => { calls += 1; throw Error('Yahoo Finance BAD.BK: HTTP 404'); }
  });
  const result = await runner.run({ runKey: 'Yahoo Finance:invalid' });
  assert.equal(calls, 1);
  assert.equal(saved[0].status, 'temporary_failed');
  assert.equal(result.error, 1);
});

test('anomaly quarantine preserves verified coverage while recording guard evidence', async () => {
  const saved = [];
  const row = { symbol: 'PTT', active: true, symbol_verified: true, chart_ready: true, technical_ready: true, status: 'verified' };
  const runner = createCoverageRunner({
    repository: {
      async beginRun() { return { alreadyCompleted: false }; },
      async listBatch() { return [row]; },
      async saveResults(rows) { saved.push(...rows); },
      async counts() { return { ...coverageCounts(saved), configuredSymbols: 1, universe: 1, success: 0, partial: 0, stale: 0, error: 1, inactive: 0, unsupported: 0 }; },
      async finishRun() {}
    },
    verifySymbol: async () => {
      const error = Error('guarded anomaly');
      error.code = 'DATA_ANOMALY';
      error.guardStatus = 'quarantined';
      error.guardReasons = ['DATA_ANOMALY'];
      throw error;
    }
  });
  const result = await runner.run({ runKey: 'Yahoo Finance:anomaly' });
  assert.equal(saved[0].status, 'temporary_failed');
  assert.equal(saved[0].symbol_verified, true);
  assert.equal(saved[0].chart_ready, true);
  assert.equal(saved[0].guard_status, 'quarantined');
  assert.equal(saved[0].guard_reason, 'DATA_ANOMALY');
  assert.equal(result.currentVerified, 1);
});

test('verified lifecycle survives a transient result, recovers, and downgrades only with confirmed evidence', async () => {
  let row = { symbol: 'PTT', active: true, symbol_verified: true, chart_ready: true, technical_ready: true, status: 'verified', failure_count: 0 };
  const outcomes = [
    Error('Yahoo Finance PTT.BK: HTTP 503'),
    Error('Yahoo Finance PTT.BK: HTTP 503'),
    { symbolVerified: true, chartReady: true, technicalReady: true, guardStatus: 'accepted' },
    { lifecycleStatus: 'inactive', lifecycleConfirmed: true, lifecycleReason: 'EXCHANGE_CONFIRMED_INACTIVE', guardStatus: 'unavailable' }
  ];
  const repository = {
    async beginRun() { return { alreadyCompleted: false }; },
    async listBatch() { return [row]; },
    async saveResults(rows) { [row] = rows; },
    async counts() {
      const current = coverageCounts([row]);
      return { ...current, configuredSymbols: 1, universe: row.active ? 1 : 0, success: row.status === 'verified' ? 1 : 0, partial: 0, stale: 0, error: row.status === 'temporary_failed' ? 1 : 0, inactive: row.status === 'inactive' ? 1 : 0, unsupported: 0 };
    },
    async finishRun() {}
  };
  const runner = createCoverageRunner({
    repository,
    retrySleep: async () => {},
    verifySymbol: async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
  });

  await runner.run({ runKey: 'Yahoo Finance:transient' });
  assert.equal(row.status, 'temporary_failed');
  assert.equal(row.symbol_verified, true);
  await runner.run({ runKey: 'Yahoo Finance:recovered' });
  assert.equal(row.status, 'verified');
  assert.equal(row.active, true);
  const inactive = await runner.run({ runKey: 'Yahoo Finance:inactive' });
  assert.equal(row.status, 'inactive');
  assert.equal(row.active, false);
  assert.equal(inactive.currentVerified, 0);
  assert.equal(inactive.inactive, 1);
});

test('coverage repository is unavailable without a server secret and exposes no value', async () => {
  const repository = createCoverageRepository({ env: { SUPABASE_URL: 'https://project.supabase.co' } });
  assert.equal(repository.configured, false);
  assert.deepEqual(await repository.summary(), {
    configured: false,
    currentVerified: null,
    technicalReady: null,
    lastChecked: null,
    provider: 'Yahoo Finance',
    dataState: 'unavailable'
  });
});

test('running coverage lease prevents duplicate work and only stale runs may resume', async () => {
  const calls = [];
  const makeRepository = startedAt => createCoverageRepository({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET' });
      if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify([{ status: 'running', started_at: startedAt }]), { status: 200 });
      return new Response('', { status: 201 });
    }
  });
  const recent = makeRepository('2026-10-18T08:00:00.000Z');
  assert.deepEqual(await recent.beginRun({
    runKey: 'Yahoo Finance:2026-10-18', startedAt: '2026-10-18T09:00:00.000Z', batchSize: 125, concurrency: 4
  }), { alreadyRunning: true });
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);

  calls.length = 0;
  const stale = makeRepository('2026-10-18T01:00:00.000Z');
  assert.deepEqual(await stale.beginRun({
    runKey: 'Yahoo Finance:2026-10-18', startedAt: '2026-10-18T09:00:00.000Z', batchSize: 125, concurrency: 4
  }), { alreadyCompleted: false, alreadyRunning: false });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('persisted coverage summary becomes stale by age instead of fabricating freshness', async () => {
  const repository = createCoverageRepository({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    fetchImpl: async () => new Response(JSON.stringify([{
      current_verified: 321,
      technical_ready: 280,
      finished_at: '2026-10-18T12:00:00.000Z',
      provider: 'Yahoo Finance',
      status: 'completed'
    }]), { status: 200 })
  });
  const summary = await repository.summary();
  assert.equal(summary.currentVerified, 321);
  assert.equal(summary.technicalReady, 280);
  assert.equal(summary.dataState, 'stale');
  assert.equal(summary.lastChecked, '2026-10-18T12:00:00.000Z');
});
