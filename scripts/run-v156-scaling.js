'use strict';
const {authorize}=require('./run-v156-batch20');
const {createControlledCoverage}=require('../server/controlled-coverage');
const {createControlledCoverageStore,stopped}=require('../server/controlled-coverage-store');
const {createCoverageRepository}=require('../server/coverage-service');
const {createRequestDeadline}=require('../server/request-deadline');
const batch=require('../server/manual-batch-policy'),scaling=require('../server/scaling-policy'),canary=require('../server/canary-policy');
async function main({env=process.env,fetchImpl=globalThis.fetch,now=Date.now,deadlineFactory=createRequestDeadline,onReport=()=>{},evidenceKind='synthetic',
 mode=env.SETSCOPE_SCALE_MODE||'preflight',stage=Number(env.SETSCOPE_SCALE_STAGE||20),roundJobs=Number(env.SETSCOPE_SCALE_ROUND_JOBS||4)}={}){
 let deadline=deadlineFactory(),jobStarted=false,reads=0;
 const id=env.SETSCOPE_SCALE_ID||env.GITHUB_RUN_ID,context={id,stage,roundId:env.GITHUB_RUN_ID,reviewed:env.SETSCOPE_SCALE_REVIEW===`REVIEWED ${id}`,evidenceKind,sourceSha:env.GITHUB_SHA||null};
 const report={status:'BLOCKED',evidenceKind,acceptance:'OWNER_REVIEW_REQUIRED',versionClosed:false,stage,id,roundId:env.GITHUB_RUN_ID,sourceSha:env.GITHUB_SHA||null,jobsStarted:0,
  attempted:0,verified:0,partial:0,temporaryFailed:0,countsScope:'no-jobs-started',jobs:[],before:null,after:null,afterStatus:'NOT_RUN',
  preflight:{status:'NOT_RUN',dueCount:null,requiredCount:roundJobs*5,quotaRemaining:null,coordinator:'NOT_CHECKED',checkpoint:'NOT_CHECKED',reasonCode:null}};
 const cancel=()=>deadline.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 try{
  authorize({...env,SETSCOPE_BATCH_CONFIRMATION:'RUN COVERAGE 20'},mode);
  scaling.validateContext(context);
  if(!Number.isInteger(roundJobs)||roundJobs<1||roundJobs>4||mode==='run'&&env.SETSCOPE_SCALE_CONFIRMATION!==`RUN COVERAGE ${stage}`)throw stopped('SCALING_APPROVAL_REQUIRED');
  const settings={...env,SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_KILL:'0',SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(batch.approval(stage))};
  const readOnly=deadline.wrap((input,init={})=>{
   if(init.method&&init.method!=='GET'&&init.method!=='HEAD'||new URL(String(input)).hostname!==new URL(env.SUPABASE_URL).hostname)throw stopped('BATCH_PREFLIGHT_READ_ONLY');
   if(++reads>50)throw stopped('BATCH_PREFLIGHT_BUDGET');return fetchImpl(input,init);
  });
  const repository=createCoverageRepository({env:settings,fetchImpl:readOnly,now}),store=createControlledCoverageStore({env:settings,fetchImpl:readOnly,now});
  const prepared=await deadline.run(()=>batch.preflight({repository,store,now:Number(now()),id:env.GITHUB_RUN_ID,targetSize:roundJobs*5,stage,
   prepare:async({metadata,report:check})=>{
    if(metadata.scaling){scaling.validateState(metadata.scaling);const s=metadata.scaling;
     check.durableStage={id:s.id,stage:s.stage,phase:s.phase,completed:s.completedSymbols.length,remaining:s.stage-s.completedSymbols.length,evidenceKind:s.evidenceKind};}
    let priorCanary;
    if(stage===20){try{priorCanary=await store.inspect(canary.RUN_KEY);}catch(e){if(e.code!=='JOB_NOT_FOUND')throw e;}}
    const progress=scaling.progress(metadata,context,{requireReview:mode==='run',canary:priorCanary});
    const remaining=stage-progress.completedSymbols.length;
    check.stageProgress={id,stage,completed:progress.completedSymbols.length,remaining,continuationReviewRequired:progress.completedSymbols.length>0};
    const jobs=Math.min(roundJobs,remaining/5,check.quotaRemaining.jobs);
    if(jobs<1)throw stopped('SCALING_DAILY_CAPACITY');
    return {targetSize:jobs*5,excludeSymbols:progress.completedSymbols,scaling:context};
   }}));
  report.preflight=prepared.preflight;report.plan=prepared.plan;report.before=batch.counts(prepared.rows,Number(now()));
  if(mode==='preflight'){report.status='READY';return report;}
  const plan=prepared.plan;
  for(let index=0;index<plan.runKeys.length;index++){
   jobStarted=false;if(index){deadline.close();deadline=deadlineFactory();}
   const controller=createControlledCoverage({env:settings,fetchImpl:deadline.wrap(fetchImpl),now,batchPlan:plan,batchIndex:index,
    initialDatabaseReads:index===0?reads:0,retrySleep:deadline.sleep,onJobStarted:()=>{jobStarted=true;report.jobsStarted++;}});
   const result=await deadline.run(()=>controller.execute({tag:plan.runKeys[index].split(':')[3]}));
   if(result.alreadyRunning||result.alreadyCompleted||result.skipped||result.verified!==5||result.partial||result.temporaryFailed)throw stopped('SCALING_JOB_NOT_VERIFIED');
   const receipt={runKey:result.runKey,attempted:result.attempted,verified:result.verified,partial:result.partial,temporaryFailed:result.temporaryFailed,metrics:result.metrics};
   report.jobs.push(receipt);for(const k of ['attempted','verified','partial','temporaryFailed'])report[k]+=receipt[k];
   report.after=result.batchCounts.after;
  }
  const completed=report.preflight.stageProgress.completed+report.attempted;
  report.stageProgress={stage,id,completed,remaining:stage-completed,phase:completed===stage?'completed':'awaiting_approval'};
  report.status=completed===stage?'STAGE_PASS':'ROUND_PASS';report.afterStatus='PASS';report.countsScope='this-round';return report;
 }catch(error){
  report.status=jobStarted?'STOPPED':'BLOCKED';report.reasonCode=error.preflight?.reasonCode||(/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'SCALING_STATE_UNAVAILABLE');
  report.preflight=error.preflight||{...report.preflight,status:'BLOCKED',reasonCode:report.reasonCode};
  if(jobStarted){report.failedJob=report.jobs.length+1;report.incompleteJobCounts='UNKNOWN';report.countsScope='completed-jobs-only';}
  report.after=null;const failure=stopped('SCALING_STOPPED_REVIEW_DURABLE_STATE');failure.report=report;throw failure;
 }finally{deadline.close();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);onReport(report);}
}
if(require.main===module)main({evidenceKind:'production-manual',onReport:r=>console.log(JSON.stringify(r))}).catch(()=>{
 console.error('Scaling stopped. Keep durable evidence; Owner review is required before continuation.');process.exitCode=1;
});
module.exports={main};
