'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {COVERAGE_INTERVAL_MS,CALENDARS,CALENDAR,selectCoverage,latestSession,tradingDay,calendarReadiness,executionWindow}=require('../server/automation-policy');
const {readScalePolicy,planBatchScale,JOB_BUDGET}=require('../server/automation-scaling');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {backend}=require('./fixtures/controlled-backend.cjs');
const NOW=Date.parse('2026-10-26T11:00:00Z');
const env=()=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_V156_MANUAL_VERIFY:'1'});
const approval=stage=>({ownerApproved:true,stage,approvedStages:[5,20,100,500].filter(size=>size<=stage),maxJobsPerDay:stage/5,
  providerDailyLimit:stage*2,databaseDailyLimit:stage/5*200});

test('coverage seven-day boundary applies per stock to verified, partial, failed and unverified rows',()=>{
  for(const status of ['verified','partial','temporary_failed','pending']){
    const row={symbol:'PTT',provider_symbol:'PTT.BK',provider:'Yahoo Finance',active:true,status,
      symbol_verified:status!=='pending',chart_ready:true,last_checked_at:new Date(NOW-COVERAGE_INTERVAL_MS+1).toISOString()};
    assert.equal(selectCoverage([row],{now:NOW}).length,0);
    row.last_checked_at=new Date(NOW-COVERAGE_INTERVAL_MS).toISOString();
    assert.equal(selectCoverage([row],{now:NOW}).length,1);
    assert.equal(selectCoverage([row],{now:NOW,coverageChecks:{PTT:new Date(NOW-1000).toISOString()}}).length,0);
    assert.equal(selectCoverage([row],{now:NOW,mode:'eod'}).length,1);
  }
});

test('EOD on another day cannot postpone coverage, and coverage runs do not repeat inside seven days',async()=>{
  const db=backend();let time=NOW;const settings=env();
  const row=db.registry.get('PTT');Object.assign(row,{status:'verified',symbol_verified:true,chart_ready:true,
    last_checked_at:new Date(NOW-6*86400000).toISOString()});
  const make=()=>createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>time});
  db.advance(time,35);assert.equal((await make().execute({mode:'eod',tag:'eod'})).verified,1);
  time+=86400000;db.advance(time,36);
  assert.equal((await make().execute({tag:'due'})).verified,1);
  assert.equal((await make().execute({tag:'again'})).attempted,0);
  assert.equal(db.calls.filter(call=>call.url.hostname==='query1.finance.yahoo.com').length,2);
  time+=86400000;db.advance(time,37);
  assert.equal((await make().execute({mode:'eod',tag:'new-eod'})).verified,1);
  assert.equal((await make().execute({tag:'still-not-due'})).attempted,0);
});

test('calendar supports reviewed 2027 holidays and year transitions but blocks missing or malformed years',async()=>{
  assert.equal(tradingDay('2027-01-01'),false);assert.equal(tradingDay('2027-02-22'),false);
  assert.equal(tradingDay('2027-10-25'),false);assert.equal(tradingDay('2027-01-04'),true);
  assert.equal(latestSession(Date.parse('2027-01-04T07:00:00Z')),'2026-12-30');
  assert.equal(executionWindow({now:Date.parse('2027-01-04T07:00:00Z'),mode:'eod',recover:true,session:'2026-12-30'}).eligible,false);
  assert.equal(latestSession(Date.parse('2027-01-04T11:00:00Z')),'2027-01-04');
  assert.equal(calendarReadiness(NOW).calendarReadyForActivation,true);
  assert.equal(calendarReadiness(Date.parse('2027-12-30T11:00:00Z')).nextYearCovered,false);
  assert.equal(tradingDay('2028-01-03'),null);
  assert.equal(tradingDay('2027-01-04',{2027:{...CALENDARS[2027],holidays:['02-30']}}),null);
  assert.equal(tradingDay('2027-01-04',CALENDAR),null);
  assert.equal(tradingDay('2027-01-04',null),null);
  let calls=0;
  const controller=createControlledCoverage({env:env(),now:()=>Date.parse('2028-01-03T11:00:00Z'),fetchImpl:()=>{calls++;throw Error('must not fetch');}});
  assert.equal((await controller.execute()).reason,'CALENDAR_UNAVAILABLE');assert.equal(calls,0);
});

