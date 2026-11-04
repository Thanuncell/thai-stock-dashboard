'use strict';
const {bangkokDay}=require('./automation-policy');
const {stopped}=require('./controlled-coverage-store');

// Reviewed exchange evidence, not a provider-error blacklist. A suspension is
// temporary: each execution day needs a fresh review, never a permanent skip.
const REVIEWED=Object.freeze([{symbol:'ACAP',provider_symbol:'ACAP.BK',reason:'EXCHANGE_SUSPENDED',reviewedOn:'2026-11-04',
 source:'https://www.set.or.th/en/market/product/stock/quote/acap/news',
 corroboration:'https://www.set.or.th/th/market/news-and-alert/newsdetails?id=100326101&symbol=ACAP'}]);
function exclusions(rows,now,review=''){
 const result=[];
 for(const evidence of REVIEWED){
  const row=rows.find(r=>r.symbol===evidence.symbol);if(!row||!row.active)continue;
  if(row.provider_symbol!==evidence.provider_symbol||row.provider!=='Yahoo Finance')throw stopped('BATCH_MAPPING_INVALID');
  const day=bangkokDay(now);
  if(day!==evidence.reviewedOn&&review!==`REVIEWED ${evidence.symbol} ${day}`)throw stopped('BATCH_LIFECYCLE_REVIEW_REQUIRED');
  result.push({...evidence,reviewedOn:day});
 }
 return result;
}
function risks(rows){return rows.filter(r=>!r.last_verified_at||r.status==='temporary_failed').map(r=>({symbol:r.symbol,
 reason:r.guard_reason==='SOURCE_NO_DATA'?'SOURCE_NO_DATA_REVIEW_REQUIRED':r.status==='temporary_failed'?'PREVIOUS_TEMPORARY_FAILURE':'NO_HISTORICAL_VERIFICATION'}));}
function assertSelected(rows){
 if(rows.some(r=>r.guard_reason==='SOURCE_NO_DATA'||r.failure_reason==='SOURCE_NO_DATA'))throw stopped('BATCH_ELIGIBILITY_REVIEW_REQUIRED');
}
module.exports={exclusions,risks,assertSelected};
