'use strict';

const STAGES=Object.freeze([5,20,100,500]);
const JOB_SIZE=5;
const JOB_BUDGET=Object.freeze({providerRequests:10,databaseRequests:200,durationMs:120000});
const DAILY_BUDGET=Object.freeze({maxJobsPerDay:4,providerDailyLimit:40,databaseDailyLimit:800});

function readScalePolicy(env={}) {
  const fallback={stage:5,maxJobsPerDay:2,providerDailyLimit:20,databaseDailyLimit:400};
  if (!env.SETSCOPE_V156_SCALE_APPROVAL) return fallback;
  let approval;
  try {approval=JSON.parse(env.SETSCOPE_V156_SCALE_APPROVAL);} catch {throw Error('INVALID_SCALE_APPROVAL');}
  if (!approval || approval.ownerApproved!==true || !STAGES.includes(approval.stage)
    || Object.keys(approval).some(key=>!['ownerApproved','stage','approvedStages','maxJobsPerDay','providerDailyLimit','databaseDailyLimit'].includes(key))
    || JSON.stringify(approval.approvedStages)!==JSON.stringify(STAGES.slice(0,STAGES.indexOf(approval.stage)+1))) throw Error('SCALE_APPROVAL_REQUIRED');
  if (!Number.isSafeInteger(approval.maxJobsPerDay) || approval.maxJobsPerDay<1 || approval.maxJobsPerDay>DAILY_BUDGET.maxJobsPerDay
    || !Number.isSafeInteger(approval.providerDailyLimit) || approval.providerDailyLimit<approval.maxJobsPerDay*JOB_BUDGET.providerRequests
    || approval.providerDailyLimit>DAILY_BUDGET.providerDailyLimit
    || !Number.isSafeInteger(approval.databaseDailyLimit) || approval.databaseDailyLimit<approval.maxJobsPerDay*JOB_BUDGET.databaseRequests
    || approval.databaseDailyLimit>DAILY_BUDGET.databaseDailyLimit) throw Error('SCALE_BUDGET_INVALID');
  return {stage:approval.stage,maxJobsPerDay:approval.maxJobsPerDay,
    providerDailyLimit:approval.providerDailyLimit,databaseDailyLimit:approval.databaseDailyLimit};
}
function planBatchScale(targetSize=5, policy=readScalePolicy()) {
  if (!STAGES.includes(targetSize)) throw Error('INVALID_SCALE_STAGE');
  const jobs=Math.ceil(targetSize/JOB_SIZE);
  return {targetSize,jobSize:JOB_SIZE,jobs,stages:STAGES.slice(0,STAGES.indexOf(targetSize)+1),
    ownerApprovalRequired:targetSize>policy.stage,automaticExpansion:false,
    budgetsScope:'whole-stage-across-days',dailyBudgets:{maxJobsPerDay:policy.maxJobsPerDay,providerDailyLimit:policy.providerDailyLimit,databaseDailyLimit:policy.databaseDailyLimit},
    budgets:{providerRequests:jobs*JOB_BUDGET.providerRequests,databaseRequests:jobs*JOB_BUDGET.databaseRequests,
      maximumSequentialDurationMs:jobs*JOB_BUDGET.durationMs},schedulerEnabled:false};
}
module.exports={STAGES,JOB_SIZE,JOB_BUDGET,DAILY_BUDGET,readScalePolicy,planBatchScale};
