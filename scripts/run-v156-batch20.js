'use strict';
const {createControlledCoverage}=require('../server/controlled-coverage');
const {createControlledCoverageStore,stopped}=require('../server/controlled-coverage-store');
const {createCoverageRepository}=require('../server/coverage-service');
const {createRequestDeadline}=require('../server/request-deadline');
const policy=require('../server/manual-batch-policy');
function authorize(env,mode){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_REPOSITORY!=='Thanuncell/thai-stock-dashboard'
  ||env.GITHUB_REPOSITORY_OWNER!=='Thanuncell'||env.GITHUB_ACTOR!==env.GITHUB_REPOSITORY_OWNER
  ||env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d{1,15}$/.test(env.GITHUB_RUN_ID||'')
  ||!['preflight','run'].includes(mode)||mode==='run'&&env.SETSCOPE_BATCH_CONFIRMATION!=='RUN COVERAGE 20'
  ||!env.SUPABASE_SECRET_KEY||!/^https:\/\/[a-z0-9.-]+\.supabase\.co$/.test(env.SUPABASE_URL||''))throw stopped('BATCH_NOT_AUTHORIZED');
}
async function main({env=process.env,fetchImpl=globalThis.fetch,now=Date.now,mode=env.SETSCOPE_BATCH_MODE||'preflight',deadlineFactory=createRequestDeadline,onReport=()=>{}}={}){
 authorize(env,mode);
 // Only this short-lived Actions process gets these settings. Render is never contacted.
 const settings={...env,SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_KILL:'0',SETSCOPE_V156_SCALE_APPROVAL:JSON.stringify(policy.APPROVAL)};
 let deadline=deadlineFactory(),preflightReads=0,report={status:'STOPPED',countsScope:'completed-jobs-only',attempted:0,verified:0,partial:0,temporaryFailed:0,jobs:[],before:null,after:null,afterStatus:'NOT_RUN'};
 const cancel=()=>deadline.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
 try{
  const readOnly=deadline.wrap((input,init={})=>{
   if(init.method&&init.method!=='GET'&&init.method!=='HEAD'||new URL(String(input)).hostname!==new URL(env.SUPABASE_URL).hostname)throw stopped('BATCH_PREFLIGHT_READ_ONLY');
   if(++preflightReads>50)throw stopped('BATCH_PREFLIGHT_BUDGET');return fetchImpl(input,init);
  });
  const repository=createCoverageRepository({env:settings,fetchImpl:readOnly,now});
  const store=createControlledCoverageStore({env:settings,fetchImpl:readOnly,now});
  const prepared=await deadline.run(()=>policy.preflight({repository,store,now:Number(now()),id:env.GITHUB_RUN_ID}));
  const plan=prepared.plan;
  report={...report,plan,before:policy.counts(prepared.rows,Number(now())),preflightReads};
  if(mode==='preflight'){report.status='READY';return report;}
  for(let index=0;index<4;index++){
   if(index){deadline.close();deadline=deadlineFactory();}
   const started=Number(now());
   const controller=createControlledCoverage({env:settings,fetchImpl:deadline.wrap(fetchImpl),now,batchPlan:plan,batchIndex:index,
    initialDatabaseReads:index===0?preflightReads:0,retrySleep:deadline.sleep});
   const result=await deadline.run(()=>controller.execute({tag:plan.runKeys[index].split(':')[3]}));
   if(result.alreadyCompleted||result.alreadyRunning||result.skipped||result.attempted!==5||result.temporaryFailed)throw stopped('BATCH_JOB_NOT_SUCCESSFUL');
   const job={runKey:result.runKey,attempted:result.attempted,verified:result.verified,partial:result.partial,temporaryFailed:result.temporaryFailed,
    metrics:result.metrics,elapsedMs:Math.max(0,Number(now())-started)};
   report.jobs.push(job);for(const k of ['attempted','verified','partial','temporaryFailed'])report[k]+=job[k];
   report.after=result.batchCounts.after;
  }
  report.status='PASS';report.countsScope='all-four-jobs';report.afterStatus='PASS';return report;
 }catch(error){
  // Completed jobs are known; an interrupted job must never be reported as zero attempts.
  report.failedJob=report.jobs.length+1;report.incompleteJobCounts='UNKNOWN';report.after=null;
  const failure=stopped('BATCH_STOPPED_REVIEW_DURABLE_STATE');failure.report=report;throw failure;
 }finally{deadline.close();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);onReport(report);}
}
if(require.main===module)main({onReport:report=>console.log(JSON.stringify(report))}).catch(()=>{
 console.error('Batch stopped. Preserve checkpoints; review before any new Owner-approved run.');process.exitCode=1;
});
module.exports={main,authorize};
