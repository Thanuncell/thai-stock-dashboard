'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {main}=require('../scripts/run-v156-scaling');
const {backend}=require('./fixtures/controlled-backend.cjs');
const {createControlledCoverageStore,CONTROL_KEY}=require('../server/controlled-coverage-store');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {approval}=require('../server/manual-batch-policy');
const {createRequestDeadline}=require('../server/request-deadline');
const {bangkokDay,tradingDay}=require('../server/automation-policy');
const {RUN_KEY:CANARY}=require('../server/canary-policy');
const NOW=Date.parse('2026-10-26T11:00:00Z');
const env={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',
 GITHUB_REPOSITORY:'Thanuncell/thai-stock-dashboard',GITHUB_REPOSITORY_OWNER:'Thanuncell',GITHUB_ACTOR:'Thanuncell',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'1000',SETSCOPE_SCALE_CONFIRMATION:'RUN COVERAGE 20'};
function fixture(size){
 const db=backend({symbols:Array.from({length:size},(_,i)=>'S'+String(i).padStart(4,'0'))});db.advance(NOW,35);
 db.registry.set('OUTSIDE',{symbol:'OUTSIDE',provider_symbol:'OUTSIDE.BK',provider:'Yahoo Finance',active:false,status:'inactive',symbol_verified:false,chart_ready:false,technical_ready:false,last_checked_at:null});
 db.runs.set(CANARY,{run_key:CANARY,status:'completed',attempted:5,verified:5,temporary_failed:0,partial:5,
  automation_state:{version:1,revision:0,owner:'synthetic',leaseUntil:new Date(NOW-1).toISOString(),phase:'completed',documents:{}}});return db;
}
const providerCalls=db=>db.calls.filter(c=>c.url.hostname==='query1.finance.yahoo.com').length;
const writes=db=>db.calls.filter(c=>!['GET','HEAD'].includes(c.method)).length;
const options=(stage,id,runId=id)=>({...env,GITHUB_RUN_ID:runId,SETSCOPE_SCALE_ID:id,SETSCOPE_SCALE_STAGE:String(stage),SETSCOPE_SCALE_REVIEW:`REVIEWED ${id}`,SETSCOPE_SCALE_CONFIRMATION:`RUN COVERAGE ${stage}`});
async function seedPrevious(db,stage,extra={}){
 const previous=stage===500?100:20,count=previous;
 const completedSymbols=Array.from({length:count},(_,i)=>'P'+i),completedJobs=Array.from({length:count/5},(_,i)=>({runKey:`v156:coverage:2026-10-25:previous-${i}`,attempted:5,verified:5,partial:0,temporaryFailed:0}));
 const scaling={version:1,id:'999',stage:previous,phase:'completed',roundId:'999',roundFingerprint:'0'.repeat(64),evidenceKind:'synthetic',completedSymbols,completedJobs,
  acceptedStages:(stage===500?[20,100]:[20]).map(s=>({id:String(s),stage:s,verified:s,evidenceKind:'synthetic'}))};
 const store=createControlledCoverageStore({env:{...env,SETSCOPE_V156_MANUAL_VERIFY:'1'},fetchImpl:db.fetchImpl,now:()=>NOW});
 await store.beginRun({runKey:CONTROL_KEY,startedAt:new Date(NOW).toISOString(),batchSize:5,concurrency:1});await store.updateMetadata({scaling,...extra});await store.releaseCoordinator('completed');db.calls.length=0;
}

test('synthetic stages 20 -> 100 -> 500 complete across explicitly approved rounds and quota boundaries',async()=>{
 const db=fixture(500),outside=structuredClone(db.registry.get('OUTSIDE')),canary=structuredClone(db.runs.get(CANARY));let time=NOW,runId=2000;
 for(const stage of [20,100,500]){
  const id=String(runId),seen=new Set();let completed=0;
  while(completed<stage){
   const settings=options(stage,id,String(runId++));
   let ready;
   try{ready=await main({env:settings,fetchImpl:db.fetchImpl,now:()=>time});}
   catch(e){assert.ok(['SCALING_DAILY_CAPACITY','BATCH_NOT_ENOUGH_DUE'].includes(e.report.reasonCode));assert.equal(e.report.jobsStarted,0);assert.equal(e.report.failedJob,undefined);
    do{time+=86400000;}while(!tradingDay(bangkokDay(time)));db.advance(time,35);continue;}
   assert.equal(ready.evidenceKind,'synthetic');assert.equal(ready.preflight.requiredCount<=20,true);
   for(const target of ready.plan.targets){assert.equal(seen.has(target.symbol),false);seen.add(target.symbol);}
   const before=db.calls.length;
   const result=await main({env:settings,fetchImpl:db.fetchImpl,now:()=>time,mode:'run'});
   completed=result.stageProgress.completed;
   assert.equal(result.verified,result.attempted);assert.equal(result.partial,0);assert.equal(result.temporaryFailed,0);assert.ok(result.jobs.length<=4);
   assert.ok(result.jobs.every(j=>j.metrics.providerCalls<=10&&j.metrics.databaseReads+j.metrics.databaseWrites<=200));
   assert.equal(db.calls.slice(before).filter(c=>c.url.hostname==='query1.finance.yahoo.com').length,result.attempted);
   const meta=db.runs.get(CONTROL_KEY).automation_state.metadata;
   assert.equal(meta.scaling.completedSymbols.length,completed);assert.equal(new Set(meta.scaling.completedSymbols).size,completed);
   assert.ok(meta.scaling.completedSymbols.every(s=>meta.coverageChecks[s]));
   assert.ok(Buffer.byteLength(JSON.stringify(meta.scaling))<131072);assert.ok(Buffer.byteLength(JSON.stringify(db.runs.get(CONTROL_KEY).automation_state))<1048576);
  }
  assert.equal(seen.size,stage);assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.scaling.acceptedStages.at(-1).verified,stage);
 }
 assert.equal(providerCalls(db),620);assert.deepEqual(db.registry.get('OUTSIDE'),outside);assert.deepEqual(db.runs.get(CANARY),canary);
});

