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

const recovery=require('../server/scaling-recovery');
const repositoryFor=db=>require('../server/coverage-service').createCoverageRepository({env:{...env,SETSCOPE_V156_MANUAL_VERIFY:'1'},fetchImpl:db.fetchImpl,now:()=>NOW});
const storeFor=db=>createControlledCoverageStore({env:{...env,SETSCOPE_V156_MANUAL_VERIFY:'1'},fetchImpl:db.fetchImpl,now:()=>NOW});
const recoveryContext=(roundId='11001')=>({id:'11000',stage:100,roundId,reviewed:true,evidenceKind:'synthetic',sourceSha:null});
async function stoppedStage({kind='404',failAt=1}={}){
 const db=fixture(125);await seedPrevious(db,100);let calls=0;
 const transport=async(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com'&&++calls===failAt){
   if(kind==='lost-write')return db.fetchImpl(input,init);
   return Response.json({},{status:404});
  }
  const response=await db.fetchImpl(input,init);
  if(kind==='lost-write'&&new URL(String(input)).pathname.endsWith('/security_coverage')&&init?.method==='PATCH')throw Error('lost response');
  return response;
 };
 await assert.rejects(main({env:options(100,'11000'),fetchImpl:transport,now:()=>NOW,mode:'run'}));
 return db;
}
async function review(db,context=recoveryContext()){
 return recovery.inspect({store:storeFor(db),repository:repositoryFor(db),metadata:db.runs.get(CONTROL_KEY).automation_state.metadata,context,now:NOW});
}
test('stopped-stage recovery requires reconcile and exact review; preserves reservations, lineage and no-replay evidence',async()=>{
 const db=await stoppedStage(),meta=db.runs.get(CONTROL_KEY).automation_state.metadata,key=meta.activeJob;
 const failed=structuredClone(db.runs.get(key)),beforeRegistry=structuredClone([...db.registry]),accepted=structuredClone(meta.scaling.acceptedStages);
 await assert.rejects(review(db),/RECONCILIATION_REQUIRED/);
 await assert.rejects(storeFor(db).reconcile(key,false),/REVIEW_REQUIRED/);
 await storeFor(db).reconcile(key,true);
 const reconciled=structuredClone(db.runs.get(key)),r=await review(db);
 assert.equal(Object.values(reconciled.automation_state.documents['coverage-items:'+key].entries)[0].status,'abandoned');
 assert.equal(Object.values(failed.automation_state.documents['coverage-items:'+key].entries)[0].status,'inflight');
 const save=structuredClone(db.runs.get(CONTROL_KEY));
 await assert.rejects(recovery.recover({store:storeFor(db),repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint:'0'.repeat(64)}),/REVIEW_REQUIRED/);
 assert.deepEqual(db.runs.get(CONTROL_KEY),save);
 const calls=providerCalls(db),result=await recovery.recover({store:storeFor(db),repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint:r.fingerprint});
 assert.equal(result.replayed,false);assert.equal(providerCalls(db),calls);assert.deepEqual([...db.registry],beforeRegistry);assert.deepEqual(db.runs.get(key),reconciled);
 const recovered=db.runs.get(CONTROL_KEY).automation_state.metadata;
 assert.equal(recovered.scaling.id,'11000');assert.deepEqual(recovered.scaling.acceptedStages,accepted);assert.equal(recovered.reservations,2);
 assert.equal(recovered.scaling.recoveries[0].quotaBefore.reservations,1);
 assert.deepEqual(recovered.coverageChecks,meta.coverageChecks);assert.equal(recovered.manualBatch.phase,'recovered');
 assert.equal(recovery.isRecovered(recovered),true);
 await assert.rejects(review(db),/STATE_CONFLICT/);
 await assert.rejects(main({env:options(100,'11000','11001'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}));
 let time=NOW+86400000,run=11002;
 db.advance(time,35);
 let count=0;
 while(count<100){
  const result=await main({env:options(100,'11000',String(run++)),fetchImpl:db.fetchImpl,now:()=>time,mode:'run'});
  assert.ok(result.plan.targets.every(t=>!r.receipt.excludedSymbols.includes(t.symbol)));
  count=result.stageProgress.completed;time+=86400000;while(!tradingDay(bangkokDay(time)))time+=86400000;db.advance(time,35);
 }
 const done=db.runs.get(CONTROL_KEY).automation_state.metadata.scaling;
 assert.equal(done.completedSymbols.length,100);assert.equal(new Set(done.completedSymbols).size,100);assert.equal(done.id,'11000');
 assert.deepEqual(db.runs.get(key),reconciled);assert.equal(done.recoveries.length,1);
 const nextStage=require('../server/scaling-policy').progress({scaling:done},{id:'11999',stage:500,roundId:'11999',reviewed:true,evidenceKind:'synthetic',sourceSha:null});
 assert.deepEqual(nextStage.acceptedStages[1].recoveries,done.recoveries);
});

for(const kind of ['lost-write','changed-row','inflight','leased','circuit','bad-manifest','changed-review','wrong-stage','receipt','quota'])
test(`recovery fails closed for ${kind} without provider traffic or coverage writes`,async()=>{
 const db=await stoppedStage({kind:kind==='lost-write'?'lost-write':'404',failAt:kind==='receipt'?6:1});
 const meta=db.runs.get(CONTROL_KEY).automation_state.metadata,key=meta.activeJob;
 await storeFor(db).reconcile(key,true);
 let fingerprint;
 if(kind==='changed-review')fingerprint=(await review(db)).fingerprint;
 if(kind==='changed-row')db.registry.get('S0000').status='temporary_failed';
 if(kind==='inflight')Object.values(db.runs.get(key).automation_state.documents['coverage-items:'+key].entries)[0].status='inflight';
 if(kind==='leased')db.runs.get(key).automation_state.leaseUntil=new Date(NOW+1).toISOString();
 if(kind==='circuit')meta.denied=true;
 if(kind==='bad-manifest')db.runs.get(key).automation_state.documents['coverage-manifest:'+key].rows[0].provider_symbol='WRONG.BK';
 if(kind==='changed-review')meta.reservations++;
 if(kind==='receipt')db.runs.get(meta.manualBatch.runKeys[0]).verified=4;
 if(kind==='quota')meta.reservations=4;
 const rows=structuredClone([...db.registry]),count=providerCalls(db),writesBefore=writes(db);
 if(kind==='changed-review')await assert.rejects(recovery.recover({store:storeFor(db),repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint}));
 else await assert.rejects(review(db,kind==='wrong-stage'?{...recoveryContext(),stage:500}:recoveryContext()));
 assert.equal(providerCalls(db),count);assert.equal(writes(db),writesBefore);assert.deepEqual([...db.registry],rows);
});

test('recovery after job two preserves the first accepted receipt and blocks duplicate targets and quota refund',async()=>{
 const db=await stoppedStage({failAt:6}),meta=db.runs.get(CONTROL_KEY).automation_state.metadata;
 const first=structuredClone(meta.scaling.completedJobs),checks=structuredClone(meta.coverageChecks);
 await storeFor(db).reconcile(meta.activeJob,true);const inspected=await review(db);
 await recovery.recover({store:storeFor(db),repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint:inspected.fingerprint});
 const next=await main({env:options(100,'11000','11002'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'});
 assert.equal(next.jobs.length,1);assert.equal(next.stageProgress.completed,10);
 const current=db.runs.get(CONTROL_KEY).automation_state.metadata;
 assert.equal(current.reservations,4);assert.deepEqual(current.scaling.completedJobs.slice(0,1),first);
 for(const s of Object.keys(checks))if(!next.plan.targets.some(t=>t.symbol===s))assert.equal(current.coverageChecks[s],checks[s]);
 assert.ok(next.plan.targets.every(t=>!meta.scaling.completedSymbols.includes(t.symbol)&&!inspected.receipt.excludedSymbols.includes(t.symbol)));
});

test('exchange suspension exclusion is dated and non-destructive; unexplained no-data never becomes a silent skip',async()=>{
 const date=Date.parse('2026-11-04T04:00:00Z'),db=fixture(20);db.advance(date,35);
 db.registry.set('ACAP',{...structuredClone(db.registry.get('S0000')),symbol:'ACAP',provider_symbol:'ACAP.BK',status:'temporary_failed',guard_reason:'SOURCE_NO_DATA'});
 const before=structuredClone([...db.registry]);
 const ready=await main({env:options(20,'12000'),fetchImpl:db.fetchImpl,now:()=>date});
 assert.equal(ready.plan.targets.length,20);assert.equal(ready.plan.targets.some(t=>t.symbol==='ACAP'),false);
 assert.equal(ready.preflight.exclusions[0].reason,'EXCHANGE_SUSPENDED');assert.deepEqual([...db.registry],before);assert.equal(providerCalls(db),0);
 await assert.rejects(main({env:options(20,'12000'),fetchImpl:db.fetchImpl,now:()=>date+86400000}),e=>e.report.reasonCode==='BATCH_LIFECYCLE_REVIEW_REQUIRED');
 const renewed=await main({env:{...options(20,'12000'),SETSCOPE_SCALE_ELIGIBILITY_REVIEW:'REVIEWED ACAP 2026-11-05'},fetchImpl:db.fetchImpl,now:()=>date+86400000});
 assert.equal(renewed.plan.targets.length,20);assert.equal(renewed.plan.targets.some(t=>t.symbol==='ACAP'),false);
 db.registry.delete('ACAP');db.registry.get('S0000').guard_reason='SOURCE_NO_DATA';
 await assert.rejects(main({env:options(20,'12000'),fetchImpl:db.fetchImpl,now:()=>date}),e=>e.report.reasonCode==='BATCH_ELIGIBILITY_REVIEW_REQUIRED');
 assert.equal(writes(db),0);assert.equal(providerCalls(db),0);
 delete db.registry.get('S0000').guard_reason;db.registry.get('S0000').failure_reason='SOURCE_NO_DATA';
 await assert.rejects(main({env:options(20,'12000'),fetchImpl:db.fetchImpl,now:()=>date}),e=>e.report.reasonCode==='BATCH_ELIGIBILITY_REVIEW_REQUIRED'&&e.report.preflight.selectionRisks.some(r=>r.symbol==='S0000'&&r.reason==='SOURCE_NO_DATA_REVIEW_REQUIRED'));
 assert.ok(db.calls.filter(c=>c.url.pathname.endsWith('/security_coverage')).every(c=>c.url.searchParams.get('select')?.split(',').includes('failure_reason')));
});

test('Actions recovery inspection is read-only and apply cannot start jobs or authorize the next run',async()=>{
 const db=await stoppedStage(),key=db.runs.get(CONTROL_KEY).automation_state.metadata.activeJob;
 await storeFor(db).reconcile(key,true);db.calls.length=0;
 const settings=options(100,'11000','11001');
 const ready=await main({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW,mode:'recovery-preflight'});
 assert.equal(ready.status,'RECOVERY_READY');assert.equal(ready.jobsStarted,0);assert.equal(writes(db),0);assert.equal(providerCalls(db),0);
 const approval={...settings,GITHUB_RUN_ID:'11002',SETSCOPE_SCALE_CONFIRMATION:'RECOVER COVERAGE 11000',SETSCOPE_SCALE_RECOVERY_FINGERPRINT:ready.recovery.fingerprint};
 const result=await main({env:approval,fetchImpl:db.fetchImpl,now:()=>NOW,mode:'recover'});
 assert.equal(result.status,'RECOVERED');assert.equal(result.jobsStarted,0);assert.equal(providerCalls(db),0);
 assert.ok(db.calls.filter(c=>!['GET','HEAD'].includes(c.method)).every(c=>c.url.pathname.endsWith('/coverage_runs')));
 await assert.rejects(main({env:options(100,'11000','11002'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}));
 await assert.rejects(main({env:{...options(100,'11000','11003'),SETSCOPE_SCALE_REVIEW:''},fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}));
 assert.equal(providerCalls(db),0);
});

for(const patch of [{GITHUB_ACTOR:'not-owner'},{GITHUB_REF:'refs/heads/other'},{GITHUB_RUN_ATTEMPT:'2'},{SETSCOPE_SCALE_REVIEW:''},{SETSCOPE_SCALE_CONFIRMATION:'RUN COVERAGE 100'}])
test(`recovery authorization rejects ${JSON.stringify(patch)} before writes`,async()=>{
 const db=await stoppedStage();db.calls.length=0;
 await assert.rejects(main({env:{...options(100,'11000','11001'),SETSCOPE_SCALE_CONFIRMATION:'RECOVER COVERAGE 11000',...patch},fetchImpl:db.fetchImpl,now:()=>NOW,mode:'recover'}));
 assert.equal(writes(db),0);assert.equal(providerCalls(db),0);
});

test('simultaneous recovery reviewers have one durable winner and never replay the failed job',async()=>{
 const db=await stoppedStage();await storeFor(db).reconcile(db.runs.get(CONTROL_KEY).automation_state.metadata.activeJob,true);
 const ready=await review(db),calls=providerCalls(db);
 const results=await Promise.allSettled([recoveryContext('11001'),recoveryContext('11002')].map(context=>recovery.recover({store:storeFor(db),repository:repositoryFor(db),context,now:NOW,fingerprint:ready.fingerprint})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(providerCalls(db),calls);
 const meta=db.runs.get(CONTROL_KEY).automation_state.metadata;assert.equal(meta.scaling.recoveries.length,1);assert.equal(meta.reservations,2);
});

test('lost recovery response preserves durable receipt and blocks automatic replay',async()=>{
 const db=await stoppedStage();await storeFor(db).reconcile(db.runs.get(CONTROL_KEY).automation_state.metadata.activeJob,true);
 const ready=await review(db),calls=providerCalls(db);let lost=false;
 const transport=async(input,init)=>{const response=await db.fetchImpl(input,init);
  if(init?.method==='PATCH'&&JSON.parse(init.body).automation_state?.metadata?.manualBatch?.phase==='recovered'&&!lost){lost=true;throw Error('lost recovery response');}return response;};
 const store=createControlledCoverageStore({env:{...env,SETSCOPE_V156_MANUAL_VERIFY:'1'},fetchImpl:transport,now:()=>NOW});
 await assert.rejects(recovery.recover({store,repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint:ready.fingerprint}));
 assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.scaling.recoveries.length,1);
 await assert.rejects(review(db));assert.equal(providerCalls(db),calls);
});

test('recovered job evidence is checked again before continuation; changed checkpoint cannot start a job',async()=>{
 const db=await stoppedStage();const key=db.runs.get(CONTROL_KEY).automation_state.metadata.activeJob;
 await storeFor(db).reconcile(key,true);const ready=await review(db);
 await recovery.recover({store:storeFor(db),repository:repositoryFor(db),context:recoveryContext(),now:NOW,fingerprint:ready.fingerprint});
 db.runs.get(key).automation_state.revision++;const before=providerCalls(db),beforeWrites=writes(db);
 await assert.rejects(main({env:options(100,'11000','11002'),fetchImpl:db.fetchImpl,now:()=>NOW,mode:'run'}),e=>e.report.reasonCode==='SCALING_RECOVERY_STATE_CHANGED');
 assert.equal(providerCalls(db),before);assert.equal(writes(db),beforeWrites);
});
