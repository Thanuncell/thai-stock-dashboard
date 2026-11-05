'use strict';
const {stopped}=require('./controlled-coverage-store');
const {safeCheckpoint}=require('./checkpoint-safety');
const {batchKey}=require('./coverage-checkpoint');
const STAGES=[20,100,500],ID=/^\d{1,15}$/;
function validateContext(c){
 if(!c||Object.keys(c).some(k=>!['id','stage','roundId','reviewed','evidenceKind','sourceSha'].includes(k))||!ID.test(c.id||'')||!ID.test(c.roundId||'')
  ||!STAGES.includes(c.stage)||typeof c.reviewed!=='boolean'||!['synthetic','production-manual'].includes(c.evidenceKind)
  ||c.sourceSha!=null&&!/^[a-f0-9]{40}$/.test(c.sourceSha)||c.evidenceKind==='production-manual'&&!/^[a-f0-9]{40}$/.test(c.sourceSha||''))throw stopped('SCALING_INPUT_INVALID');
}
function validateState(s){
 if(!s||Object.keys(s).some(k=>!['version','id','stage','phase','roundId','roundFingerprint','evidenceKind','completedSymbols','completedJobs','acceptedStages','recoveries'].includes(k))
  ||s.version!==1||!ID.test(s.id||'')||!STAGES.includes(s.stage)||!ID.test(s.roundId||'')||!/^[a-f0-9]{64}$/.test(s.roundFingerprint||'')
  ||!['running','awaiting_approval','completed','stopped'].includes(s.phase)||!['synthetic','production-manual'].includes(s.evidenceKind)
  ||!Array.isArray(s.completedSymbols)||s.completedSymbols.length>s.stage||new Set(s.completedSymbols).size!==s.completedSymbols.length
  ||s.completedSymbols.some(x=>!/^([A-Z0-9&.-]){1,20}$/.test(x))||!Array.isArray(s.completedJobs)||s.completedJobs.length>500
  ||!Array.isArray(s.acceptedStages)||s.acceptedStages.length>3
  ||Buffer.byteLength(JSON.stringify(s))>131072)throw stopped('SCALING_CHECKPOINT_INVALID');
 if(s.recoveries!==undefined){
  if(!Array.isArray(s.recoveries)||s.recoveries.length>4||new Set(s.recoveries.map(r=>r.roundId)).size!==s.recoveries.length)throw stopped('SCALING_RECOVERY_INVALID');
  for(const r of s.recoveries){require('./scaling-recovery').validateReceipt(r);if(r.priorBatch.scaling?.id!==s.id||r.priorBatch.scaling?.stage!==s.stage
   ||r.priorBatch.scaling?.evidenceKind!==s.evidenceKind||s.evidenceKind==='production-manual'&&!/^[a-f0-9]{40}$/.test(r.sourceSha||''))throw stopped('SCALING_RECOVERY_INVALID');}
 }
 let offset=0;
 for(const j of s.completedJobs){
  if(!j||Object.keys(j).some(k=>!['runKey','attempted','verified','partial','temporaryFailed','sourceSha','verifiedSymbols'].includes(k))||
   !/^v156:coverage:\d{4}-\d\d-\d\d:[a-zA-Z0-9_-]{1,24}$/.test(j.runKey||'')||!validCounts(j)
   ||j.sourceSha!=null&&!/^[a-f0-9]{40}$/.test(j.sourceSha)||s.evidenceKind==='production-manual'&&!/^[a-f0-9]{40}$/.test(j.sourceSha||''))throw stopped('SCALING_CHECKPOINT_INVALID');
  const symbols=s.completedSymbols.slice(offset,offset+j.verified);
  if(j.verifiedSymbols===undefined ? j.verified!==5 :
   !Array.isArray(j.verifiedSymbols)||JSON.stringify(j.verifiedSymbols)!==JSON.stringify(symbols))throw stopped('SCALING_CHECKPOINT_INVALID');
  offset+=j.verified;
 }
 if(offset!==s.completedSymbols.length)throw stopped('SCALING_CHECKPOINT_INVALID');
 if(new Set(s.completedJobs.map(j=>j.runKey)).size!==s.completedJobs.length)throw stopped('SCALING_CHECKPOINT_INVALID');
 for(const r of s.acceptedStages){
  if(!r||Object.keys(r).some(k=>!['id','stage','verified','evidenceKind','recoveries'].includes(k))||!ID.test(r.id||'')||!STAGES.includes(r.stage)||r.verified!==r.stage||r.evidenceKind!==s.evidenceKind)throw stopped('SCALING_CHECKPOINT_INVALID');
  if(r.recoveries!==undefined){
   if(!Array.isArray(r.recoveries)||r.recoveries.length>4)throw stopped('SCALING_RECOVERY_INVALID');
   for(const h of r.recoveries){require('./scaling-recovery').validateReceipt(h);
    if(h.priorBatch.scaling?.id!==r.id||h.priorBatch.scaling?.stage!==r.stage||h.priorBatch.scaling?.evidenceKind!==r.evidenceKind)throw stopped('SCALING_RECOVERY_INVALID');}
  }
 }
 if(new Set(s.acceptedStages.map(r=>r.stage)).size!==s.acceptedStages.length)throw stopped('SCALING_CHECKPOINT_INVALID');
 if(JSON.stringify(s.acceptedStages.map(r=>r.stage))!==JSON.stringify(STAGES.slice(0,s.acceptedStages.length))
  ||s.acceptedStages.some(r=>r.stage>s.stage)||s.phase==='completed'&&(s.completedSymbols.length!==s.stage||s.acceptedStages.at(-1)?.stage!==s.stage))throw stopped('SCALING_CHECKPOINT_INVALID');
}
function assertCanary(row){
 if(row?.status!=='completed'||row.verified!==5||Number(row.temporary_failed||0)!==0)throw stopped('SCALING_CANARY_REQUIRED');
}
function progress(metadata,c,{requireReview=false,canary}={}){
 validateContext(c);const s=metadata.scaling;if(s)validateState(s);
 if(s&&s.evidenceKind!==c.evidenceKind)throw stopped('SCALING_EVIDENCE_MISMATCH');
 if(s?.id===c.id){
  if(s.phase==='completed')throw stopped('SCALING_STAGE_ALREADY_ACCEPTED');
  if(s.stage!==c.stage||s.phase!=='awaiting_approval'||s.roundId===c.roundId)throw stopped('SCALING_REVIEW_REQUIRED');
  if(requireReview&&!c.reviewed)throw stopped('SCALING_CONTINUATION_APPROVAL_REQUIRED');
  return s;
 }
 if(s&&s.phase!=='completed')throw stopped('SCALING_STAGE_ACTIVE');
 const acceptedStages=s?.acceptedStages||[];
 if(acceptedStages.some(r=>r.stage===c.stage))throw stopped('SCALING_STAGE_ALREADY_ACCEPTED');
 const predecessor=STAGES[STAGES.indexOf(c.stage)-1];
 if(predecessor&&!acceptedStages.some(r=>r.stage===predecessor))throw stopped('SCALING_PREDECESSOR_REQUIRED');
 if(c.stage===20)assertCanary(canary);
 return {version:1,id:c.id,stage:c.stage,phase:'awaiting_approval',roundId:c.roundId,roundFingerprint:'0'.repeat(64),evidenceKind:c.evidenceKind,
  completedSymbols:[],completedJobs:[],acceptedStages};
}
function admit(metadata,plan,index,canary){
 const c=plan.scaling;validateContext(c);if(plan.id!==c.roundId)throw stopped('SCALING_INPUT_INVALID');
 let s;
 if(index===0)s=progress(metadata,c,{requireReview:true,canary});
 else{
  s=metadata.scaling;validateState(s);
  if(s.id!==c.id||s.stage!==c.stage||s.phase!=='running'||s.roundFingerprint!==plan.fingerprint||s.roundId!==c.roundId)throw stopped('SCALING_SEQUENCE_INVALID');
 }
 if(plan.targets.slice(index*5).some(r=>s.completedSymbols.includes(r.symbol)||s.recoveries?.some(h=>h.excludedSymbols.includes(r.symbol)))||s.completedSymbols.length+plan.targets.slice(index*5).length>c.stage)throw stopped('SCALING_DUPLICATE_OR_SIZE');
 return {...s,phase:'running',roundId:c.roundId,roundFingerprint:plan.fingerprint};
}
function validCounts(job) {
 return Number.isInteger(job.attempted) && job.attempted >= 1 && job.attempted <= 5 &&
  [job.verified, job.partial, job.temporaryFailed].every(n => Number.isInteger(n) && n >= 0) &&
  job.verified + job.partial + job.temporaryFailed === job.attempted;
}