for(const stage of [20,100,500])for(const kind of ['404','429','503','timeout','lost-write'])
test(`synthetic stage ${stage}: ${kind} stops the round without replay or outside writes`,async()=>{
 const db=fixture(20);if(stage>20)await seedPrevious(db,stage);let calls=0,lost=false;
 const transport=async(input,init)=>{
  const url=new URL(String(input));
  if(url.hostname==='query1.finance.yahoo.com'){
   calls++;
   if(kind==='timeout')throw Object.assign(Error('timeout'),{retryable:true});
   if(kind!=='lost-write')return Response.json({},{status:Number(kind)});
  }
  const response=await db.fetchImpl(input,init);
  if(kind==='lost-write'&&!lost&&url.pathname.endsWith('/security_coverage')&&init?.method==='PATCH'){lost=true;throw Error('lost response');}
  return response;
 };
 const settings=options(stage,'3000');
 await assert.rejects(main({env:settings,fetchImpl:transport,now:()=>NOW,mode:'run'}),e=>{assert.equal(e.report.evidenceKind,'synthetic');assert.equal(e.report.jobsStarted,1);return true;});
 assert.equal(calls,1);assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.scaling.phase,'stopped');
 const checkpoint=structuredClone([...db.runs]);
 await assert.rejects(main({env:options(stage,'3000','3001'),fetchImpl:transport,now:()=>NOW+86400000,mode:'run'}));
 assert.equal(calls,1);assert.deepEqual([...db.runs],checkpoint);
 assert.ok([...db.registry.values()].filter(r=>r.symbol!=='S0000').every(r=>!r.symbol_verified));
});

for(const stage of [20,100,500])test(`stage ${stage} failure in job two retains the first job receipt and never starts job three`,async()=>{
 const db=fixture(20);if(stage>20)await seedPrevious(db,stage);let calls=0;
 const transport=(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com'&&++calls>5)return Promise.resolve(Response.json({},{status:503}));
  return db.fetchImpl(input,init);
 };
 await assert.rejects(main({env:options(stage,'3500'),fetchImpl:transport,now:()=>NOW,mode:'run'}),e=>{assert.equal(e.report.jobs.length,1);assert.equal(e.report.verified,5);assert.equal(e.report.failedJob,2);return true;});
 assert.equal(calls,6);const state=db.runs.get(CONTROL_KEY).automation_state.metadata.scaling;assert.equal(state.completedSymbols.length,5);assert.equal(state.phase,'stopped');
});

