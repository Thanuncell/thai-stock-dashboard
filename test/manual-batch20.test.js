'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {main}=require('../scripts/run-v156-batch20');
const {createControlledCoverageStore,CONTROL_KEY}=require('../server/controlled-coverage-store');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {createRequestDeadline}=require('../server/request-deadline');
const policy=require('../server/manual-batch-policy');
const {backend}=require('./fixtures/controlled-backend.cjs');
const NOW=Date.parse('2026-10-26T11:00:00Z'),old=new Date(NOW-8*86400000).toISOString();
const env={SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',
 GITHUB_REPOSITORY:'Thanuncell/thai-stock-dashboard',GITHUB_REPOSITORY_OWNER:'Thanuncell',GITHUB_ACTOR:'Thanuncell',GITHUB_RUN_ID:'12345678901',
 GITHUB_RUN_ATTEMPT:'1',SETSCOPE_BATCH_CONFIRMATION:'RUN COVERAGE 20',SETSCOPE_V156_KILL:'1'};
const settings={...env,SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_KILL:'0',SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(policy.APPROVAL)};
function fixture(count=20){
 const symbols=Array.from({length:count},(_,i)=>'S'+String(i).padStart(3,'0')),db=backend({symbols});db.advance(NOW,35);
 for(const r of db.registry.values())Object.assign(r,{status:'verified',symbol_verified:true,chart_ready:true,technical_ready:true,last_checked_at:old,
  last_verified_at:old,last_success_at:old,guard_status:'accepted'});
 db.registry.set('OUTSIDE',{symbol:'OUTSIDE',provider_symbol:'OUTSIDE.BK',provider:'Yahoo Finance',active:true,status:'partial',symbol_verified:false,
  chart_ready:false,technical_ready:false,last_checked_at:new Date(NOW).toISOString()});
 return db;
}
const run=(db,args={})=>main({env,fetchImpl:db.fetchImpl,now:()=>NOW,...args});
const providers=db=>db.calls.filter(c=>c.url.hostname==='query1.finance.yahoo.com');
const writes=db=>db.calls.filter(c=>!['GET','HEAD'].includes(c.method));
async function control(db,patch={}){
 const store=createControlledCoverageStore({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW});
 await store.beginRun({runKey:CONTROL_KEY,startedAt:new Date(NOW).toISOString(),batchSize:5,concurrency:1,resume:true});
 await store.updateMetadata(patch);await store.releaseCoordinator('completed');db.calls.length=0;
}

test('preflight is read-only, freezes twenty due identities and preserves seven-day clocks',async()=>{
 const db=fixture(),before=structuredClone([...db.registry]);
 const report=await run(db);assert.equal(report.status,'READY');assert.equal(report.plan.targets.length,20);assert.equal(new Set(report.plan.targets.map(r=>r.symbol)).size,20);
 assert.equal(writes(db).length,0);assert.equal(providers(db).length,0);assert.deepEqual([...db.registry],before);assert.equal(db.runs.size,0);
});

