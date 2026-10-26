'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { executionWindow, selectCoverage, tradingDay, sessionReady } = require('../server/automation-policy');
const { safeCheckpoint } = require('../server/checkpoint-safety');
const { createControlledCoverage } = require('../server/controlled-coverage');
const { reviewReferenceChanges } = require('../server/reference-review');
const { backend } = require('./fixtures/controlled-backend.cjs');
const NOW = Date.parse('2026-10-26T11:00:00Z');
const env = () => ({ SUPABASE_URL:'https://fixture.supabase.co', SUPABASE_SECRET_KEY:'synthetic-fixture', SETSCOPE_V156_MANUAL_VERIFY:'1' });

test('Bangkok market calendar skips weekends, ordinary/special holidays, early EOD and unreviewed years', async () => {
  assert.equal(tradingDay('2026-10-16'), false); assert.equal(tradingDay('2026-10-23'), false);
  assert.equal(tradingDay('2026-10-26'), true); assert.equal(tradingDay('2026-02-30'), null);
  for (const [date,mode,reason] of [['2026-10-25T11:00:00Z','coverage','NON_TRADING_DAY'],
    ['2026-10-16T11:00:00Z','eod','NON_TRADING_DAY'], ['2026-10-26T09:00:00Z','eod','PROVIDER_NOT_READY'],
    ['2027-01-04T11:00:00Z','coverage','CALENDAR_UNAVAILABLE']]) {
    let calls = 0;
    const controller = createControlledCoverage({ env:env(), now:()=>Date.parse(date), fetchImpl:()=>{calls++;throw Error('unexpected traffic');} });
    const result = await controller.execute({ mode });
    assert.equal(result.skipped,true);assert.equal(result.reason,reason);assert.equal(calls,0);
  }
  assert.equal(executionWindow({now:NOW,mode:'eod'}).session,'2026-10-26');
  assert.equal(executionWindow({now:NOW,mode:'eod',recover:true,session:'2026-10-22'}).reason,'MISSED_JOB_OBSOLETE');
  assert.equal(executionWindow({now:Date.parse('2026-10-26T07:00:00Z'),mode:'eod',recover:true,session:'2026-10-22'}).eligible,true);
});

test('bounded selection prioritizes pending/unverified/stale and preserves fresh, cooldown and inactive legacy rows', () => {
  const row = (symbol,fields={}) => ({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified',
    symbol_verified:true,chart_ready:true,last_checked_at:new Date(NOW).toISOString(),...fields});
  const input=[row('FRESH'),row('PENDING',{status:'pending',symbol_verified:false,last_checked_at:null}),
    row('UNVERIFIED',{symbol_verified:false,last_checked_at:null}),row('STALE',{last_checked_at:'2026-10-20T10:00:00Z'}),
    row('PARTIAL',{status:'partial',last_checked_at:'2026-10-26T00:00:00Z'}),row('RETRY',{status:'temporary_failed'}),
    row('LEGACY',{active:false,provider_symbol:'legacy-alias'})];
  const before=structuredClone(input), selected=selectCoverage(input,{now:NOW});
  assert.deepEqual(selected.map(row=>row.symbol),['PENDING','UNVERIFIED','STALE','PARTIAL']);assert.deepEqual(input,before);
  assert.throws(()=>selectCoverage([row('ONE',{provider_symbol:'../bad'})],{now:NOW}),/IDENTITY/);
});

test('checkpoint manifest excludes secrets, unknown fields and oversized content before persistence', () => {
  const manifest={rows:[{symbol:'PTT',provider_symbol:'PTT.BK',provider:'Yahoo Finance'}],batchSize:5,provider:'Yahoo Finance'};
  assert.deepEqual(safeCheckpoint(manifest),manifest);
  assert.throws(()=>safeCheckpoint({...manifest,token:'fixture'}),/SENSITIVE/);
  assert.throws(()=>safeCheckpoint({...manifest,rows:[{...manifest.rows[0],guard_reason:'private credential message'}]}),/VALUE_INVALID/);
  assert.throws(()=>safeCheckpoint({...manifest,rows:[{...manifest.rows[0],guard_reason:'LEAKED_FIXTURE'}]},
    {SUPABASE_SECRET_KEY:'LEAKED_FIXTURE'}),/SENSITIVE_VALUE/);
  assert.throws(()=>safeCheckpoint({...manifest,extra:'x'.repeat(600000)}),/TOO_LARGE/);
});

test('different job keys contend for one durable coordinator; daily budget survives new controller instances', async () => {
  const db=backend({symbols:['PTT','AOT','KBANK','CPALL','ADVANC','BBL']});db.advance(NOW,35);
  let started,release,providerCalls=0;
  const entered=new Promise(resolve=>{started=resolve;}), blocked=new Promise(resolve=>{release=resolve;});
  const fetchImpl=async(input,init)=>{
    if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){
      providerCalls++;if(providerCalls===1){started();await blocked;}
    }
    return db.fetchImpl(input,init);
  };
  const make=()=>createControlledCoverage({env:env(),fetchImpl,now:()=>NOW});
  const first=make().execute({tag:'a'});await entered;
  assert.equal((await make().execute({tag:'b'})).alreadyRunning,true);assert.equal(providerCalls,1);
  release();assert.equal((await first).attempted,5);
  assert.equal((await make().execute({tag:'b'})).attempted,1);assert.equal(providerCalls,6);
  await assert.rejects(make().execute({tag:'c'}),/DAILY_JOB_BUDGET/);assert.equal(providerCalls,6);
});

