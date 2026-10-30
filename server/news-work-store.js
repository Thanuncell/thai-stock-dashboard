'use strict';
const {createHash}=require('node:crypto');
const {retryAfterMs}=require('./news-source-reliability');
function workKey(scope,key){return createHash('sha256').update(JSON.stringify([scope,key])).digest('hex');}
function createNewsWorkStore({env=process.env,fetchImpl=globalThis.fetch}={}){
 const enabled=env.SETSCOPE_NEWS_WORK_QUEUE==='on',base=env.SUPABASE_URL?.replace(/\/$/,''),key=env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY;
 async function rpc(name,body,signal){
  if(!enabled)throw Error('NEWS_WORK_DISABLED');
  if(!base||!key)throw Error('NEWS_WORK_NOT_CONFIGURED');
  const r=await fetchImpl(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});
  if(!r.ok){const e=Error('NEWS_WORK_HTTP_'+r.status);e.status=r.status;e.retryAfterMs=retryAfterMs(r.headers.get('retry-after'));throw e;}return r.json();
 }
 return {enabled,
  async inspect({scope='general'}={}){
   if(!enabled)return {enabled:false,depth:null,oldestAgeMs:null};
   if(!base||!key)throw Error('NEWS_WORK_NOT_CONFIGURED');
   if(typeof scope!=='string'||scope.length<1||scope.length>100)throw Error('NEWS_WORK_SCOPE');
   const response=await fetchImpl(base+'/rest/v1/news_work?select=created_at&scope=eq.'+encodeURIComponent(scope)+'&state=in.(pending,retry,processing)&order=created_at.asc&limit=1',
    {headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:'Bearer '+key}),Prefer:'count=exact'},signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error('NEWS_WORK_INSPECTION_UNAVAILABLE');
   const rows=await response.json(),count=response.headers.get('content-range')?.split('/')[1];
   return {enabled:true,depth:/^\d+$/.test(count||'')?Number(count):null,oldestAgeMs:Number.isFinite(Date.parse(rows?.[0]?.created_at))?Math.max(0,Date.now()-Date.parse(rows[0].created_at)):null};
  },
  async enqueue({scope,key,stage='discovery',payload,signal}){
   const expected=workKey(scope,key),rows=await rpc('enqueue_news_work',{p_key:expected,p_scope:scope,p_stage:stage,p_payload:payload},signal);
   if(!Array.isArray(rows)||rows.length!==1||rows[0].work_key!==expected||rows[0].scope!==scope)throw Error('NEWS_WORK_INVALID_ACK');return rows;
  },
  async claim({scope,limit=1,leaseSeconds=60,signal}){
   const rows=await rpc('claim_news_work',{p_scope:scope,p_limit:limit,p_lease_seconds:leaseSeconds},signal);
   if(!Array.isArray(rows)||rows.length>limit||rows.some(j=>j.scope!==scope||j.state!=='processing'||!['discovery','extraction','persistence'].includes(j.stage)||!j.lease_token||!Number.isFinite(Date.parse(j.lease_until))))throw Error('NEWS_WORK_INVALID_CLAIM');return rows;
  },
  async finish(job,action,{stage=null,checkpoint=null,error=null,delay=1}={}){
   const ack=await rpc('finish_news_work',{p_id:job.id,p_token:job.lease_token,p_scope:job.scope,p_action:action,p_stage:stage,p_checkpoint:checkpoint,p_error:error,p_delay:delay});
   if(typeof ack!=='boolean')throw Error('NEWS_WORK_INVALID_ACK');return ack;
  }
 };
}
module.exports={createNewsWorkStore,workKey};