test('twenty stocks finish as four serial five-stock jobs with exact totals and unchanged outside/canary history',async()=>{
 const db=fixture(),outside=structuredClone(db.registry.get('OUTSIDE'));
 db.runs.set('v156:coverage:2026-10-26:canary-5',{run_key:'v156:coverage:2026-10-26:canary-5',status:'completed',attempted:5,verified:5});
 const canary=structuredClone(db.runs.get('v156:coverage:2026-10-26:canary-5'));
 const report=await run(db,{mode:'run'});
 assert.equal(report.status,'PASS');assert.equal(report.jobs.length,4);assert.equal(report.attempted,20);assert.equal(report.verified,20);
 assert.equal(report.partial,0);assert.equal(report.temporaryFailed,0);assert.equal(report.before.partial,1);assert.equal(report.after.partial,1);
 for(const job of report.jobs){assert.equal(job.attempted,5);assert.equal(job.verified,5);assert.ok(job.metrics.providerCalls<=10);assert.ok(job.metrics.databaseReads+job.metrics.databaseWrites<=200);}
 assert.equal(report.jobs[0].metrics.databaseReads>=report.preflightReads,true);
 const order=providers(db).map(c=>decodeURIComponent(c.url.pathname.split('/').pop()).replace(/\.BK$/,''));
 assert.deepEqual(order,report.plan.targets.map(r=>r.symbol));assert.equal(new Set(order).size,20);
 const meta=db.runs.get(CONTROL_KEY).automation_state.metadata;assert.equal(meta.reservations,4);assert.equal(meta.manualBatch.next,4);assert.equal(meta.manualBatch.phase,'completed');
 for(const target of report.plan.targets)assert.equal(meta.coverageChecks[target.symbol],new Date(NOW).toISOString());
 assert.deepEqual(db.registry.get('OUTSIDE'),outside);assert.deepEqual(db.runs.get(canary.run_key),canary);assert.equal(env.SETSCOPE_V156_KILL,'1');
 const before=providers(db).length;await assert.rejects(run(db,{mode:'run'}));assert.equal(providers(db).length,before);
});

for(const kind of ['insufficient','mapping','status','duplicate','recent','durable-recent','quota','circuit','checkpoint','run-key'])
test(`preflight blocks ${kind} without writes or provider traffic`,async()=>{
 const db=fixture(kind==='insufficient'?19:20);
 if(kind==='mapping')db.registry.get('S000').provider_symbol='WRONG.BK';
 if(kind==='status')db.registry.get('S000').status='unknown';
 if(kind==='recent')db.registry.get('S000').last_checked_at=new Date(NOW-6*86400000).toISOString();
 if(kind==='durable-recent')await control(db,{coverageChecks:{S000:new Date(NOW-6*86400000).toISOString()}});
 if(kind==='quota')await control(db,{day:'2026-10-26',reservations:1});
 if(kind==='circuit')await control(db,{denied:true});
 if(kind==='checkpoint')await control(db,{activeJob:'v156:coverage:2026-10-26:unfinished'});
 if(kind==='run-key')db.runs.set('v156:coverage:2026-10-26:b20-12345678901-1',{run_key:'v156:coverage:2026-10-26:b20-12345678901-1',status:'failed'});
 const transport=async(input,init)=>{
  const response=await db.fetchImpl(input,init);
  if(kind==='duplicate'&&new URL(String(input)).pathname.endsWith('/security_coverage')&&(!init?.method||init.method==='GET')){
   const rows=await response.json();return Response.json([...rows,rows[0]]);
  }return response;
 };
 await assert.rejects(run(db,{fetchImpl:transport}));assert.equal(writes(db).length,0);assert.equal(providers(db).length,0);
});

for(const failureJob of [1,2,3,4])for(const kind of ['404','429','503','timeout'])
test(`${kind} in job ${failureJob} prevents all remaining jobs and retains checkpoints`,async()=>{
 const db=fixture(),outside=structuredClone(db.registry.get('OUTSIDE'));let calls=0;
 const transport=(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com'){
   calls++;if(calls>(failureJob-1)*5){
    if(kind==='timeout')throw Object.assign(Error('timeout'),{retryable:true});
    return Promise.resolve(Response.json({},{status:Number(kind)}));
   }
  }return db.fetchImpl(input,init);
 };
 await assert.rejects(run(db,{mode:'run',fetchImpl:transport}),e=>{assert.equal(e.report.jobs.length,failureJob-1);assert.equal(e.report.incompleteJobCounts,'UNKNOWN');return true;});
 assert.equal(calls,(failureJob-1)*5+1);
 const jobs=[...db.runs.values()].filter(r=>r.run_key!==CONTROL_KEY);assert.equal(jobs.length,failureJob);
 const failed=jobs.at(-1),entries=failed.automation_state.documents['coverage-items:'+failed.run_key].entries;
 assert.ok(Object.values(entries).some(e=>e.status==='inflight'));
 assert.equal(db.runs.get(CONTROL_KEY).automation_state.metadata.manualBatch.phase,'stopped');
 const untouched=Array.from(db.registry.values()).filter(r=>/^S/.test(r.symbol)).slice(failureJob*5);
 assert.ok(untouched.every(r=>r.last_checked_at===old&&r.status==='verified'));
 assert.deepEqual(db.registry.get('OUTSIDE'),outside);
 const before=calls;await assert.rejects(run(db,{mode:'run',fetchImpl:transport}));assert.equal(calls,before);
});

