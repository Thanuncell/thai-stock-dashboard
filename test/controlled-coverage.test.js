'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createControlledCoverageStore, LEASE_MS } = require('../server/controlled-coverage-store');
const { createControlledCoverage, createManualCoverageHandler, authorized, manualSignature } = require('../server/controlled-coverage');
const { createCheckpointBatch } = require('../server/coverage-checkpoint');
const { manualRunKey } = require('../server/v156-manual-claim');
const { main } = require('../scripts/run-v156-manual-coverage');

const NOW = Date.parse('2026-10-26T10:00:00Z');
const env = () => ({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'synthetic-fixture', SETSCOPE_V156_MANUAL_VERIFY: '1' });
const args = { runKey: 'v156:coverage:2026-10-26:manual-1', startedAt: new Date(NOW).toISOString(), batchSize: 5, concurrency: 1 };

const { backend } = require('./fixtures/controlled-backend.cjs');

test('manual keys use Bangkok dates and reject malformed tags', () => {
  assert.equal(manualRunKey({ date: new Date('2026-10-25T18:00:00Z') }), args.runKey);
  assert.throws(() => manualRunKey({ tag: '../oops' }));
  assert.throws(() => manualRunKey({ date: new Date('bad') }));
});

test('OFF, kill switch, invalid limits and missing configuration make zero requests', async () => {
  const db = backend();
  for (const settings of [{}, { ...env(), SETSCOPE_V156_MANUAL_VERIFY: '0' }, { ...env(), SETSCOPE_V156_KILL: '1' }]) {
    const store = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl });
    await assert.rejects(store.beginRun(args));
  }
  const store = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl });
  for (const input of [{ ...args, concurrency: 2 }, { ...args, batchSize: 21 }, { ...args, runKey: 'bad' }]) await assert.rejects(store.beginRun(input));
  await assert.rejects(main({ env: {}, controller: { execute() { throw Error('must not execute'); } } }));
  assert.equal(db.calls.length, 0);
});

test('two independent simultaneous claimants persist exactly one owner and cannot overwrite a completed run', async () => {
  const db = backend();
  const a = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW });
  const b = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW });
  const results = await Promise.all([a.beginRun(args), b.beginRun(args)]);
  assert.equal(db.runs.size, 1);
  assert.equal(results.filter(r => r.alreadyRunning).length, 1);
  assert.equal(db.calls.filter(c => c.method === 'POST').length, 2);
  const winner = results[0].alreadyRunning ? b : a;
  await winner.finishRun({ runKey: args.runKey, finishedAt: new Date(NOW).toISOString() });
  const before = structuredClone(db.runs.get(args.runKey));
  const c = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW });
  assert.equal((await c.beginRun(args)).alreadyCompleted, true);
  assert.deepEqual(db.runs.get(args.runKey), before);
});

test('restart preserves checked results and resumes apply without a second provider call', async () => {
  const db = backend(), settings = env();
  let time = NOW, providerCalls = 0, fail = true;
  const build = store => createCheckpointBatch({ store: store.checkpointStore,
    verify: async () => { providerCalls++; return { status: 'verified' }; },
    apply: async () => { if (fail) throw Error('fixture interrupted apply'); } });
  const first = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => time });
  await first.beginRun(args);
  const rows = [{ symbol: 'PTT', provider_symbol: 'PTT.BK', active: true }];
  await assert.rejects(build(first).run({ runKey: 'coverage-items:' + args.runKey, rows }), /interrupted apply/);
  assert.equal((await first.status(args.runKey)).requiresReconciliation, false);
  time += LEASE_MS + 1;
  const restarted = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => time });
  await restarted.beginRun({ ...args, resume: true });
  fail = false;
  await build(restarted).run({ runKey: 'coverage-items:' + args.runKey, rows });
  assert.equal(providerCalls, 1);
  await assert.rejects(first.assertActive(), /LEASE_LOST/);
});

