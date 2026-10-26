'use strict';
const {stopped}=require('./controlled-coverage-store');
const STAGES=[20,100,500],ID=/^\d{1,15}$/;
function validateContext(c){
 if(!c||Object.keys(c).some(k=>!['id','stage','roundId','reviewed','evidenceKind','sourceSha'].includes(k))||!ID.test(c.id||'')||!ID.test(c.roundId||'')
  ||!STAGES.includes(c.stage)||typeof c.reviewed!=='boolean'||!['synthetic','production-manual'].includes(c.evidenceKind)
  ||c.sourceSha!=null&&!/^[a-f0-9]{40}$/.test(c.sourceSha)||c.evidenceKind==='production-manual'&&!/^[a-f0-9]{40}$/.test(c.sourceSha||''))throw stopped('SCALING_INPUT_INVALID');
}
function validateState(s){
 if(!s||Object.keys(s).some(k=>!['version','id','stage','phase','roundId','roundFingerprint','evidenceKind','completedSymbols','completedJobs','acceptedStages'].includes(k))
  ||s.version!==1||!ID.test(s.id||'')||!STAGES.includes(s.stage)||!ID.test(s.roundId||'')||!/^[a-f0-9]{64}$/.test(s.roundFingerprint||'')
  ||!['running','awaiting_approval','completed','stopped'].includes(s.phase)||!['synthetic','production-manual'].includes(s.evidenceKind)
  ||!Array.isArray(s.completedSymbols)||s.completedSymbols.length>s.stage||new Set(s.completedSymbols).size!==s.completedSymbols.length
  ||s.completedSymbols.some(x=>!/^([A-Z0-9&.-]){1,20}$/.test(x))||!Array.isArray(s.completedJobs)||s.completedJobs.length>100
  ||s.completedJobs.length*5!==s.completedSymbols.length||!Array.isArray(s.acceptedStages)||s.acceptedStages.length>3
  ||Buffer.byteLength(JSON.stringify(s))>131072)throw stopped('SCALING_CHECKPOINT_INVALID');
 for(const j of s.completedJobs){
  if(!j||Object.keys(j).some(k=>!['runKey','attempted','verified','partial','temporaryFailed','sourceSha'].includes(k))||!/^v156:coverage:\d{4}-\d\d-\d\d:[a-zA-Z0-9_-]{1,24}$/.test(j.runKey||'')
   ||j.attempted!==5||j.verified!==5||j.partial!==0||j.temporaryFailed!==0
   ||j.sourceSha!=null&&!/^[a-f0-9]{40}$/.test(j.sourceSha)||s.evidenceKind==='production-manual'&&!/^[a-f0-9]{40}$/.test(j.sourceSha||''))throw stopped('SCALING_CHECKPOINT_INVALID');
 }
 if(new Set(s.completedJobs.map(j=>j.runKey)).size!==s.completedJobs.length)throw stopped('SCALING_CHECKPOINT_INVALID');
 for(const r of s.acceptedStages)if(!r||Object.keys(r).some(k=>!['id','stage','verified','evidenceKind'].includes(k))||!ID.test(r.id||'')||!STAGES.includes(r.stage)||r.verified!==r.stage||r.evidenceKind!==s.evidenceKind)throw stopped('SCALING_CHECKPOINT_INVALID');
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
 if(plan.targets.slice(index*5).some(r=>s.completedSymbols.includes(r.symbol))||s.completedSymbols.length+plan.targets.slice(index*5).length>c.stage)throw stopped('SCALING_DUPLICATE_OR_SIZE');
 return {...s,phase:'running',roundId:c.roundId,roundFingerprint:plan.fingerprint};
}
function complete(s,plan,index,result){
 validateState(s);
 if(result.verified!==5||result.partial||result.temporaryFailed)throw stopped('SCALING_JOB_NOT_VERIFIED');
 const symbols=plan.targets.slice(index*5,index*5+5).map(r=>r.symbol);
 if(symbols.some(x=>s.completedSymbols.includes(x))||s.roundFingerprint!==plan.fingerprint)throw stopped('SCALING_SEQUENCE_INVALID');
 const next={...s,completedSymbols:[...s.completedSymbols,...symbols],completedJobs:[...s.completedJobs,
  {runKey:result.runKey,attempted:result.attempted,verified:result.verified,partial:result.partial,temporaryFailed:result.temporaryFailed,sourceSha:plan.scaling.sourceSha||null}]};
 next.phase=next.completedSymbols.length===s.stage?'completed':index===plan.runKeys.length-1?'awaiting_approval':'running';
 if(next.phase==='completed')next.acceptedStages=[...s.acceptedStages,{id:s.id,stage:s.stage,verified:s.stage,evidenceKind:s.evidenceKind}];
 validateState(next);return next;
}
module.exports={validateContext,validateState,progress,admit,complete};