test('scaling plans retain five-stock jobs and reject unapproved/skipped stages or inadequate budgets',async()=>{
  const settings=env();let calls=0;
  const controller=createControlledCoverage({env:settings,now:()=>NOW,fetchImpl:()=>{calls++;throw Error('must not fetch');}});
  for(const size of [5,20,100,500]){
    const plan=await controller.execute({operation:'plan',targetSize:size});
    assert.equal(plan.jobSize,5);assert.equal(plan.jobs,size/5);assert.equal(plan.ownerApprovalRequired,size>5);
    assert.equal(plan.automaticExpansion,false);assert.equal(plan.schedulerEnabled,false);
    assert.equal(plan.budgets.providerRequests,size*2);assert.equal(plan.budgets.databaseRequests,size/5*200);
  }
  assert.equal(calls,0);await assert.rejects(controller.execute({targetSize:500}),/SCALE_APPROVAL/);
  for(const candidate of [{...approval(20),ownerApproved:false},{...approval(100),approvedStages:[5,100]},
    {...approval(20),providerDailyLimit:1},{...approval(500),databaseDailyLimit:200}]){
    assert.throws(()=>readScalePolicy({SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(candidate)}));
  }
  assert.equal(planBatchScale(500,readScalePolicy()).ownerApprovalRequired,true);
});

test('invalid expansion approval cannot disable status or stop controls',async()=>{
  const db=backend();db.advance(NOW,35);const settings=env();
  const controller=createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>NOW});
  const result=await controller.execute({tag:'controls'});
  settings.SETSCOPE_V156_SCALE_APPROVAL='invalid';
  assert.equal((await controller.execute({operation:'status',runKey:result.runKey})).phase,'completed');
  assert.equal((await controller.execute({operation:'stop',runKey:result.runKey})).phase,'completed');
});

for(const mode of ['coverage','eod'])for(const stage of [20,100,500])test(`approved fixture ${mode} campaign ${stage}: bounded jobs, no duplicates and persisted daily budget`,{timeout:120000},async()=>{
  const symbols=Array.from({length:stage},(_,index)=>'S'+index);
  const db=backend({symbols});let time=NOW,total=0,reads=0,writes=0;
  const settings={...env(),SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(approval(stage))};
  for(let index=0;index<stage/5;index++){
    db.advance(time,35);
    const result=await createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>time}).execute({mode,tag:'scale-'+index});
    assert.equal(result.attempted,5);assert.equal(result.metrics.providerCalls,5);
    assert.ok(result.metrics.databaseReads+result.metrics.databaseWrites<=JOB_BUDGET.databaseRequests);
    total+=result.attempted;reads+=result.metrics.databaseReads;writes+=result.metrics.databaseWrites;
    time+=60000;
  }
  assert.equal(total,stage);
  const providerCalls=db.calls.filter(call=>call.url.hostname==='query1.finance.yahoo.com');
  assert.equal(providerCalls.length,stage);assert.equal(new Set(providerCalls.map(call=>call.url.pathname)).size,stage);
  assert.ok(reads+writes<=approval(stage).databaseDailyLimit);
  await assert.rejects(createControlledCoverage({env:settings,fetchImpl:db.fetchImpl,now:()=>time}).execute({mode,tag:'over-budget'}),/DAILY_JOB_BUDGET/);
  const control=db.runs.get('v156:control').automation_state.metadata;
  assert.equal(control.reservations,stage/5);
  assert.equal(Object.keys(control.coverageChecks).length,stage);
});