test('clean round continuation requires new Owner approval and never selects an already completed stock',async()=>{
 const db=fixture(100);await seedPrevious(db,100);
 const first=await main({env:options(100,'4000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'});assert.equal(first.status,'ROUND_PASS');
 const before=providerCalls(db),saved=structuredClone(db.runs.get(CONTROL_KEY));
 await assert.rejects(main({env:{...options(100,'4000','4001'),SETSCOPE_SCALE_REVIEW:''},fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}),e=>e.report.reasonCode==='SCALING_CONTINUATION_APPROVAL_REQUIRED');
 assert.equal(providerCalls(db),before);assert.deepEqual(db.runs.get(CONTROL_KEY),saved);
 db.advance(NOW+86400000,35);
 const next=await main({env:options(100,'4000','4001'),fetchImpl:db.fetchImpl,now:()=>NOW+86400000,mode:'run'});
 assert.equal(next.stageProgress.completed,40);assert.ok(next.plan.targets.every(t=>!first.plan.targets.some(p=>p.symbol===t.symbol)));
});

test('quota-limited round freezes only its approved capacity and cannot refund reservations',async()=>{
 const db=fixture(100);await seedPrevious(db,100,{day:'2026-10-26',reservations:3});
 const r=await main({env:options(100,'5000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'});
 assert.equal(r.plan.targets.length,5);assert.equal(r.stageProgress.completed,5);assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.reservations,4);
 const before=writes(db);await assert.rejects(main({env:options(100,'5000','5001'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}),e=>e.report.reasonCode==='SCALING_DAILY_CAPACITY');assert.equal(writes(db),before);
});

test('crash after a clean durable round can continue only through reviewed state, without replay',async()=>{
 const db=fixture(100);await seedPrevious(db,100);
 await assert.rejects(main({env:options(100,'6000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run',onReport:()=>{throw Error('process died after durable commit');}}));
 assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.scaling.phase,'awaiting_approval');
 db.advance(NOW+86400000,35);
 const next=await main({env:options(100,'6000','6001'),fetchImpl:db.fetchImpl,now:()=>NOW+86400000,mode:'run'});
 assert.equal(next.stageProgress.completed,40);assert.equal(providerCalls(db),40);
});

for(const stage of [100,500])test(`stage ${stage} shares four daily reservations with other jobs and continues only after a new day and approval`,async()=>{
 const db=fixture(40);await seedPrevious(db,stage);
 const settings={...env,SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(approval(stage))};
 assert.equal((await createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW}).execute({tag:'other-job'})).verified,5);
 const first=await main({env:options(stage,'9000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'});
 assert.equal(first.preflight.quotaRemaining.jobs,3);assert.equal(first.preflight.quotaRemaining.providerRequests,30);assert.equal(first.preflight.quotaRemaining.databaseRequests,600);
 assert.equal(first.attempted,15);assert.equal(first.stageProgress.completed,15);assert.equal(first.jobs.length,3);
 const meta=structuredClone(db.runs.get(CONTROL_KEY).automation_state.metadata);assert.equal(meta.reservations,4);
 const before=providerCalls(db),beforeWrites=writes(db);
 await assert.rejects(main({env:options(stage,'9000','9001'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}),e=>e.report.reasonCode==='SCALING_DAILY_CAPACITY');
 assert.equal(providerCalls(db),before);assert.equal(writes(db),beforeWrites);assert.deepEqual(db.runs.get(CONTROL_KEY).automation_state.metadata,meta);
 assert.ok(db.calls.filter(c=>c.url.hostname==='fixture.supabase.co').length<=800);assert.ok(providerCalls(db)<=40);
 const time=NOW+86400000;db.advance(time,35);
 const next=await main({env:options(stage,'9000','9001'),fetchImpl:db.fetchImpl,now:()=>time,mode:'run'});
 assert.equal(next.stageProgress.completed,35);assert.ok(next.plan.targets.every(t=>!first.plan.targets.some(p=>p.symbol===t.symbol)));
 const current=db.runs.get(CONTROL_KEY).automation_state.metadata;assert.equal(current.reservations,4);
 for(const target of first.plan.targets)assert.equal(current.coverageChecks[target.symbol],meta.coverageChecks[target.symbol]);
});

test('absolute cancellation preserves uncertain checkpoint and cannot advance to job two',async()=>{
 const db=fixture(20);let cancelled=false;
 const transport=(input,init)=>new URL(String(input)).hostname==='query1.finance.yahoo.com'?new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{cancelled=true;reject(Error('cancelled'));},{once:true})):db.fetchImpl(input,init);
 await assert.rejects(main({env:options(20,'7000'),fetchImpl:transport,now:()=>NOW,mode:'run',deadlineFactory:()=>createRequestDeadline({durationMs:2000})}));
 assert.equal(cancelled,true);await new Promise(r=>setTimeout(r,10));
 const jobs=[...db.runs.values()].filter(r=>r.run_key!==CONTROL_KEY&&r.run_key!==CANARY);assert.equal(jobs.length,1);
 assert.ok(Object.values(jobs[0].automation_state.documents['coverage-items:'+jobs[0].run_key].entries).some(e=>e.status==='inflight'));
});

test('scaling cannot skip a stage, mislabel synthetic evidence or auto-expand round limits',async()=>{
 const db=fixture(20);
 await assert.rejects(main({env:options(500,'8000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}),e=>e.report.reasonCode==='SCALING_PREDECESSOR_REQUIRED');
 await assert.rejects(main({env:options(20,'8000'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run',roundJobs:5}));
 assert.equal(writes(db),0);assert.equal(providerCalls(db),0);
 await seedPrevious(db,100);
 await assert.rejects(main({env:{...options(100,'8001'),GITHUB_SHA:'a'.repeat(40)},fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run',evidenceKind:'production-manual'}),e=>e.report.reasonCode==='SCALING_EVIDENCE_MISMATCH');
 assert.equal(writes(db),0);assert.equal(providerCalls(db),0);
});

test('workflow is dispatch-only and requires explicit continuation inputs without chaining runs',()=>{
 const yaml=fs.readFileSync('.github/workflows/manual-scaling.yml','utf8');assert.match(yaml,/workflow_dispatch:/);assert.match(yaml,/stage_id:/);assert.match(yaml,/reviewed_state:/);
 assert.doesNotMatch(yaml,/schedule:|pull_request:|push:|workflow_run:|strategy:|continue-on-error:/);assert.match(yaml,/github.actor == github.repository_owner/);
});
