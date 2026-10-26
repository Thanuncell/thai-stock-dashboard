'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {coverageTruth}=require('../server/coverage-truth');
const {createCoverageRunner}=require('../server/coverage-service');
const {createControlledCoverageStore,CONTROL_KEY,LEASE_MS}=require('../server/controlled-coverage-store');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {backend}=require('./fixtures/controlled-backend.cjs');
const NOW=Date.parse('2026-10-26T11:00:00Z');
const iso=ms=>new Date(ms).toISOString();
const row=symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified',
 symbol_verified:true,chart_ready:true,technical_ready:true,guard_status:'accepted',
 last_checked_at:iso(NOW-8*86400000),last_success_at:iso(NOW-8*86400000),last_verified_at:iso(NOW-8*86400000)});
const env=stage=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_V156_MANUAL_VERIFY:'1',
 SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify({ownerApproved:true,stage,approvedStages:[5,20,100,500].filter(n=>n<=stage),
 maxJobsPerDay:Math.max(2,stage/5),providerDailyLimit:Math.max(2,stage/5)*10,databaseDailyLimit:Math.max(2,stage/5)*200})});

test('truth separates historical, fresh LKG, stale, temporary failure and confirmed unavailability',async()=>{
 const fresh={...row('FRESH'),last_success_at:iso(NOW-1000)};
 const failedFresh={...fresh,symbol:'FAILED',status:'temporary_failed'};
 const failedOld={...row('OLD'),status:'temporary_failed',last_checked_at:iso(NOW)};
 const unavailable={...row('GONE'),active:false,status:'inactive',symbol_verified:false,chart_ready:false};
 const counts=coverageTruth([fresh,failedFresh,failedOld,unavailable],{now:NOW});
 assert.equal(counts.historicalVerified,4);assert.equal(counts.currentUsable,2);assert.equal(counts.retainedUsable,3);
 assert.equal(counts.temporaryFailed,2);assert.equal(counts.stale,1);assert.equal(counts.confirmedUnavailable,1);
 const {coverageDisplayState}=await import('../client/domain.mjs');
 const display=coverageDisplayState({configured:true,provider:'Yahoo Finance',dataState:'stale',lastChecked:iso(NOW-8*86400000),universe:3,...counts});
 assert.equal(display.ready,true);assert.equal(display.reason,'stale');assert.equal(display.historicalVerified,4);
 assert.equal(display.confirmedUnavailable,1);assert.equal(display.currentVerified,2);
});

test('five verified batch results cannot inherit universe partial or attempted counters',async()=>{
 const rows=Array.from({length:5},(_,i)=>row('S'+i));let persisted;
 const run=createCoverageRunner({now:()=>NOW,batchSize:5,concurrency:1,
  repository:{beginRun:async()=>({}),listBatch:async()=>rows,saveResults:async()=>{},counts:async()=>({universe:500,partial:7,success:490,attempted:500,verified:490,temporaryFailed:3}),finishRun:async p=>{persisted=p;}},
  verifySymbol:async()=>({symbolVerified:true,chartReady:true,technicalReady:true,guardStatus:'accepted'})});
 const result=await run.run({runKey:'fixture-metrics'});
 for(const actual of [result,persisted]){assert.equal(actual.attempted,5);assert.equal(actual.verified,5);assert.equal(actual.temporaryFailed,0);assert.equal(actual.partial,0);}
 assert.equal(result.coverageCounts.partial,7);assert.equal(result.universe,500);
});

test('normal coordinator release is successful, reacquirable and still fences expired owners',async()=>{
 const db=backend();let time=NOW;
 const make=()=>createControlledCoverageStore({env:env(5),fetchImpl:db.fetchImpl,now:()=>time});
 const args={runKey:CONTROL_KEY,startedAt:iso(time),batchSize:5,concurrency:1,resume:true};
 const first=make();await first.beginRun(args);await first.releaseCoordinator('completed');
 assert.equal(db.runs.get(CONTROL_KEY).failure_reason,null);assert.equal(db.runs.get(CONTROL_KEY).status,'completed');
 assert.equal((await first.status(CONTROL_KEY)).lockReleased,true);
 const second=make(),third=make();
 const races=await Promise.allSettled([second.beginRun(args),third.beginRun(args)]);
 assert.equal(races.filter(r=>r.status==='fulfilled'&&!r.value.alreadyRunning).length,1);
 for(const r of races)if(r.status==='rejected')assert.equal(r.reason.code,'LEASE_LOST');
 const owner=races[0].status==='fulfilled'&&!races[0].value.alreadyRunning?second:third;
 time+=LEASE_MS+1;const replacement=make();await replacement.beginRun({...args,startedAt:iso(time)});
 await assert.rejects(owner.releaseCoordinator('completed'),/LEASE_LOST/);
 await replacement.releaseCoordinator('failed');assert.equal((await replacement.status(CONTROL_KEY)).lastOutcome,'failed');
});

