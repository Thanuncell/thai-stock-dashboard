'use strict';
const {createHash}=require('node:crypto');
const {selectCoverage,bangkokDay,executionWindow}=require('./automation-policy');
const {JOB_BUDGET,readScalePolicy}=require('./automation-scaling');
const {stopped,CONTROL_KEY}=require('./controlled-coverage-store');
const {coverageTruth}=require('./coverage-truth');
const APPROVAL=Object.freeze({ownerApproved:true,stage:20,approvedStages:[5,20],maxJobsPerDay:4,providerDailyLimit:40,databaseDailyLimit:800});
const identity=row=>({symbol:row.symbol,provider_symbol:row.provider_symbol,provider:row.provider,active:row.active});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateRows(rows,identitiesOnly=false){
 if(!Array.isArray(rows)||rows.length>1000||new Set(rows.map(r=>r?.symbol)).size!==rows.length)throw stopped('BATCH_MAPPING_INVALID');
 if(rows.some(r=>!r||typeof r.active!=='boolean'||!identitiesOnly&&!['pending','verified','partial','temporary_failed','inactive','unsupported'].includes(r.status)))throw stopped('BATCH_MAPPING_INVALID');
 for(const r of rows)if(r?.active===true&&!['inactive','unsupported'].includes(r.status)
  &&(!/^[A-Z0-9&.-]{1,20}$/.test(r.symbol)||r.provider_symbol!==r.symbol+'.BK'||r.provider!=='Yahoo Finance'))throw stopped('BATCH_MAPPING_INVALID');
}
function assertControl(row,now){
 if(!row)return {};
 const state=row.automation_state,meta=state.metadata||{};
 if(!['completed','failed'].includes(state.phase)||state.phase==='failed'&&!meta.activeJob||Date.parse(state.leaseUntil)>now)throw stopped('BATCH_COORDINATOR_NOT_RELEASED');
 if(meta.denied||Date.parse(meta.blockedUntil||'')>now||meta.failedSecurities>=3||meta.providerFailures>=3)throw stopped('PROVIDER_CIRCUIT_OPEN');
 if(meta.manualBatch&&meta.manualBatch.phase!=='completed')throw stopped('BATCH_RECOVERY_REQUIRED');
 return meta;
}
function assertCapacity(meta,now,jobs=4){
 const used=meta.day===bangkokDay(now)?meta.reservations||0:0;
 const policy=readScalePolicy({SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(APPROVAL)});
 if(!Number.isSafeInteger(used)||used<0||used+jobs>policy.maxJobsPerDay
  ||(used+jobs)*JOB_BUDGET.providerRequests>policy.providerDailyLimit
  ||(used+jobs)*JOB_BUDGET.databaseRequests>policy.databaseDailyLimit)throw stopped('BATCH_DAILY_CAPACITY');
 return used;
}
function makePlan({rows,metadata={},now,id}){
 if(!/^\d{1,15}$/.test(id||''))throw stopped('BATCH_ID_INVALID');
 if(!executionWindow({now,mode:'coverage'}).eligible)throw stopped('BATCH_WINDOW_CLOSED');
 validateRows(rows);const selected=[];
 for(let i=0;i<4;i++){
  const next=selectCoverage(rows,{now,coverageChecks:metadata.coverageChecks||{},excludeSymbols:selected.map(r=>r.symbol)});
  if(next.length!==5)throw stopped('BATCH_NOT_ENOUGH_DUE');selected.push(...next);
 }
 const day=bangkokDay(now),targets=selected.map(identity);
 const runKeys=Array.from({length:4},(_,i)=>`v156:coverage:${day}:b20-${id}-${i+1}`);
 const plan={version:1,id,day,targets,runKeys,initialReservations:assertCapacity(metadata,now)};
 return {...plan,fingerprint:digest(plan)};
}
function validatePlan(plan){
 if(!plan||plan.version!==1||!/^\d{1,15}$/.test(plan.id||'')||!/^\d{4}-\d\d-\d\d$/.test(plan.day||'')
  ||!Array.isArray(plan.targets)||plan.targets.length!==20||new Set(plan.targets.map(r=>r.symbol)).size!==20
  ||!Array.isArray(plan.runKeys)||JSON.stringify(plan.runKeys)!==JSON.stringify(Array.from({length:4},(_,i)=>`v156:coverage:${plan.day}:b20-${plan.id}-${i+1}`))
  ||!Number.isSafeInteger(plan.initialReservations)||plan.initialReservations<0)throw stopped('BATCH_PLAN_INVALID');
 validateRows(plan.targets,true);
 if(plan.targets.some(r=>r.active!==true))throw stopped('BATCH_MAPPING_INVALID');
 const {fingerprint,...body}=plan;if(fingerprint!==digest(body))throw stopped('BATCH_PLAN_INVALID');
}
function selectPinned(plan,index,rows,metadata,now){
 validatePlan(plan);validateRows(rows);
 if(plan.day!==bangkokDay(now)||!Number.isInteger(index)||index<0||index>3)throw stopped('BATCH_PLAN_EXPIRED');
 const selected=plan.targets.slice(index*5,index*5+5).map(target=>{
  const row=rows.find(r=>r.symbol===target.symbol);
  if(!row||JSON.stringify(identity(row))!==JSON.stringify(target))throw stopped('BATCH_MAPPING_CHANGED');return row;
 });
 if(selectCoverage(selected,{now,coverageChecks:metadata.coverageChecks||{}}).length!==5)throw stopped('BATCH_NO_LONGER_DUE');
 return selected;
}
async function inspectOptional(store,key){try{return await store.inspect(key);}catch(e){if(e.code==='JOB_NOT_FOUND')return null;throw e;}}
async function preflight({repository,store,now,id}){
 const report={status:'BLOCKED',dueCount:null,requiredCount:20,quotaRemaining:null,coordinator:'NOT_CHECKED',checkpoint:'NOT_CHECKED',reasonCode:null};
 try{
  const control=await inspectOptional(store,CONTROL_KEY),metadata=control?.automation_state?.metadata||{};
  report.coordinator=control?control.automation_state.phase:'NOT_CREATED';
  const used=metadata.day===bangkokDay(now)?metadata.reservations||0:0;
  report.quotaRemaining={jobs:Math.max(0,4-used),providerRequests:Math.max(0,40-used*10),databaseRequests:Math.max(0,800-used*200)};
  const rows=await repository.listCandidates();validateRows(rows);
  report.dueCount=dueCandidates(rows,metadata,now).length;
  assertControl(control,now);report.checkpoint='CLEAR';
  if(metadata.activeJob){const previous=await store.status(metadata.activeJob);report.checkpoint=previous.requiresReconciliation?'UNCERTAIN':previous.phase;
   if(previous.requiresReconciliation||!['completed','stopped'].includes(previous.phase))throw stopped('BATCH_RECOVERY_REQUIRED');}
  const plan=makePlan({rows,metadata,now,id});
  for(const key of plan.runKeys)if(await inspectOptional(store,key))throw stopped('BATCH_ALREADY_ATTEMPTED');
  report.status='READY';return {plan,rows,preflight:report};
 }catch(error){report.reasonCode=/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'BATCH_PREFLIGHT_UNAVAILABLE';error.preflight=report;throw error;}
}
function dueCandidates(rows,metadata,now){
 const selected=[];
 while(selected.length<rows.length){const next=selectCoverage(rows,{now,coverageChecks:metadata.coverageChecks||{},excludeSymbols:selected.map(r=>r.symbol)});if(!next.length)break;selected.push(...next);}
 return selected;
}
function unchangedOutside(before,after,symbols){
 const others=rows=>rows.filter(r=>!symbols.includes(r.symbol)).sort((a,b)=>a.symbol.localeCompare(b.symbol));
 return JSON.stringify(others(before))===JSON.stringify(others(after));
}
function counts(rows,now){return {total:rows.length,...coverageTruth(rows,{now}),verified:rows.filter(r=>r.active&&r.status==='verified').length,
 chartReady:rows.filter(r=>r.active&&r.chart_ready).length,technicalReady:rows.filter(r=>r.active&&r.technical_ready).length};}
module.exports={APPROVAL,identity,validatePlan,assertCapacity,selectPinned,preflight,unchangedOutside,counts};