function completedEvidence(row, plan, index) {
 const runKey=plan.runKeys[index], state=row.automation_state;
 const targets=plan.targets.slice(index*5,index*5+5);
 const manifest=state.documents['coverage-manifest:'+runKey];
 const checkpoint=state.documents['coverage-items:'+runKey];
 const {identity}=require('./manual-batch-policy');
 const invalid=()=>stopped('SCALING_JOB_EVIDENCE_INVALID');
 if(row.run_key!==runKey||row.status!=='completed'||state.phase!=='completed'||row.batch_size!==targets.length||
  row.concurrency!==1||state.metadata?.mode!=='coverage'||state.metadata?.session!==plan.day||
  !manifest||!checkpoint)throw invalid();
 safeCheckpoint(manifest);
 safeCheckpoint(checkpoint);
 if(manifest.batchSize!==targets.length||manifest.rows.length!==targets.length||
  checkpoint.status!=='completed'||checkpoint.fingerprint!==batchKey(manifest.rows)||
  Object.keys(checkpoint.entries).length!==targets.length||
  JSON.stringify(manifest.rows.map(identity))!==JSON.stringify(targets.map(identity)))throw invalid();
 const results=targets.map(target=>{
  const entry=checkpoint.entries[target.symbol], result=entry?.result;
  if(entry?.status!=='applied'||!result||JSON.stringify(identity(result))!==JSON.stringify(identity(target))||
   !['verified','partial','temporary_failed'].includes(result.status)||!Number.isFinite(Date.parse(result.last_checked_at)))throw invalid();
  if(result.status==='verified'&&(!result.symbol_verified||!result.chart_ready||
   !['accepted','delayed'].includes(result.guard_status)||result.last_verified_at!==result.last_checked_at))throw invalid();
  return result;
 });
 const verifiedSymbols=results.filter(r=>r.status==='verified').map(r=>r.symbol);
 const receipt={runKey,attempted:row.attempted,verified:row.verified,partial:row.partial,temporaryFailed:row.temporary_failed,
  sourceSha:plan.scaling.sourceSha||null,verifiedSymbols};
 if(!validCounts(receipt)||receipt.attempted!==targets.length||receipt.verified!==verifiedSymbols.length||
  receipt.partial!==results.filter(r=>r.status==='partial').length)throw invalid();
 return {receipt,results};
}

function complete(s,plan,index,receipt){
 validateState(s);
 const symbols=receipt.verifiedSymbols;
 if(receipt.runKey!==plan.runKeys[index]||symbols.some(x=>s.completedSymbols.includes(x))||
  s.roundFingerprint!==plan.fingerprint)throw stopped('SCALING_SEQUENCE_INVALID');
 const next={...s,completedSymbols:[...s.completedSymbols,...symbols],completedJobs:[...s.completedJobs,receipt]};
 next.phase=next.completedSymbols.length===s.stage?'completed':index===plan.runKeys.length-1?'awaiting_approval':'running';
 if(next.phase==='completed')next.acceptedStages=[...s.acceptedStages,{id:s.id,stage:s.stage,verified:s.stage,evidenceKind:s.evidenceKind,...(s.recoveries?.length?{recoveries:structuredClone(s.recoveries)}:{})}];
 validateState(next);
 return next;
}
module.exports={validateContext,validateState,progress,admit,complete,completedEvidence};