test('temporary failures accumulate across independent jobs before the third unsafe write',async()=>{
 const db=backend({symbols:['A']});db.registry.set('A',row('A'));db.advance(NOW-86400000,35);
 const make=()=>createControlledCoverage({env:env(20),fetchImpl:db.fetchImpl,now:()=>NOW});
 for(const [index,symbol]of ['A','B','C'].entries()){
  if(index)db.registry.set(symbol,row(symbol));
  if(index<2)assert.equal((await make().execute({mode:'eod',tag:'cross-'+index})).temporaryFailed,1);
  else await assert.rejects(make().execute({mode:'eod',tag:'cross-'+index}),/MASS_FAILURES/);
 }
 assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.failedSecurities,3);
 assert.equal(db.registry.get('C').status,'verified');assert.equal(db.registry.get('C').last_checked_at,row('C').last_checked_at);
 const before=db.calls.length;await assert.rejects(make().execute({mode:'eod',tag:'blocked'}),/CIRCUIT_OPEN/);
 assert.equal(db.calls.slice(before).filter(c=>c.url.hostname==='query1.finance.yahoo.com').length,0);
});

for(const stage of [5,20,100,500])for(const kind of ['timeout','outage','rate-limit','denial','malformed','temporary'])
test(`synthetic ${stage}-stock exposure: ${kind} stops bounded work and preserves recovery`,async()=>{
 const symbols=Array.from({length:stage},(_,i)=>'S'+String(i).padStart(4,'0'));
 const db=backend({symbols});for(const s of symbols)db.registry.set(s,row(s));
 const before=structuredClone([...db.registry.values()]);let time=NOW,broken=true,calls=0;
 const transport=(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){
   calls++;
   if(broken){
    if(kind==='timeout')throw Object.assign(Error('fetch failed: timeout'),{retryable:true});
    if(kind==='malformed')return Promise.resolve(Response.json({}));
    if(kind!=='temporary')return Promise.resolve(Response.json({},{status:{outage:503,'rate-limit':429,denial:403}[kind]}));
   }
  }
  return db.fetchImpl(input,init);
 };
 db.advance(kind==='temporary'?NOW-86400000:NOW,35);
 const make=()=>createControlledCoverage({env:env(stage),fetchImpl:transport,now:()=>time,retrySleep:async()=>{}});
 const mode=kind==='temporary'?'eod':'coverage',tag='outage';
 await assert.rejects(make().execute({mode,tag}));assert.ok(calls<=3);
 // Never overwrite the third failed security or any security beyond the first batch.
 assert.ok(symbols.slice(5).every((s,i)=>JSON.stringify(db.registry.get(s))===JSON.stringify(before[i+5])));
 assert.ok([...db.registry.values()].filter(r=>r.status==='temporary_failed').length<=2);
 assert.ok([...db.registry.values()].every(r=>r.symbol_verified&&r.chart_ready&&r.technical_ready));
 const stoppedCalls=calls;await assert.rejects(make().execute({mode,tag:'next-job'}),/CIRCUIT_OPEN/);assert.equal(calls,stoppedCalls);
 time+=300001;broken=false;db.advance(time,35);
 if(['rate-limit','denial'].includes(kind)){
  await assert.rejects(make().execute({mode,tag:'no-bypass'}),/CIRCUIT_OPEN/);assert.equal(calls,stoppedCalls);return;
 }
 const key=`v156:${mode}:2026-10-26:${tag}`;
 const status=await make().execute({operation:'status',runKey:key});
 const beforeRecovery=new Map([...db.registry].map(([s,r])=>[s,structuredClone(r)]));
 let result;
 if(status.requiresReconciliation){
  await make().execute({operation:'reconcile',runKey:key,reviewed:true});
  result=await make().execute({mode,tag:'recovery'});
 }else result=await make().execute({mode,tag,resume:true});
 assert.ok(result.verified>0);assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.failedSecurities||0,0);
 const manifest=db.runs.get(result.runKey).automation_state.documents['coverage-manifest:'+result.runKey].rows;
 const allowed=new Set(manifest.map(r=>r.symbol));
 // Reconciliation abandons uncertain entries; it must not refill by replaying them.
 assert.ok(allowed.size>0 && allowed.size<=5);
 const outside=symbols.filter(s=>!allowed.has(s));
 assert.ok(outside.every(s=>JSON.stringify(db.registry.get(s))===JSON.stringify(beforeRecovery.get(s))));
 assert.ok(result.metrics.providerCalls<=10);assert.ok(result.metrics.databaseReads+result.metrics.databaseWrites<=200);
});
