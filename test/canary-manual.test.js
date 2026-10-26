'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {backend}=require('./fixtures/controlled-backend.cjs');
const {SYMBOLS,RUN_KEY}=require('../server/canary-policy');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {createRequestDeadline}=require('../server/request-deadline');
const {main}=require('../scripts/run-v156-canary');
const NOW=Date.parse('2026-10-26T10:00:00Z');
function fixture(){
 const db=backend({symbols:[...SYMBOLS,'OUTSIDE']});
 for(const r of db.registry.values())Object.assign(r,{status:'verified',symbol_verified:true,chart_ready:true,technical_ready:true,guard_status:'accepted',last_checked_at:new Date(NOW-1000).toISOString()});
 return db;
}
const env=()=>({GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',SETSCOPE_CANARY_APPROVED:'1',SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_V156_KILL:'1'});
const run=(db,extra={})=>main({env:env(),fetchImpl:db.fetchImpl,now:()=>NOW,...extra});
test('manual workflow has no automatic trigger or deployment and owner/main gates are mandatory',()=>{
 const text=fs.readFileSync('.github/workflows/canary-verify.yml','utf8');
 assert.match(text,/name: SETscope Canary Verify/);assert.match(text,/workflow_dispatch:/);
 assert.doesNotMatch(text,/schedule:|\bpush:|pull_request:|workflow_run:|render\.com/);
 assert.match(text,/github.actor == github.repository_owner/);assert.match(text,/persist-credentials: false/);
});
test('canary is exact, runs once across days and does not move normal coverage clocks',async()=>{
 const db=fixture(),before=structuredClone(db.registry.get('OUTSIDE')),settings=env();
 const result=await run(db);
 assert.equal(result.canaryCounts.before.verified,6);assert.equal(result.canaryCounts.after.verified,6);
 assert.equal(result.attempted,5);assert.equal(result.verified,5);assert.equal(result.canaryCounts.outsideUnchanged,true);
 assert.deepEqual(db.registry.get('OUTSIDE'),before);assert.equal(settings.SETSCOPE_V156_KILL,'1');
 assert.equal(db.calls.filter(c=>c.url.hostname==='query1.finance.yahoo.com').length,5);
 assert.ok(result.metrics.providerCalls<=10);assert.ok(result.metrics.databaseReads+result.metrics.databaseWrites<=200);
 const clock=db.runs.get('v156:control').automation_state.metadata.coverageChecks.PTT;
 assert.equal(clock,new Date(NOW-1000).toISOString());
 await assert.rejects(run(db,{now:()=>NOW+86400000}));
 assert.equal(db.calls.filter(c=>c.url.hostname==='query1.finance.yahoo.com').length,5);
 assert.ok(db.runs.has(RUN_KEY));
});
test('invalid mappings, inactive or degraded sample abort before writes/provider calls',async()=>{
 for(const patch of [{provider_symbol:'SCB.BK'},{active:false},{status:'partial'},{chart_ready:false}]){
  const db=fixture();Object.assign(db.registry.get('PTT'),patch);await assert.rejects(run(db));
  assert.ok(db.calls.every(c=>c.method==='GET'));assert.equal(db.runs.size,0);
 }
});
test('approval cannot be supplied from a branch or HTTP request',async()=>{
 for(const patch of [{GITHUB_REF:'refs/heads/other'},{GITHUB_ACTIONS:'false'},{SETSCOPE_CANARY_APPROVED:'0'}]){
  const db=fixture();await assert.rejects(run(db,{env:{...env(),...patch}}));assert.equal(db.calls.length,0);
 }
 const db=fixture();const normal=createControlledCoverage({env:{...env(),SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_KILL:'0'},fetchImpl:db.fetchImpl,now:()=>NOW});
 assert.equal((await normal.execute()).attempted,0); // ordinary seven-day rule stays intact
});
test('transient failures and rate limits preserve every outside-canary row',async()=>{
 for(const status of [503,429]){
  const db=fixture(),before=structuredClone([...db.registry.values()]);
  const fetchImpl=(input,init)=>new URL(String(input)).hostname==='query1.finance.yahoo.com'?Promise.resolve(Response.json({}, {status})):db.fetchImpl(input,init);
  try{await run(db,{fetchImpl});}catch{}
  assert.deepEqual(db.registry.get('OUTSIDE'),before.find(r=>r.symbol==='OUTSIDE'));
  for(const r of db.registry.values()){assert.equal(r.symbol_verified,true);assert.equal(r.chart_ready,true);}
  assert.equal([...db.registry.values()].filter(r=>r.symbol_verified&&r.chart_ready).length,before.length);
  assert.ok([...db.registry.values()].filter(r=>r.status==='verified').length>=before.length-5);
 }
});
test('absolute deadline aborts a hanging provider, preserves uncertainty and prohibits replay',async()=>{
 const db=fixture();let signal;
 const fetchImpl=(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){signal=init.signal;return new Promise(()=>{});}
  return db.fetchImpl(input,init);
 };
 await assert.rejects(run(db,{fetchImpl,deadline:createRequestDeadline({durationMs:250})}));
 assert.equal(signal.aborted,true);
 const entries=db.runs.get(RUN_KEY).automation_state.documents['coverage-items:'+RUN_KEY].entries;
 assert.ok(Object.values(entries).some(e=>e.status==='inflight'));
 await assert.rejects(run(db));
});
test('deadline also cancels response-body reads and explicit cancellation',async()=>{
 const d=createRequestDeadline({durationMs:20});let signal;
 const fetch=d.wrap(async(_,init)=>{signal=init.signal;return {json:()=>new Promise(()=>{})};});
 await assert.rejects(d.run(async()=>{const response=await fetch('https://fixture.supabase.co');await response.json();}));
 assert.equal(signal.aborted,true);d.close();
 const cancelled=createRequestDeadline();cancelled.abort();await assert.rejects(cancelled.run(()=>Promise.resolve()));cancelled.close();
});
test('a lost database write response retains checked evidence and cannot replay the canary',async()=>{
 const db=fixture();let signal,writeCount=0;
 const fetchImpl=async(input,init={})=>{
  if(new URL(String(input)).pathname.endsWith('/security_coverage')&&init.method==='PATCH'){
   signal=init.signal;writeCount++;await db.fetchImpl(input,init);return new Promise(()=>{});
  }
  return db.fetchImpl(input,init);
 };
 await assert.rejects(run(db,{fetchImpl,deadline:createRequestDeadline({durationMs:250})}));
 assert.equal(signal.aborted,true);assert.equal(writeCount,1);
 const documents=db.runs.get(RUN_KEY).automation_state.documents;
 assert.ok(Object.values(documents['coverage-items:'+RUN_KEY].entries).some(e=>e.status==='checked'));
 await assert.rejects(run(db));assert.equal(writeCount,1);
});
