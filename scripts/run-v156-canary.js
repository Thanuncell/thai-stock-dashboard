'use strict';
const { createControlledCoverage } = require('../server/controlled-coverage');
const { createRequestDeadline } = require('../server/request-deadline');
async function main({env=process.env,fetchImpl=globalThis.fetch,deadline=createRequestDeadline(),now=Date.now}={}) {
  try {
    if (env.GITHUB_ACTIONS!=='true' || env.GITHUB_REF!=='refs/heads/main' || env.SETSCOPE_CANARY_APPROVED!=='1'
      || !env.SUPABASE_SECRET_KEY || !/^https:\/\/[a-z0-9.-]+\.supabase\.co$/.test(env.SUPABASE_URL||'')) throw Error('CANARY_NOT_APPROVED_OR_CONFIGURED');
    // These flags belong only to this short-lived runner. Render is never contacted.
    const settings={...env,SETSCOPE_V156_MANUAL_VERIFY:'1',SETSCOPE_V156_KILL:'0'};
    const control=createControlledCoverage({env:settings,fetchImpl:deadline.wrap(fetchImpl),now,canary:true,retrySleep:deadline.sleep});
    const result=await deadline.run(()=>control.execute());
    if (result.alreadyCompleted || result.alreadyRunning || result.skipped) throw Error('CANARY_NOT_EXECUTED');
    return result;
  } finally {deadline.close();}
}
if(require.main===module){
  const deadline=createRequestDeadline();
  const cancel=()=>deadline.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  main({deadline}).then(result=>{
    // Fixed aggregate fields only; never serialize exceptions, requests or environment.
    console.log(JSON.stringify({alreadyCompleted:Boolean(result.alreadyCompleted),attempted:result.attempted,
      verified:result.verified,temporaryFailed:result.temporaryFailed,metrics:result.metrics,counts:result.canaryCounts}));
    if(!result.alreadyCompleted&&(result.verified!==5||result.temporaryFailed))process.exitCode=1;
  }).catch(()=>{console.error('Canary stopped. Preserve durable state and review before any retry.');process.exitCode=1;})
    .finally(()=>{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);});
}
module.exports={main};
