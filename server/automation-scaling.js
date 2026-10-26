'use strict';

const STAGES=Object.freeze([5,20,100,500]);
const JOB_SIZE=5;
const JOB_BUDGET=Object.freeze({providerRequests:10,databaseRequests:200,durationMs:120000});

function readScalePolicy(env={}) {
  const fallback={stage:5,maxJobsPerDay:2,providerDailyLimit:20,databaseDailyLimit:400};
  if (!env.SETSCOPE_V156_SCALE_APPROVAL) return fallback;
  let approval;
  try {approval=JSON.parse(env.SETSCOPE_V156_SCALE_APPROVAL);} catch {throw Error('INVALID_SCALE_APPROVAL');}
  if (!approval || approval.ownerApproved!==true || !STAGES.includes(approval.stage)
    || Object.keys(approval).some(key=>!['ownerApproved','stage','approvedStages','maxJobsPerDay','providerDailyLimit','databaseDailyLimit'].includes(key))
    || JSON.stringify(approval.approvedStages)!==JSON.stringify(STAGES.slice(0,STAGES.indexOf(approval.stage)+1))) throw Error('SCALE_APPROVAL_REQUIRED');
  const jobs=Math.ceil(approval.stage/JOB_SIZE);
  if (!Number.isSafeInteger(approval.maxJobsPerDay) || approval.maxJobsPerDay<jobs || approval.maxJobsPerDay>Math.max(2,jobs)
    || !Number.isSafeInteger(approval.providerDailyLimit) || approval.providerDailyLimit<approval.maxJobsPerDay*JOB_BUDGET.providerRequests
    || approval.providerDailyLimit>Math.max(2,jobs)*JOB_BUDGET.providerRequests
    || !Number.isSafeInteger(approval.databaseDailyLimit) || approval.databaseDailyLimit<approval.maxJobsPerDay*JOB_BUDGET.databaseRequests
    || approval.databaseDailyLimit>Math.max(2,jobs)*JOB_BUDGET.databaseRequests) throw Error('SCALE_BUDGET_INVALID');
  return {stage:approval.stage,maxJobsPerDay:approval.maxJobsPerDay,
    providerDailyLimit:approval.providerDailyLimit,databaseDailyLimit:approval.databaseDailyLimit};
}
function planBatchScale(targetSize=5, policy=readScalePolicy()) {
  if (!STAGES.includes(targetSize)) throw Error('INVALID_SCALE_STAGE');
  const jobs=Math.ceil(targetSize/JOB_SIZE);
  return {targetSize,jobSize:JOB_SIZE,jobs,stages:STAGES.slice(0,STAGES.indexOf(targetSize)+1),
    ownerApprovalRequired:targetSize>policy.stage,automaticExpansion:false,
    budgets:{providerRequests:jobs*JOB_BUDGET.providerRequests,databaseRequests:jobs*JOB_BUDGET.databaseRequests,
      maximumSequentialDurationMs:jobs*JOB_BUDGET.durationMs},schedulerEnabled:false};
}
module.exports={STAGES,JOB_SIZE,JOB_BUDGET,readScalePolicy,planBatchScale};