test('unknown inflight provider response blocks restart and does not silently replay', async () => {
  const db = backend(); let time = NOW, calls = 0;
  const first = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => time });
  await first.beginRun(args);
  const batch = createCheckpointBatch({ store: first.checkpointStore,
    verify: async () => { calls++; throw Error('fixture lost response'); }, apply: async () => assert.fail('must not apply') });
  await assert.rejects(batch.run({ runKey: 'coverage-items:' + args.runKey, rows: [{ symbol: 'PTT', provider_symbol: 'PTT.BK' }] }));
  assert.equal((await first.status(args.runKey)).requiresReconciliation, true);
  time += LEASE_MS + 1;
  const restarted = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => time });
  await assert.rejects(restarted.beginRun({ ...args, resume: true }), /RECONCILIATION/);
  assert.equal(calls, 1);
  await assert.rejects(restarted.reconcile(args.runKey,false),/REVIEW_REQUIRED/);
  assert.equal((await restarted.reconcile(args.runKey,true)).replayed,false);
  assert.equal((await restarted.status(args.runKey)).requiresReconciliation,false);
  await assert.rejects(restarted.beginRun({...args,resume:true}),/JOB_STOPPED/);
  assert.equal(calls,1);
});

test('simultaneous expired-lease recovery has one winner and fences the old owner', async () => {
  const db = backend(); let time = NOW;
  const make = () => createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => time });
  const first = make(); await first.beginRun(args); time += LEASE_MS + 1;
  const results = await Promise.allSettled([make().beginRun({ ...args, resume: true }), make().beginRun({ ...args, resume: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && !r.value.alreadyRunning).length, 1);
  await assert.rejects(first.checkpointStore.save('coverage-manifest:' + args.runKey, {}), /LEASE_LOST/);
});

test('durable pause and stop fence an active job; stopped runs cannot resume', async () => {
  const db = backend(), settings = env();
  const first = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => NOW });
  const control = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => NOW });
  await first.beginRun(args);
  await control.control(args.runKey, 'paused');
  await assert.rejects(first.assertActive());
  await control.control(args.runKey, 'stopped');
  assert.equal((await control.status(args.runKey)).phase, 'stopped');
  await assert.rejects(control.beginRun({ ...args, resume: true }), /JOB_STOPPED/);
});

test('runtime kill prevents all further persistence requests', async () => {
  const db = backend(), settings = env();
  const store = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => NOW });
  await store.beginRun(args); const requests = db.calls.length; settings.SETSCOPE_V156_KILL = '1';
  await assert.rejects(store.assertActive(), /AUTOMATION_DISABLED/);
  await assert.rejects(store.status(args.runKey), /AUTOMATION_DISABLED/);
  assert.equal(db.calls.length, requests);
});

test('persistence request ceiling stops before a hidden extra request', async () => {
  const db = backend();
  const store = createControlledCoverageStore({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW, maxRequests: 10 });
  await store.beginRun(args);
  for (let i = 0; i < 9; i++) await store.status(args.runKey);
  await assert.rejects(store.status(args.runKey), /PERSISTENCE_BUDGET/);
  assert.equal(db.calls.length, 10);
});

test('provider denial stops the batch without retrying or changing untouched securities', async () => {
  for (const status of [401, 403, 429]) {
    const db = backend({ symbols: ['PTT', 'AOT'] }); let providerCalls = 0;
    const control = createControlledCoverage({ env: env(), now: () => NOW, fetchImpl: (input, init) => {
      if (new URL(String(input)).hostname === 'query1.finance.yahoo.com') { providerCalls++; return Promise.resolve(Response.json({}, { status })); }
      return db.fetchImpl(input, init);
    } });
    await assert.rejects(control.execute());
    assert.equal(providerCalls, 1);
    assert.ok([...db.registry.values()].every(row => row.status === 'pending'));
    assert.equal(db.runs.get(args.runKey).status, 'failed');
    await assert.rejects(control.execute({ resume: true }), /CIRCUIT_OPEN|RECONCILIATION/);
    assert.equal(providerCalls, 1);
  }
});

