'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  coverageCounts,
  createCoverageRepository,
  createCoverageRunner
} = require('../server/coverage-service');

test('coverage persistence supports opaque secret keys and legacy service-role JWTs on reads and writes', async () => {
  const { backend } = require('./fixtures/controlled-backend.cjs');
  const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from('{"role":"service_role"}').toString('base64url'),'fixture-signature'].join('.');
  for (const key of ['sb_secret_fixture-only', jwt]) for (const name of ['SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY']) {
    const db=backend(); let reads=0,writes=0;
    const fetchImpl=(input,init={})=>{
      const headers=new Headers(init.headers);
      assert.equal(headers.get('apikey'),key);
      assert.equal(headers.get('authorization'),key.startsWith('sb_secret_')?null:'Bearer '+key);
      assert.ok(headers.get('prefer'));
      if(init.method==='PATCH')writes++;else reads++;
      return db.fetchImpl(input,init);
    };
    const repo=createCoverageRepository({env:{SUPABASE_URL:'https://fixture.supabase.co',[name]:key},fetchImpl});
    const rows=await repo.listCandidates();
    await repo.saveResults([{...rows[0],status:'verified',symbol_verified:true,chart_ready:true}],{expectedRows:rows});
    assert.equal(reads,1);assert.equal(writes,1);assert.equal(db.registry.get('PTT').symbol_verified,true);
  }
});

test('invalid persistence credentials and HTTP 401/403 stop without retry or key disclosure', async () => {
  for (const key of ['sb_secret_invalid-fixture','invalid-legacy-fixture']) for (const status of [401,403]) {
    let calls=0;
    const repo=createCoverageRepository({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:key},
      fetchImpl:async()=>{calls++;return Response.json({message:'Rejected '+key},{status});}});
    await assert.rejects(repo.listCandidates(),error=>error.status===status&&error.retryable===false&&!error.message.includes(key));
    assert.equal(calls,1);
  }
  let calls=0;
  const missing=createCoverageRepository({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:''},fetchImpl:async()=>{calls++;}});
  await assert.rejects(missing.listCandidates(),/not configured/);assert.equal(calls,0);
});

test('provider-wide stop and exhausted budget stop the manual batch without failing untouched securities', async () => {
  for (const control of [{ status: 403, stopBatch: true }, { status: 429, stopBatch: true }, { status: 503, stopBatch: true }, { skipAttempt: true }]) {
    let attempts = 0, writes = 0, finished = 0;
    const runner = createCoverageRunner({ concurrency: 1, retrySleep: async () => {},
      repository: {
        async beginRun() { return {}; },
        async listBatch() { return [{ symbol: 'FIRST', provider_symbol: 'FIRST.BK' }, { symbol: 'UNTOUCHED', provider_symbol: 'UNTOUCHED.BK' }]; },
        async saveResults() { writes++; }, async finishRun() { finished++; }
      },
      verifySymbol: async () => { attempts++; throw Object.assign(Error('Provider stopped'), control); }
    });
    await assert.rejects(runner.run({ runKey: 'fixture-stop' }), /Provider stopped/);
    assert.equal(attempts, 1); assert.equal(writes, 0); assert.equal(finished, 0);
  }
});

test('denial preserves already applied checkpoint evidence and resume never repeats successful provider work', async () => {
  const values = new Map(), saved = [], calls = [];
  const store = { withLease: async (_key, fn) => fn(),
    load: async key => structuredClone(values.get(key) || null),
    save: async (key, value) => values.set(key, structuredClone(value)) };
  const rows = ['GOOD', 'DENIED', 'UNTOUCHED'].map(symbol => ({ symbol, provider_symbol: symbol + '.BK', active: true }));
  const runner = createCoverageRunner({ checkpointStore: store, concurrency: 1, repository: {
    async beginRun() { return {}; }, async listBatch() { return rows; },
    async saveResults(results) { saved.push(...results); }
  }, verifySymbol: async symbol => {
    calls.push(symbol);
    if (symbol === 'DENIED') throw Object.assign(Error('Provider denied'), { status: 403, stopBatch: true });
    return { symbolVerified: true, chartReady: true, technicalReady: true, guardStatus: 'accepted' };
  } });
  await assert.rejects(runner.run({ runKey: 'preserve-progress' }), /Provider denied/);
  assert.deepEqual(calls, ['GOOD', 'DENIED']); assert.equal(saved.length, 1); assert.equal(saved[0].symbol, 'GOOD');
  const checkpoint = values.get('coverage-items:preserve-progress');
  assert.equal(checkpoint.entries.GOOD.status, 'applied'); assert.equal(checkpoint.entries.DENIED.status, 'inflight');
  assert.equal(checkpoint.entries.UNTOUCHED, undefined);
  await assert.rejects(runner.run({ runKey: 'preserve-progress', resume: true }), /manual reconciliation/);
  assert.deepEqual(calls, ['GOOD', 'DENIED']); assert.equal(saved.length, 1);
});

