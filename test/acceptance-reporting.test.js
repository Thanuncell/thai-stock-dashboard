'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {coverageTruth}=require('../server/coverage-truth');
const {main}=require('../scripts/run-v156-batch20');
const {backend}=require('./fixtures/controlled-backend.cjs');
const {createControlledCoverageStore,CONTROL_KEY}=require('../server/controlled-coverage-store');
const NOW=Date.parse('2026-10-26T11:00:00Z');
const env={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:'Thanuncell/thai-stock-dashboard',GITHUB_REPOSITORY_OWNER:'Thanuncell',GITHUB_ACTOR:'Thanuncell',GITHUB_RUN_ID:'555000',GITHUB_RUN_ATTEMPT:'1'};
test('public verified count counts each in-scope stock once despite overlapping internal states',async()=>{
 const base={active:true,last_verified_at:new Date(NOW-8*86400000).toISOString(),symbol_verified:true,chart_ready:true,guard_status:'stale'};
 const truth=coverageTruth([{...base,status:'temporary_failed'},{...base,status:'verified'},{...base,active:false,status:'inactive'}],{now:NOW});
 assert.equal(truth.historicalVerified,3);assert.equal(truth.stale,2);assert.equal(truth.temporaryFailed,1);assert.equal(truth.verifiedInScope,2);
 const {coverageDisplayState}=await import('../client/domain.mjs');
 assert.equal(coverageDisplayState({configured:true,provider:'Yahoo Finance',dataState:'stale',lastChecked:new Date(NOW).toISOString(),universe:2,...truth}).verifiedInScope,2);
 assert.equal(coverageDisplayState({configured:true,provider:'Yahoo Finance',dataState:'fresh',lastChecked:new Date(NOW).toISOString(),universe:1,...truth}).reason,'invalid');
 const html=fs.readFileSync('index.html','utf8').split('id="coverage-summary"')[1].split('</section>')[0];
 assert.equal((html.match(/<span>/g)||[]).length,2);assert.doesNotMatch(html,/coverage-status/);
});
for(const kind of ['insufficient','quota','coordinator'])test(`blocked ${kind} reports no job failure or unknown attempts`,async()=>{
 const db=backend({symbols:Array.from({length:kind==='insufficient'?19:20},(_,i)=>'S'+i)});
 if(kind!=='insufficient'){
  const store=createControlledCoverageStore({env:{...env,SETSCOPE_V156_MANUAL_VERIFY:'1'},fetchImpl:db.fetchImpl,now:()=>NOW});
  await store.beginRun({runKey:CONTROL_KEY,startedAt:new Date(NOW).toISOString(),batchSize:5,concurrency:1});
  if(kind==='quota'){await store.updateMetadata({day:'2026-10-26',reservations:1});await store.releaseCoordinator('completed');}
 }
 db.calls.length=0;
 await assert.rejects(main({env,fetchImpl:db.fetchImpl,now:()=>NOW}),e=>{
  const r=e.report;assert.equal(r.status,'BLOCKED');assert.equal(r.jobsStarted,0);assert.equal(r.attempted,0);
  assert.equal(Object.hasOwn(r,'failedJob'),false);assert.equal(Object.hasOwn(r,'incompleteJobCounts'),false);
  assert.equal(r.preflight.dueCount,kind==='insufficient'?19:20);assert.equal(r.preflight.requiredCount,20);
  assert.equal(r.preflight.quotaRemaining.jobs,kind==='quota'?3:4);assert.ok(r.preflight.reasonCode);assert.ok(r.preflight.coordinator);assert.ok(r.preflight.checkpoint);return true;
 });
 assert.ok(db.calls.every(c=>['GET','HEAD'].includes(c.method)));assert.equal(db.calls.some(c=>c.url.hostname==='query1.finance.yahoo.com'),false);
});