test('existing runner and real Data Guard integrate with durable checkpoint and measured database writes', async t => {
  const db = backend({ symbols: ['PTT', 'AOT', 'KBANK', 'CPALL', 'ADVANC'] });
  const control = createControlledCoverage({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW });
  const result = await control.execute();
  assert.equal(result.attempted, 5); assert.equal(result.verified, 5);
  assert.equal(result.metrics.providerCalls, 5);
  assert.equal(result.metrics.databaseWrites, db.calls.filter(c => c.url.hostname === 'fixture.supabase.co' && ['POST','PATCH'].includes(c.method)).length);
  assert.equal(result.metrics.databaseReads, db.calls.filter(c => c.url.hostname === 'fixture.supabase.co' && ['GET','HEAD'].includes(c.method)).length);
  assert.equal(db.runs.get(args.runKey).status, 'completed');
  assert.equal((await control.execute()).alreadyCompleted, true);
  assert.equal(db.calls.filter(c => c.url.hostname === 'query1.finance.yahoo.com').length, 5);
  assert.equal(result.schedulerEnabled, false);
  t.diagnostic(JSON.stringify({ fixtureSymbols: 5, ...result.metrics }));
});

test('missing reviewed column blocks before any provider traffic or registry write', async () => {
  const db = backend({ schemaReady: false });
  const control = createControlledCoverage({ env: env(), fetchImpl: db.fetchImpl, now: () => NOW });
  await assert.rejects(control.execute(), /SCHEMA_OR_INPUT/);
  assert.equal(db.calls.filter(c => c.url.hostname === 'query1.finance.yahoo.com').length, 0);
  assert.equal(db.registry.get('PTT').status, 'pending');
});

test('conflicting persisted completion state is rejected instead of reporting success', async () => {
  const db = backend(), settings = env();
  const store = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => NOW });
  await store.beginRun(args);
  db.runs.get(args.runKey).status = 'completed';
  const duplicate = createControlledCoverageStore({ env: settings, fetchImpl: db.fetchImpl, now: () => NOW });
  await assert.rejects(duplicate.beginRun(args), /CHECKPOINT_STATUS_CONFLICT/);
});

test('trigger auth, method, disabled state and error redaction work over HTTP', async t => {
  const settings = { SETSCOPE_V156_TRIGGER_TOKEN: 'fixture-'.repeat(6) };
  let reads = 0, executions = 0;
  const controller = { enabled() { if (settings.SETSCOPE_V156_KILL) throw Object.assign(Error('SECRET fixture'), { code: 'AUTOMATION_DISABLED' }); },
    execute() { executions++; throw Error('SECRET fixture'); } };
  const handler = createManualCoverageHandler({ controller, env: settings, readJson: async () => { reads++; return {}; },
    send(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } });
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(reads, 0); assert.equal(executions, 0);
  const headers = { authorization: 'Bearer ' + settings.SETSCOPE_V156_TRIGGER_TOKEN };
  assert.equal((await fetch(url, { headers })).status, 405);
  settings.SETSCOPE_V156_KILL = '1';
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 503);
  assert.equal(reads, 0);
  delete settings.SETSCOPE_V156_KILL;
  assert.equal((await fetch(url, { method: 'POST', headers })).status, 401);
  const expired = String(Date.now() - 61000);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers,
    'x-setscope-sent-at': expired, 'x-setscope-signature': manualSignature({}, settings.SETSCOPE_V156_TRIGGER_TOKEN, expired) } })).status, 401);
  const timestamp = String(Date.now());
  const response = await fetch(url, { method: 'POST', headers: { ...headers,
    'x-setscope-sent-at': timestamp, 'x-setscope-signature': manualSignature({}, settings.SETSCOPE_V156_TRIGGER_TOKEN, timestamp) } });
  assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /SECRET|fixture/);
  assert.equal(authorized('Bearer short', 'short'), false);
});