test('concurrent workers stop taking new symbols after denial and drain existing requests before returning', async () => {
  const calls = [];
  let drained = false;
  await assert.rejects(require('../server/coverage-service').mapWithConcurrency(['DENIED','INFLIGHT','UNTOUCHED'], 2, async symbol => {
    calls.push(symbol);
    if (symbol === 'DENIED') throw Object.assign(Error('denied'), { stopBatch: true });
    await new Promise(resolve => setImmediate(resolve)); drained = true; return symbol;
  }), /denied/);
  assert.deepEqual(calls, ['DENIED','INFLIGHT']); assert.equal(drained, true);
});

test('a warning-only usable chart is PARTIAL with readiness retained, never a false price verification', async () => {
  let saved;
  const runner = createCoverageRunner({ concurrency: 1, repository: {
    async beginRun() { return {}; }, async listBatch() { return [{ symbol: 'NEW', provider_symbol: 'NEW.BK', failure_count: 0 }]; },
    async saveResults(rows) { saved = rows[0]; }, async counts() { return {}; }, async finishRun() {}
  }, verifySymbol: async () => ({ symbolVerified: true, chartReady: true, technicalReady: true, guardStatus: 'suspect', guardReason: 'HISTORICAL_ANOMALY' }) });
  await runner.run({ runKey: 'fixture-warning' });
  assert.equal(saved.status, 'partial'); assert.equal(saved.chart_ready, true); assert.equal(saved.technical_ready, true);
  assert.equal(saved.last_verified_at, null); assert.equal(saved.failure_count, 0); assert.equal(saved.guard_status, 'suspect');
  const truth = require('../server/coverage-truth').coverageTruth([saved]);
  assert.equal(truth.historicalVerified, 0); assert.equal(truth.currentUsable, 0); assert.equal(truth.suspect, 1);
  const quoteOnly = require('../server/coverage-truth').coverageTruth([{ ...saved, chart_ready: false, guard_status: 'accepted' }]);
  assert.equal(quoteOnly.partial, 1); assert.equal(quoteOnly.pending, 0); assert.equal(quoteOnly.currentUsable, 0);
});

test('coverage persistence only patches an existing unchanged mapping; it cannot resurrect or reactivate a legacy row', async () => {
  const requests = [];
  const repo = createCoverageRepository({ env: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SECRET_KEY: 'fixture-not-a-secret' },
    fetchImpl: async (url, init) => { requests.push({ url: new URL(url), init }); return Response.json([{ symbol: 'NEW' }]); } });
  await repo.saveResults([{ symbol: 'NEW', provider_symbol: 'NEW.BK', provider: 'Yahoo Finance', active: true,
    status: 'verified', chart_ready: true }], { expectedRows: [{ symbol: 'NEW', last_checked_at: null }] });
  assert.equal(requests.length, 1); assert.equal(requests[0].init.method, 'PATCH');
  assert.equal(requests[0].url.searchParams.get('active'), 'eq.true');
  assert.equal(requests[0].url.searchParams.get('provider_symbol'), 'eq.NEW.BK');
  assert.equal(requests[0].url.searchParams.get('last_checked_at'), 'is.null');
  assert.deepEqual(JSON.parse(requests[0].init.body), { status: 'verified', chart_ready: true });
  const changed = createCoverageRepository({ env: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SECRET_KEY: 'fixture-not-a-secret' },
    fetchImpl: async () => Response.json([]) });
  await assert.rejects(changed.saveResults([{ symbol: 'NEW', provider_symbol: 'NEW.BK', active: true, status: 'verified' }]), /row changed/);
  const replayRequests = [];
  const replay = createCoverageRepository({ env: { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SECRET_KEY: 'fixture-not-a-secret' },
    fetchImpl: async (_url, init = {}) => { replayRequests.push(init.method || 'GET'); return Response.json(init.method === 'PATCH' ? []
      : [{ symbol: 'NEW', provider_symbol: 'NEW.BK', active: true, status: 'verified', last_checked_at: '2026-10-26T02:00:00+00:00' }]); } });
  await replay.saveResults([{ symbol: 'NEW', provider_symbol: 'NEW.BK', status: 'verified', last_checked_at: '2026-10-26T02:00:00.000Z' }],
    { expectedRows: [{ symbol: 'NEW', last_checked_at: null }] });
  assert.deepEqual(replayRequests, ['PATCH', 'GET']);
});

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
    universe: null,
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