test('absolute deadline cancels a hung provider, preserves uncertainty, and cannot replay after reviewed reconciliation',async()=>{
 const db=fixture();let cancelled=false;
 const transport=(input,init)=>{
  if(new URL(String(input)).hostname==='query1.finance.yahoo.com')return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{cancelled=true;reject(Error('cancelled'));},{once:true}));
  return db.fetchImpl(input,init);
 };
 await assert.rejects(run(db,{mode:'run',fetchImpl:transport,deadlineFactory:()=>createRequestDeadline({durationMs:2000})}));
 assert.equal(cancelled,true);
 // Wait for aborted cleanup to settle; no new job is dispatched by the CLI.
 await new Promise(resolve=>setTimeout(resolve,10));
 const key='v156:coverage:2026-10-26:b20-12345678901-1',state=db.runs.get(key).automation_state;
 assert.ok(Object.values(state.documents['coverage-items:'+key].entries).some(e=>e.status==='inflight'));
 const later=NOW+120001,controller=createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>later});
 assert.equal((await controller.execute({operation:'reconcile',runKey:key,reviewed:true})).replayed,false);
 const before=providers(db).length;
 await assert.rejects(run(db,{mode:'run',env:{...env,GITHUB_RUN_ID:'12345678902'},now:()=>later}));assert.equal(providers(db).length,before);
});

test('pinned selection rejects mapping/cadence changes and cannot skip sequence or daily reservation changes',async()=>{
 const db=fixture(),report=await run(db),plan=report.plan;
 const bad=structuredClone(plan);bad.targets[1]=bad.targets[0];assert.throws(()=>policy.validatePlan(bad));
 db.registry.get('S000').provider_symbol='OTHER.BK';
 await assert.rejects(createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW,batchPlan:plan}).execute({tag:plan.runKeys[0].split(':')[3]}));
 assert.equal(providers(db).length,0);
});

for(const kind of ['skip','reservations','clock','breaker'])
test(`durable admission rechecks ${kind} after preflight without provider traffic`,async()=>{
 const db=fixture(),{plan}=await run(db);
 if(kind==='reservations')await control(db,{day:'2026-10-26',reservations:1});
 if(kind==='clock')await control(db,{coverageChecks:{S000:new Date(NOW).toISOString()}});
 if(kind==='breaker')await control(db,{denied:true});
 const index=kind==='skip'?1:0;
 await assert.rejects(createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW,batchPlan:plan,batchIndex:index}).execute({tag:plan.runKeys[index].split(':')[3]}));
 assert.equal(providers(db).length,0);
});

test('active coordinator lease blocks read-only preflight until reviewed release',async()=>{
 const db=fixture(),store=createControlledCoverageStore({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW});
 await store.beginRun({runKey:CONTROL_KEY,startedAt:new Date(NOW).toISOString(),batchSize:5,concurrency:1});db.calls.length=0;
 await assert.rejects(run(db));assert.equal(writes(db).length,0);assert.equal(providers(db).length,0);
});