test('pause after an applied symbol resumes from durable evidence without refetching the provider', async () => {
  const db=backend();db.advance(NOW,35);let paused=false;
  const make=()=>createControlledCoverage({env:env(),fetchImpl,now:()=>NOW});
  const fetchImpl=async(input,init={})=>{
    const result=await db.fetchImpl(input,init);
    if(!paused && new URL(String(input)).pathname.endsWith('/security_coverage') && init.method==='PATCH'){
      paused=true;await make().execute({operation:'pause',runKey:'v156:coverage:2026-10-26:manual-1'});
    }
    return result;
  };
  await assert.rejects(make().execute());
  assert.equal(db.runs.get('v156:coverage:2026-10-26:manual-1').automation_state.phase,'paused');
  assert.equal((await make().execute({resume:true})).verified,1);
  assert.equal(db.calls.filter(call=>call.url.hostname==='query1.finance.yahoo.com').length,1);
});

test('transient retries are bounded; persistent cooldown permits safe resume without replaying applied work', async () => {
  const db=backend({symbols:['A','B','C','D','E']});let time=NOW,calls=0,fail=true;db.advance(NOW,35);
  const fetchImpl=(input,init)=>{
    if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){calls++;if(fail)return Promise.resolve(Response.json({}, {status:503}));}
    return db.fetchImpl(input,init);
  };
  const make=()=>createControlledCoverage({env:env(),fetchImpl,now:()=>time,retrySleep:async()=>{}});
  await assert.rejects(make().execute(),/CIRCUIT_OPEN/);assert.equal(calls,3);
  await assert.rejects(make().execute({resume:true}),/CIRCUIT_OPEN/);assert.equal(calls,3);
  time+=300001;fail=false;db.advance(time,35);
  const result=await make().execute({resume:true});assert.equal(result.attempted,5);assert.equal(calls,7);
  assert.equal(result.temporaryFailed,1); // The already applied first failed symbol is not fetched again.
});

test('per-security no-data responses do not count as provider-wide transient failures', async () => {
  const db=backend({symbols:['A','B','C','D']});let calls=0;
  const fetchImpl=(input,init)=>new URL(String(input)).hostname==='query1.finance.yahoo.com'
    ? Promise.resolve(Response.json({}, {status:++calls<=3?404:503})) : db.fetchImpl(input,init);
  const result=await createControlledCoverage({env:env(),fetchImpl,now:()=>NOW,retrySleep:async()=>{}}).execute();
  assert.equal(result.attempted,4);assert.equal(result.temporaryFailed,4);assert.equal(calls,5);
});

test('EOD refuses a previous-session quote/history instead of claiming fresh verification', async () => {
  const db=backend();db.advance(Date.parse('2026-10-22T09:30:00Z'),35);
  const result=await createControlledCoverage({env:env(),fetchImpl:db.fetchImpl,now:()=>NOW}).execute({mode:'eod'});
  assert.equal(result.verified,0);assert.equal(db.registry.get('PTT').status,'temporary_failed');
  assert.equal(sessionReady({quoteReady:true,chartReady:true,guardStatus:'accepted',asOf:new Date(NOW).toISOString(),historyAsOf:'2026-10-22T09:30:00Z'},'2026-10-26'),false);
});

test('an eligible EOD run verifies only matching quote and candle sessions and signals cache refresh', async () => {
  const db=backend();db.advance(NOW,35);const refreshed=[];
  const result=await createControlledCoverage({env:env(),fetchImpl:db.fetchImpl,now:()=>NOW,
    onVerified:(symbol,verification)=>refreshed.push({symbol,...verification})}).execute({mode:'eod'});
  assert.equal(result.verified,1);assert.equal(refreshed.length,1);
  assert.equal(sessionReady(refreshed[0],'2026-10-26'),true);
});

test('intraday coverage cannot suppress EOD refresh and completed EOD symbols are not repeated in another batch', async () => {
  const db=backend();db.advance(NOW,35);
  const row=db.registry.get('PTT');Object.assign(row,{status:'verified',symbol_verified:true,chart_ready:true,last_checked_at:new Date(NOW-60000).toISOString()});
  const make=()=>createControlledCoverage({env:env(),fetchImpl:db.fetchImpl,now:()=>NOW});
  assert.equal((await make().execute({mode:'eod',tag:'a'})).verified,1);
  assert.equal((await make().execute({mode:'eod',tag:'b'})).attempted,0);
  assert.equal(db.calls.filter(call=>call.url.hostname==='query1.finance.yahoo.com').length,1);
  assert.ok(db.runs.has('v156:eod:2026-10-26:a'));
});

test('Security Master and Tick Size proposals require review and cannot modify accepted state', () => {
  const baseline=[{symbol:'PTT',providerSymbol:'PTT.BK',market:'SET',instrumentType:'COMMON_STOCK'}];
  const input={kind:'securityMaster',baseline,candidate:[...baseline,{symbol:'NEW',providerSymbol:'NEW.BK',market:'MAI',instrumentType:'COMMON_STOCK'}],
    source:'https://example.test/fixture-list',effectiveDate:'2026-10-26'};
  const before=structuredClone(input),review=reviewReferenceChanges(input);
  assert.equal(review.changed,true);assert.equal(review.reviewRequired,true);assert.equal(review.applied,false);assert.deepEqual(input,before);
  assert.throws(()=>reviewReferenceChanges({...input,candidate:[...baseline,...baseline]}),/Duplicate/);
  const tick=reviewReferenceChanges({...input,kind:'tickSize',baseline:[{from:0,to:null,tickSize:0.01}],candidate:[{from:0,to:null,tickSize:0.02}]});
  assert.equal(tick.changed,true);assert.equal(tick.applied,false);
  assert.ok(!JSON.stringify(reviewReferenceChanges({...input,source:'https://example.test/list?token=synthetic-sensitive-query'})).includes('synthetic-sensitive-query'));
});
