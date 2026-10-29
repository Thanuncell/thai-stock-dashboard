'use strict';
const {createHash}=require('node:crypto');
const {retryWithBackoff,isTransientProviderError}=require('./reliability');
const {allowedNewsUrl,NEWS_PUBLISHERS}=require('../lib/news-policy');
const {readBoundedText}=require('../lib/news-response');
const {abortable}=require('./watchlist-news');
function retryAfterMs(value,now=Date.now()){
 const raw=String(value||'').trim();if(!raw)return 0;
 const delay=/^\d+$/.test(raw)?Number(raw)*1000:Date.parse(raw)-now;
 return Number.isFinite(delay)?Math.max(0,delay):0;
}
function sourceKey(value){
 const u=allowedNewsUrl(value);if(!u)return null;
 return u.hostname==='news.google.com'?'google':NEWS_PUBLISHERS.find(p=>u.hostname===p.host||u.hostname.endsWith('.'+p.host))?.host||null;
}
function createNewsSourceReliability({now=Date.now,random=Math.random,onEvent=()=>{},pausedSources=[],maxRequests=60,windowMs=60000,maxActive=4,maxPending=16,timeoutMs=9000,
 sleep=(ms,signal)=>require('node:timers/promises').setTimeout(ms,undefined,{signal})}={}){
 const configuredPauses=new Set(pausedSources);
 const isConfiguredPause=(key,stage)=>configuredPauses.has(key)||configuredPauses.has(key+':'+stage);
 const states=new Map(),budgets=new Map(),pending=new Map();let active=0;
 function state(key,stage='extraction'){const id=key+'|'+stage;if(!states.has(id))states.set(id,{source:key,stage,paused:isConfiguredPause(key,stage),until:0,rateUntil:0,failures:0,active:0,requests:0,retries:0,errors:0,coalesced:0,outcomes:{},quality:{accepted:0,rejected:0,ambiguous:0},stages:{}});return states.get(id);}
 function budgetFor(key){if(!budgets.has(key))budgets.set(key,{used:0,window:now(),active:0});return budgets.get(key);}
 const error=(message,status=0)=>Object.assign(Error(message),{status,providerCooldown:true});
 function emit(key,stage,status,start){try{onEvent({provider:key,operation:stage,status,durationMs:Math.max(0,now()-start)});}catch{/* Monitoring cannot fail acquisition. */}}
 function stageName(value){return ['rss','discovery','extraction'].includes(value)?value:'extraction';}
 function wrap(transport,defaultStage='extraction'){
  if(transport.newsReliability===api)return transport;
  async function request(value,init={}){
   const key=sourceKey(value);if(!key)throw error('NEWS_UNSAFE_URL');
   const stage=stageName(init.newsStage||defaultStage),s=state(key,stage),budget=budgetFor(key),maxBytes=init.maxBytes||256000;
   if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>1500000)throw error('NEWS_RESPONSE_BUDGET');
   if(init.signal?.aborted)throw error('NEWS_REQUEST_ABORTED');
   if(s.paused)throw error('NEWS_SOURCE_DENIED',403);
   if(now()<s.until)throw error('NEWS_SOURCE_COOLDOWN',429);
   const id=createHash('sha256').update(JSON.stringify([String(value),init.method||'GET',init.headers||{},init.body||'',maxBytes,stage,init.newsAttempts||2])).digest('hex');
   let entry=pending.get(id);
   if(entry&&(entry.waiters>=maxPending||entry.controller.signal.aborted))throw error('NEWS_SOURCE_BACKPRESSURE');
   if(!entry){
    if(pending.size>=maxPending||active>=maxActive||budget.active>=3||s.failures&&s.active)throw error('NEWS_SOURCE_BACKPRESSURE');
    const controller=new AbortController();entry={controller,waiters:0,source:key,stage};
    pending.set(id,entry);s.active++;budget.active++;active++;
    const started=now(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    entry.task=(async()=>{
     try{
      const result=await retryWithBackoff(async attempt=>{
       if(controller.signal.aborted)throw error('NEWS_REQUEST_ABORTED');
       if(s.paused||now()<s.until)throw error('NEWS_SOURCE_COOLDOWN');
       if(now()-budget.window>=windowMs){budget.window=now();budget.used=0;}
       if(budget.used>=maxRequests)throw error('NEWS_REQUEST_BUDGET');
       // The loader/adapters already charge their first request. Retries share that same budget.
       if(attempt>1&&init.newsBudget){if(init.newsBudget.httpRemaining<=0)throw error('NEWS_REQUEST_BUDGET');init.newsBudget.httpRemaining--;}
       budget.used++;s.requests++;if(attempt>1)s.retries++;
       const counts=s.stages[stage]||={requests:0,errors:0};counts.requests++;
       const {newsStage,newsBudget,newsAttempts,signal,...options}=init;
       let response;
       try{
        const raw=Promise.resolve().then(()=>transport(value,{...options,signal:controller.signal}));
        raw.then(r=>{if(controller.signal.aborted)r.body?.cancel().catch(()=>{});},()=>{});
        response=await abortable(raw,controller.signal);
       }catch(e){s.errors++;counts.errors++;if(e.accessDenied||[401,403].includes(e.status))s.paused=true;
        if(e.status===429){s.rateUntil=Math.max(s.rateUntil,now()+Math.max(30000,Number(e.retryAfterMs)||0));s.until=Math.max(s.until,s.rateUntil);}throw e;}
       emit(key,stage,response.status,started);
       if([403,404,410,429].includes(response.status))s.outcomes[response.status]=(s.outcomes[response.status]||0)+1;
       if([401,403].includes(response.status))s.paused=true;
       if(response.status===429){s.rateUntil=Math.max(s.rateUntil,now()+Math.max(30000,retryAfterMs(response.headers.get('retry-after'),now())));s.until=Math.max(s.until,s.rateUntil);}
       if(response.status>=500){s.errors++;counts.errors++;
        const after=retryAfterMs(response.headers.get('retry-after'),now());if(after)s.until=Math.max(s.until,now()+after);
        response.body?.cancel().catch(()=>{});const e=error('NEWS_SOURCE_HTTP_'+response.status,response.status);e.retryable=[500,502,503,504].includes(response.status);e.response=response;throw e;}
       const text=await abortable(readBoundedText(response,maxBytes,controller.signal),controller.signal);
       const challengeTitle=/<title>\s*(?:access denied|just a moment|captcha)\b/i.test(text);
       const challengeWidget=/<(?:form|div)\b[^>]*(?:g-recaptcha|cf-chl-|captcha-challenge)/i.test(text)
        && !/<article\b|["@]type["\s:]+\s*["']?(?:NewsArticle|Article)/i.test(text);
       if(challengeTitle||challengeWidget){s.paused=true;throw error('NEWS_SOURCE_DENIED',403);}
       return {status:response.status,headers:[...response.headers],text,url:response.url};
      },{maxAttempts:stage==='rss'||init.newsAttempts===1?1:2,baseDelayMs:100,
       shouldRetry:e=>!controller.signal.aborted&&!s.paused&&now()>=s.until&&![400,401,403,404,410,422,429].includes(e.status)&&!e.stopBatch&&!e.skipAttempt&&!e.accessDenied&&(e.retryable||e.name==='TimeoutError'||isTransientProviderError(e)),
       sleep:ms=>sleep(Math.round(ms*(0.75+Math.max(0,Math.min(1,random()))*0.5)),controller.signal)});
      if(result.status!==429){s.failures=0;s.until=0;}
      return result;
     }catch(e){
      if((!controller.signal.aborted||entry.waiters>0)&&![400,404,410,422,501,505].includes(e.status)&&e.message!=='NEWS_REQUEST_BUDGET'&&e.message!=='NEWS_SOURCE_COOLDOWN'){
       s.failures=Math.min(6,s.failures+1);s.until=Math.max(s.until,now()+Math.min(900000,30000*2**(s.failures-1)));
      }
      if(e.response){const r=e.response;return {status:r.status,headers:[...r.headers],text:'',url:r.url};}
      throw e;
     }finally{clearTimeout(timer);pending.delete(id);s.active--;budget.active--;active--;}
    })();
    entry.task.catch(()=>{});
   }else s.coalesced++;
   entry.waiters++;
   try{
    const record=await abortable(entry.task,init.signal);
    const response=new Response([204,205,304].includes(record.status)?null:record.text,{status:record.status,headers:record.headers});
    if(record.url)Object.defineProperty(response,'url',{value:record.url});
    return response;
   }finally{entry.waiters--;if(!entry.waiters&&pending.get(id)===entry)entry.controller.abort();}
  }
  Object.assign(request,{newsReliability:api,pause:(value,stage=defaultStage)=>api.pause(value,stage),resume:(value,stage=defaultStage)=>api.resume(value,stage)});
  return request;
 }
 const api={wrap,recordQuality(value,status){const key=sourceKey(value);if(key){const label={VERIFIED:'accepted',REJECTED:'rejected',UNVERIFIED:'ambiguous'}[status];if(label)state(key).quality[label]++;}},pause(value,stage){const key=sourceKey(value);if(key){for(const part of stage?[stageName(stage)]:['rss','discovery','extraction'])state(key,part).paused=true;for(const entry of pending.values())if(entry.source===key&&(!stage||entry.stage===stage))entry.controller.abort();}},
  resume(value,stage){const key=sourceKey(value);if(key)for(const part of stage?[stageName(stage)]:['rss','discovery','extraction']){const s=state(key,part);s.paused=isConfiguredPause(key,part);s.until=s.rateUntil;s.failures=0;}},
  snapshot(){return {active,pending:pending.size,sources:[...states.values()].map(s=>({source:s.source,stage:s.stage,paused:s.paused,cooldownMs:Math.max(0,s.until-now()),requests:s.requests,retries:s.retries,errors:s.errors,coalesced:s.coalesced,used:budgetFor(s.source).used,outcomes:{...s.outcomes},quality:{...s.quality},stages:structuredClone(s.stages)}))};}};
 return api;
}
module.exports={createNewsSourceReliability,retryAfterMs,sourceKey};
