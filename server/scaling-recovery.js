'use strict';
const {createHash}=require('node:crypto');
const {stopped,CONTROL_KEY}=require('./controlled-coverage-store');
const {safeCheckpoint}=require('./checkpoint-safety');
const {batchKey}=require('./coverage-checkpoint');
const {bangkokDay}=require('./automation-policy');
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
function validateBatch(b){
 if(!b||Object.keys(b).some(k=>!['version','id','day','targets','runKeys','initialReservations','fingerprint','next','phase','targetSize','scaling','exclusions','eligibilityReview'].includes(k)))throw stopped('SCALING_RECOVERY_INVALID');
 // Legacy plan digests used insertion order. JSONB changes key ordering, so
 // reconstruct that exact contract rather than rewriting an existing digest.
 const c=b.scaling;
 const scaling=c?{id:c.id,stage:c.stage,roundId:c.roundId,reviewed:c.reviewed,evidenceKind:c.evidenceKind,...(Object.hasOwn(c,'sourceSha')?{sourceSha:c.sourceSha}:{})}:null;
 const exclusions=b.exclusions?.map(e=>({symbol:e.symbol,provider_symbol:e.provider_symbol,reason:e.reason,reviewedOn:e.reviewedOn,source:e.source,corroboration:e.corroboration}));
 const plan={version:b.version,id:b.id,day:b.day,targets:b.targets?.map(require('./manual-batch-policy').identity),runKeys:b.runKeys,initialReservations:b.initialReservations,
  ...(exclusions?{exclusions,eligibilityReview:b.eligibilityReview}:{}),...(Object.hasOwn(b,'targetSize')?{targetSize:b.targetSize}:{}),...(scaling?{scaling}:{}),fingerprint:b.fingerprint};
 require('./manual-batch-policy').validatePlan(plan);
}
function validateReceipt(r){
 if(!r||Object.keys(r).some(k=>!['roundId','sourceSha','reviewedAt','priorBatch','jobKey','jobRevision','checkpointDigest','excludedSymbols','quotaBefore','quotaAfter'].includes(k))
  ||!/^\d{1,15}$/.test(r.roundId||'')||r.sourceSha!==null&&!/^[a-f0-9]{40}$/.test(r.sourceSha||'')
  ||!Number.isFinite(Date.parse(r.reviewedAt||''))||!Number.isSafeInteger(r.jobRevision)||r.jobRevision<0||!/^[a-f0-9]{64}$/.test(r.checkpointDigest||'')
  ||!Array.isArray(r.excludedSymbols)||r.excludedSymbols.length!==5||new Set(r.excludedSymbols).size!==5)throw stopped('SCALING_RECOVERY_INVALID');
 for(const q of [r.quotaBefore,r.quotaAfter])if(!q||Object.keys(q).some(k=>!['day','reservations'].includes(k))||!/^\d{4}-\d\d-\d\d$/.test(q.day||'')||!Number.isSafeInteger(q.reservations)||q.reservations<0||q.reservations>4)throw stopped('SCALING_RECOVERY_INVALID');
 if(r.quotaAfter.day!==bangkokDay(Date.parse(r.reviewedAt))||r.quotaAfter.reservations!==(r.quotaBefore.day===r.quotaAfter.day?r.quotaBefore.reservations:0)+1)throw stopped('SCALING_RECOVERY_INVALID');
 const b=r.priorBatch;validateBatch(b);
 if(b.phase!=='stopped'||!Number.isInteger(b.next)||b.next<0||b.next>=b.runKeys.length||r.jobKey!==b.runKeys[b.next]
  ||JSON.stringify(r.excludedSymbols)!==JSON.stringify(b.targets.slice(b.next*5,b.next*5+5).map(t=>t.symbol))||r.roundId===b.id)throw stopped('SCALING_RECOVERY_INVALID');
}
function isRecovered(metadata){
 const s=metadata.scaling,b=metadata.manualBatch,r=s?.recoveries?.at(-1);if(!r||b?.phase!=='recovered')return false;
 validateReceipt(r);
 return s.phase==='awaiting_approval'&&s.id===b.scaling?.id&&s.stage===b.scaling?.stage&&s.roundFingerprint===b.fingerprint&&s.roundId===r.roundId&&r.jobKey===metadata.activeJob
  &&b.fingerprint===r.priorBatch.fingerprint&&hash({...b,phase:'stopped'})===hash(r.priorBatch);
}
async function assertEvidence(metadata,store){
 if(!isRecovered(metadata))throw stopped('SCALING_RECOVERY_INVALID');
 const r=metadata.scaling.recoveries.at(-1),row=await store.inspect(r.jobKey),state=row.automation_state;
 if(state.phase!=='stopped'||state.revision!==r.jobRevision||hash(state.documents)!==r.checkpointDigest||row.failure_reason!=='OPERATOR_RECONCILED_WITHOUT_REPLAY')throw stopped('SCALING_RECOVERY_STATE_CHANGED');
}
async function inspect({store,repository,metadata,context,now,held=false}){
 const policy=require('./scaling-policy'),batch=require('./manual-batch-policy');
 policy.validateContext(context);const s=metadata.scaling;policy.validateState(s);
 const b=metadata.manualBatch;validateBatch(b);
 if(s.stage!==100||s.stage!==context.stage||s.id!==context.id||s.evidenceKind!==context.evidenceKind||s.phase!=='stopped'
  ||b.phase!=='stopped'||s.roundFingerprint!==b.fingerprint||s.roundId!==b.id||b.scaling?.id!==s.id
  ||context.roundId===s.roundId||s.recoveries?.some(r=>r.roundId===context.roundId)
  ||!Number.isInteger(b.next)||b.next<0||b.next>=b.runKeys.length)throw stopped('SCALING_RECOVERY_STATE_CONFLICT');
 if(s.acceptedStages.length!==1||s.acceptedStages[0].stage!==20||s.acceptedStages[0].verified!==20
  ||metadata.day!==b.day||!Number.isSafeInteger(metadata.reservations)||metadata.reservations<b.initialReservations+b.next+1||metadata.reservations>4
  ||b.targets.slice(b.next*5,b.next*5+5).some(t=>s.completedSymbols.includes(t.symbol)))throw stopped('SCALING_RECOVERY_STATE_CONFLICT');
 // Reuse the normal circuit/lease checks without pretending the stopped batch completed.
 const control=await store.inspect(CONTROL_KEY);
 if(held)await store.assertActive();else batch.assertReleasedForRecovery(control,now);
 if(hash(control.automation_state.metadata)!==hash(metadata))throw stopped('SCALING_RECOVERY_STATE_CHANGED');
 const key=b.runKeys[b.next];if(metadata.activeJob!==key)throw stopped('SCALING_RECOVERY_STATE_CONFLICT');
 const failed=await store.inspect(key),state=failed.automation_state;
 if(state.phase!=='stopped'||failed.failure_reason!=='OPERATOR_RECONCILED_WITHOUT_REPLAY'||Date.parse(state.leaseUntil)>now)
  throw stopped('SCALING_RECONCILIATION_REQUIRED');
 const manifest=state.documents['coverage-manifest:'+key],checkpoint=state.documents['coverage-items:'+key];
 safeCheckpoint(manifest);
 if(!checkpoint||checkpoint.version!==1||checkpoint.status!=='running'||checkpoint.fingerprint!==batchKey(manifest.rows)
  ||Object.keys(state.documents).some(k=>!['coverage-manifest:'+key,'coverage-items:'+key].includes(k))
  ||!checkpoint.entries||Array.isArray(checkpoint.entries)||!Object.keys(checkpoint.entries).length
  ||Object.entries(checkpoint.entries).some(([symbol,e])=>!manifest.rows.some(r=>r.symbol===symbol)||e.status!=='abandoned'||Object.keys(e).some(k=>k!=='status')))
  throw stopped('SCALING_RECOVERY_SIDE_EFFECT_UNCERTAIN');
 const targets=b.targets.slice(b.next*5,b.next*5+5);
 if(manifest.rows.length!==5||manifest.batchSize!==5||JSON.stringify(manifest.rows.map(batch.identity))!==JSON.stringify(targets.map(batch.identity)))throw stopped('SCALING_RECOVERY_STATE_CONFLICT');
 const rows=await repository.listCandidates();
 batch.validateRecoveryRows(rows);
 // An inflight record alone never authorizes overwriting a changed registry row.
 if(manifest.rows.some(old=>{const current=rows.find(r=>r.symbol===old.symbol);return !current||Object.keys(old).some(k=>JSON.stringify(old[k])!==JSON.stringify(current[k]));}))
  throw stopped('SCALING_RECOVERY_SIDE_EFFECT_UNCERTAIN');
 const priorKeys=b.runKeys.slice(0,b.next),tail=s.completedJobs.slice(-b.next||s.completedJobs.length).map(j=>j.runKey);
 if(b.next&&JSON.stringify(priorKeys)!==JSON.stringify(tail))throw stopped('SCALING_RECOVERY_RECEIPT_CONFLICT');
 for(let i=0;i<b.next;i++){
  const row=await store.inspect(priorKeys[i]);
  const cp=row.automation_state.documents['coverage-items:'+priorKeys[i]];
  if(row.automation_state.phase!=='completed'||row.attempted!==5||row.verified!==5||Number(row.partial||0)!==0||Number(row.temporary_failed||0)!==0
   ||cp?.status!=='completed'||Object.keys(cp.entries||{}).length!==5
   ||b.targets.slice(i*5,i*5+5).some(t=>cp.entries[t.symbol]?.status!=='applied'||cp.entries[t.symbol]?.result?.status!=='verified'||!s.completedSymbols.includes(t.symbol)))
   throw stopped('SCALING_RECOVERY_RECEIPT_CONFLICT');
 }
 for(const unused of b.runKeys.slice(b.next+1)){try{await store.inspect(unused);}catch(e){if(e.code==='JOB_NOT_FOUND')continue;throw e;}throw stopped('SCALING_RECOVERY_STATE_CONFLICT');}
 const excludedSymbols=targets.map(t=>t.symbol);
 const reserved=batch.assertCapacity(metadata,now,1,100);
 // Exclude the entire failed job from this stage, including unattempted targets;
 // this conservative choice makes any replay impossible without reducing 100.
 const receipt={roundId:context.roundId,sourceSha:context.sourceSha||null,reviewedAt:new Date(now).toISOString(),priorBatch:structuredClone(b),jobKey:key,
  jobRevision:state.revision,checkpointDigest:hash(state.documents),excludedSymbols,
  quotaBefore:{day:metadata.day,reservations:metadata.reservations},quotaAfter:{day:bangkokDay(now),reservations:reserved+1}};
 validateReceipt(receipt);
 const fingerprint=hash({metadata,failed,rows,reviewDay:bangkokDay(now),sourceSha:context.sourceSha||null});
 return {receipt,fingerprint};
}
async function recover({store,repository,context,now,fingerprint}){
 let held=false,outcome='failed';
 try{
  // Read-only validation first; the same evidence is checked again under CAS lease.
  const control=await store.inspect(CONTROL_KEY),metadata=control.automation_state.metadata;
  const before=await inspect({store,repository,metadata,context,now});
  if(!context.reviewed||before.fingerprint!==fingerprint)throw stopped('SCALING_RECOVERY_REVIEW_REQUIRED');
  const gate=await store.beginRun({runKey:CONTROL_KEY,startedAt:new Date(now).toISOString(),batchSize:5,concurrency:1,resume:true});
  if(gate.alreadyRunning)throw stopped('SCALING_RECOVERY_STATE_CHANGED');held=true;
  const latest=await store.metadata();
  const checked=await inspect({store,repository,metadata:latest,context,now,held:true});
  if(checked.fingerprint!==fingerprint)throw stopped('SCALING_RECOVERY_STATE_CHANGED');
  // Reserve one existing capacity slot for this bounded maintenance operation;
  // it is not a verification job and never manufactures a job receipt.
  await store.updateMetadata({...checked.receipt.quotaAfter,manualBatch:{...latest.manualBatch,phase:'recovered'},scaling:{...latest.scaling,phase:'awaiting_approval',roundId:context.roundId,
   recoveries:[...(latest.scaling.recoveries||[]),checked.receipt]}});
  outcome='completed';
  return {status:'RECOVERED',stage:context.stage,id:context.id,replayed:false,jobsStarted:0,requiresFreshPreflight:true};
 }finally{if(held)await store.releaseCoordinator(outcome);}
}
module.exports={validateReceipt,isRecovered,assertEvidence,inspect,recover,hash};