test('lost result-write response preserves a checked checkpoint without replay or launching job two',async()=>{
 const db=fixture();let lost=false;
 const transport=async(input,init)=>{
  const response=await db.fetchImpl(input,init);
  if(!lost&&new URL(String(input)).pathname.endsWith('/security_coverage')&&init?.method==='PATCH'){lost=true;throw Error('fixture lost acknowledgement');}
  return response;
 };
 await assert.rejects(run(db,{mode:'run',fetchImpl:transport}));
 const key='v156:coverage:2026-10-26:b20-12345678901-1',entries=db.runs.get(key).automation_state.documents['coverage-items:'+key].entries;
 assert.ok(Object.values(entries).some(e=>e.status==='checked'));assert.equal(providers(db).length,1);
 const checkpoint=structuredClone(entries);await assert.rejects(run(db,{mode:'run'}));assert.equal(providers(db).length,1);assert.deepEqual(entries,checkpoint);
 assert.equal([...db.runs.keys()].filter(k=>k!==CONTROL_KEY).length,1);
});

test('preflight accepts old-day reservations without refunding or modifying them',async()=>{
 const db=fixture();await control(db,{day:'2026-10-25',reservations:4});const before=structuredClone(db.runs.get(CONTROL_KEY));
 const report=await run(db);assert.equal(report.plan.initialReservations,0);assert.deepEqual(db.runs.get(CONTROL_KEY),before);assert.equal(writes(db).length,0);
});

test('inherited cross-job mass-failure streak still trips before applying a no-data result',async()=>{
 const db=fixture();await control(db,{failedSecurities:2});
 const transport=(input,init)=>new URL(String(input)).hostname==='query1.finance.yahoo.com'?Promise.resolve(Response.json({},{status:404})):db.fetchImpl(input,init);
 await assert.rejects(run(db,{mode:'run',fetchImpl:transport}));
 const meta=db.runs.get(CONTROL_KEY).automation_state.metadata;assert.equal(meta.failedSecurities,3);assert.equal(meta.reason,'MASS_TEMPORARY_FAILURES');
 assert.ok([...db.registry.values()].filter(r=>/^S/.test(r.symbol)).every(r=>r.status==='verified'&&r.last_success_at===old));
});

test('released legacy coordinator with a completed active job needs no historical rewrite during preflight',async()=>{
 const db=fixture();await control(db,{activeJob:'v156:coverage:2026-10-26:legacy'});
 const legacy=structuredClone(db.runs.get(CONTROL_KEY));legacy.run_key='v156:coverage:2026-10-26:legacy';db.runs.set(legacy.run_key,legacy);
 const row=db.runs.get(CONTROL_KEY);row.status='failed';row.automation_state.phase='failed';row.failure_reason='CONTROLLED_RUN_INTERRUPTED';
 const before=structuredClone(row);db.calls.length=0;assert.equal((await run(db)).status,'READY');assert.deepEqual(row,before);assert.equal(writes(db).length,0);
});

for(const patch of [{GITHUB_ACTOR:'another-user'},{GITHUB_REF:'refs/heads/test'},{GITHUB_RUN_ATTEMPT:'2'},{SETSCOPE_BATCH_CONFIRMATION:''},{GITHUB_REPOSITORY:'another/repo'}])
test(`execution authorization blocks ${JSON.stringify(patch)}`,async()=>{
 const db=fixture();await assert.rejects(run(db,{mode:'run',env:{...env,...patch}}));assert.equal(db.calls.length,0);
});

test('workflow is owner/main dispatch-only, serial CLI, fixed secrets and no auto retry',()=>{
 const yaml=fs.readFileSync('.github/workflows/manual-batch20.yml','utf8');
 assert.match(yaml,/workflow_dispatch:/);assert.doesNotMatch(yaml,/schedule:|pull_request:|push:|strategy:|continue-on-error:/);
 assert.match(yaml,/github.actor == github.repository_owner/);assert.match(yaml,/github.ref == 'refs\/heads\/main'/);
 assert.match(yaml,/github.run_attempt == 1/);assert.match(yaml,/persist-credentials: false/);assert.match(yaml,/secrets.SUPABASE_SECRET_KEY/);
});