function summaryFixture(rows, headers = {}, onRequest = () => {}) {
  return createCoverageRepository({ env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'synthetic-key' },
    now: () => Date.parse('2026-10-20T12:00:00Z'), fetchImpl: async (url, init) => {
      onRequest(url, init);return new Response(JSON.stringify(rows), { headers });
    } });
}
const verifiedFixture = (symbol, extra = {}) => ({symbol, active:true, status:'verified',symbol_verified:true,chart_ready:true,technical_ready:true,
  last_verified_at:'2026-10-18T12:00:00Z',last_checked_at:'2026-10-20T11:00:00Z',guard_status:'accepted',...extra});

test('registry snapshot separates registered PENDING, historical and current usable in one request', async () => {
  let requests=0;
  const rows=[verifiedFixture('GOOD'),verifiedFixture('FAILED',{status:'temporary_failed'}),verifiedFixture('OLD',{last_checked_at:'2026-10-18T12:00:00Z'}),
    verifiedFixture('NEW',{status:'pending',symbol_verified:false,chart_ready:false,technical_ready:false,last_verified_at:null,last_checked_at:null,guard_status:null})];
  const summary=await summaryFixture(rows,{},url=>{requests++;assert.match(String(url),/security_coverage/);}).summary();
  assert.equal(requests,1);assert.equal(summary.universe,4);assert.equal(summary.currentVerified,3);
  assert.equal(summary.historicalVerified,3);assert.equal(summary.currentUsable,1);assert.equal(summary.pending,1);
  assert.equal(summary.temporaryFailed,1);assert.equal(summary.stale,1);assert.equal(summary.dataState,'fresh');
});
test('old checked rows stay stale; registration alone cannot claim fresh quote coverage', async () => {
  const r=await summaryFixture([verifiedFixture('OLD',{last_checked_at:'2026-10-18T12:00:00Z'})]).summary();
  assert.equal(r.dataState,'stale');assert.equal(r.currentUsable,0);assert.equal(r.historicalVerified,1);
  const p=await summaryFixture([verifiedFixture('NEW',{status:'pending',symbol_verified:false,chart_ready:false,last_verified_at:null,last_checked_at:null})]).summary();
  assert.equal(p.universe,1);assert.equal(p.currentUsable,0);assert.equal(p.dataState,'unavailable');
});
test('empty registry has truthful zero counts without fabricating check time', async () => {
  const s=await summaryFixture([]).summary();assert.equal(s.universe,0);assert.equal(s.lastChecked,null);assert.equal(s.dataState,'unavailable');
});
test('invalid and incomplete database responses fail closed', async () => {
  await assert.rejects(summaryFixture([{universe:100,current_verified:101}]).summary(),/Invalid coverage/);
  await assert.rejects(summaryFixture([verifiedFixture('ONE')],{'content-range':'0-0/2'}).summary(),/Invalid coverage/);
});
test('more than one page is read completely with a finite query bound', async () => {
  let calls=0;const rows=Array.from({length:1001},(_,i)=>verifiedFixture('S'+i));
  const repo=createCoverageRepository({env:{SUPABASE_URL:'https://project.supabase.co',SUPABASE_SECRET_KEY:'synthetic-key'},now:()=>Date.parse('2026-10-20T12:00:00Z'),
    fetchImpl:async url=>{calls++;const offset=Number(new URL(url).searchParams.get('offset'));const page=rows.slice(offset,offset+1000);
      return new Response(JSON.stringify(page),{headers:{'content-range':offset+'-'+(offset+page.length-1)+'/1001'}});}});
  assert.equal((await repo.summary()).universe,1001);assert.equal(calls,2);
});
