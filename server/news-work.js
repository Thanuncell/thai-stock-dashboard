'use strict';
const {createHash}=require('node:crypto');
const {validStoredEvidence}=require('../lib/news-evidence');
const {trustedDiscovery,restoreDiscovery}=require('../lib/news-discovery');
const {allowedNewsUrl}=require('../lib/news-policy');
const {abortable}=require('./watchlist-news');
function failure(error){
 if(error?.terminal||[400,401,403,404,410,422].includes(error?.status))return {terminal:true,code:error?.status?'HTTP_'+error.status:'INVALID_ITEM'};
 return {terminal:false,code:error?.status?'HTTP_'+error.status:error?.name==='TimeoutError'?'TIMEOUT':'TRANSIENT_FAILURE'};
}
function createNewsWorker({store,discover,extract,persist,timeoutMs=20000,random=Math.random,onEvent=()=>{}}){
 const health={completed:0,retry:0,terminal:0,unacknowledged:0,maxAgeMs:0};
 const note=(stage,outcome)=>{if(outcome in health)health[outcome]++;try{onEvent({operation:stage,status:outcome==='completed'?200:0});}catch{}};
 // Explicit calls only: no interval, scheduler or detached/background work.
 async function runOnce({scope='general',limit=1,signal}={}){
  if(!store.enabled)return {enabled:false,processed:0};
  if(!Number.isInteger(limit)||limit<1||limit>4)throw Error('NEWS_WORK_BUDGET');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>20000)throw Error('NEWS_WORK_TIMEOUT_BUDGET');
  const outcomes=[];
  for(let n=0;n<limit;n++){
   if(signal?.aborted)break;
   const jobs=await store.claim({scope,limit:1,leaseSeconds:Math.max(30,Math.ceil(timeoutMs/1000)+15),signal});
   if(!jobs.length)break;
   const job=jobs[0];
   if(Number.isFinite(Date.parse(job.created_at)))health.maxAgeMs=Math.max(health.maxAgeMs,Date.now()-Date.parse(job.created_at));
   if(signal?.aborted)break; // Claimed but unstarted work is reclaimed after its lease.
   const controller=new AbortController(),relay=()=>controller.abort();
   signal?.addEventListener('abort',relay,{once:true});
   let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Object.assign(Error('NEWS_WORK_TIMEOUT'),{name:'TimeoutError'}));},timeoutMs);});
   try{
    const handler=job.stage==='discovery'?discover:job.stage==='extraction'?extract:persist;
    if(typeof handler!=='function')throw Object.assign(Error('NEWS_WORK_HANDLER_MISSING'),{terminal:true});
    const result=await Promise.race([abortable(Promise.resolve().then(()=>handler(job.checkpoint??job.payload,{signal:controller.signal,job})),controller.signal),deadline]);
    if(controller.signal.aborted)throw Error('NEWS_WORK_ABORTED');
    const advance=job.stage!=='persistence',next=job.stage==='discovery'?'extraction':'persistence';
    if(result===undefined||result===null)throw Object.assign(Error('NEWS_WORK_EMPTY_CHECKPOINT'),{terminal:true});
    if(advance&&Buffer.byteLength(JSON.stringify(result))>60000)throw Object.assign(Error('NEWS_WORK_CHECKPOINT_SIZE'),{terminal:true});
    const acknowledged=await store.finish(job,advance?'advance':'completed',{stage:advance?next:null,checkpoint:advance?result:null});
    outcomes.push({id:job.id,outcome:acknowledged?(advance?'checkpoint':'completed'):'lease-lost'});
    if(acknowledged&&!advance)note(job.stage,'completed');
   }catch(error){
    const f=failure(error),retryAfter=Number(error?.retryAfterMs)||0;
    // The existing RPC caps delay at one hour. Longer denials stay inspectable for manual recovery.
    if(retryAfter>3600000){f.terminal=true;f.code='MANUAL_REVIEW_RETRY_AFTER';}
    const delay=Math.min(3600,Math.max(Math.ceil(retryAfter/1000),Math.ceil(2**Math.min(10,job.attempts)*5*(0.75+Math.max(0,Math.min(1,random()))*0.5))));
    try{
     const acknowledged=await store.finish(job,f.terminal?'terminal':'retry',{error:job.stage.toUpperCase()+'_'+f.code,delay});
     outcomes.push({id:job.id,outcome:acknowledged?(f.terminal?'terminal':'retry'):'lease-lost'});
     if(acknowledged)note(job.stage,f.terminal?'terminal':'retry');
    }catch{note(job.stage,'unacknowledged');outcomes.push({id:job.id,outcome:'acknowledgement-unavailable'});break;}
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',relay);}
  }
  return {enabled:true,processed:outcomes.length,outcomes};
 }
 return {runOnce,health:()=>({...health})};
}
function createDurableNewsIngest({archive,store,review}){
 const worker=createNewsWorker({store,
 discover:async payload=>{
  if(!allowedNewsUrl(payload.url)||!Number.isFinite(Date.parse(payload.pubDate))||!payload.title||!payload.sourceName)throw Object.assign(Error('INVALID_DISCOVERY_CHECKPOINT'),{terminal:true});
  const item={...payload};delete item.verification;item.discovery=restoreDiscovery(item,payload.discovery);
  if(!item.discovery)throw Object.assign(Error('INVALID_DISCOVERY_PROVENANCE'),{terminal:true});
  return item;
 },
 extract:async(payload,{signal})=>{
  if(typeof review!=='function')throw Object.assign(Error('NEWS_REVIEW_UNAVAILABLE'),{terminal:true});
  const item={...payload};item.discovery=restoreDiscovery(item,payload.discovery);
  const result=await review(item,{signal,budget:{remaining:1,httpRemaining:6}});
  const rows=archive.prepare(result.items,{assessments:result.assessments});
  if(rows.length!==1)throw Error('EXTRACTION_UNVERIFIED');
  return rows[0];
 },persist:async row=>{
  if(!validStoredEvidence({...row,verification_revision:1}))throw Object.assign(Error('INVALID_QUEUED_EVIDENCE'),{terminal:true});
  const item=archive.restorePrepared(row);
  const result=await archive.ingest(item.verification.status==='VERIFIED'?[item]:[],{assessments:item.verification.status==='VERIFIED'?[]:[{item,verification:item.verification}]});
  if(result.conflicts||result.persistence==='read-only'||!result.configured||!(result.ingested||result.retained))throw Error('ARCHIVE_NOT_ACKNOWLEDGED');
  return {acknowledged:true};
 }});
 return {
  async captureDiscovered(items){
   if(!store.enabled)return {queued:0};
   if(archive.canQueue===false)throw Error('NEWS_WORK_REQUIRES_G1_WRITE');
   if(!Array.isArray(items)||items.length>1)throw Error('NEWS_WORK_DISCOVERY_BUDGET');
   for(const item of items){
    const discovery=trustedDiscovery(item);if(!discovery)throw Error('UNTRUSTED_NEWS_DISCOVERY');
    const payload={title:item.title,url:item.url,source:item.source,sourceName:item.sourceName,snippet:item.snippet||'',pubDate:item.pubDate,discovery};
    const key=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await store.enqueue({scope:'general',key,stage:'discovery',payload,signal:AbortSignal.timeout(12000)});
   }
   return {queued:items.length};
  },
  async ingest(items,options={}){
   if(!store.enabled)return archive.ingest(items,options);
   if(archive.canQueue===false)throw Error('NEWS_WORK_REQUIRES_G1_WRITE');
   if(!Array.isArray(items)||items.length>200)throw Error('NEWS_WORK_ADMISSION_BUDGET');
   const rows=archive.prepare(items,options);
   const admissionSignal=AbortSignal.timeout(15000);
   for(const row of rows){
    if(admissionSignal.aborted)throw Error('NEWS_WORK_ADMISSION_TIMEOUT');
    row.fetched_at=row.verification_checked_at;
    if(!validStoredEvidence({...row,verification_revision:1}))throw Error('NEWS_WORK_REQUIRES_G1_WRITE');
    const key=createHash('sha256').update(JSON.stringify(row)).digest('hex');
    await store.enqueue({scope:'general',key,stage:'persistence',payload:row,signal:admissionSignal});
   }
   return {queued:rows.length,...await worker.runOnce({scope:'general',limit:2})};
  },runOnce:worker.runOnce,health:worker.health,inspect:store.inspect
 };
}
module.exports={createNewsWorker,createDurableNewsIngest,failure};
