'use strict';
const {createHash}=require('node:crypto');
const {safeUrl,fail}=require('./reader.cjs');
const {analyze}=require('./analysis.cjs');
function input(payload){
  if(!payload||!['url','text'].includes(payload.mode)||typeof payload.value!=='string'||payload.value.length>20_000)throw fail('INVALID_INPUT');
  const value=payload.value.trim();
  if(payload.mode==='text'&&value.length<60)throw fail('INVALID_INPUT');
  if(payload.mode==='url'&&value.length>2048)throw fail('INVALID_URL');
  return{mode:payload.mode,value:payload.mode==='url'?safeUrl(value):value};
}
class Lane{
  constructor({now=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),capacity=3,rpm=15}={}){
    if(!Number.isInteger(rpm)||rpm<1||rpm>15||!Number.isInteger(capacity)||capacity<1||capacity>3)throw fail('INVALID_RATE_CONFIG');
    this.now=now;this.wait=wait;this.capacity=capacity;this.interval=Math.ceil(60_000/rpm)+1;this.pending=0;this.last=-Infinity;this.tail=Promise.resolve();
  }
  run(task,prepare=async()=>undefined){
    if(this.pending>=this.capacity)throw fail('BUSY');this.pending++;
    const job=this.tail.then(async()=>{const prepared=await prepare();const delay=Math.max(0,this.last+this.interval-this.now());if(delay)await this.wait(delay);this.last=this.now();return task(prepared);});
    this.tail=job.catch(()=>{});return job.finally(()=>{this.pending--;});
  }
}
function createService({authenticate,reader,provider,loadCatalog,lane=new Lane(),timeoutMs,onDiagnostic}){
  if(![authenticate,reader?.read,provider?.generate,loadCatalog].every(x=>typeof x==='function'))throw fail('DEPENDENCY_REQUIRED');
  // In-flight only: no completed cache, weekly quota, database or durable replay.
  const active=new Map(),keys=new Map();
  return async(request,payload)=>{
    const identity=await authenticate(request);
    if(typeof identity?.id!=='string'||!identity.id.trim()||identity.id!==identity.id.trim()||identity.id.length>128)throw fail('UNAUTHORIZED');
    const value=input(payload),key=payload.requestKey??payload.idempotencyKey;
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(key))throw fail('INVALID_KEY');
    const hash=createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const owner=JSON.stringify([identity.id,hash]),requestId=JSON.stringify([identity.id,key]);
    if(keys.has(requestId)&&keys.get(requestId)!==hash)throw fail('REQUEST_CONFLICT');
    if(active.has(owner)){keys.set(requestId,hash);return active.get(owner).finally(()=>keys.delete(requestId));}
    keys.set(requestId,hash);
    let job;
    try{job=lane.run(async prepared=>{
      return{kind:'SUCCESS',result:await analyze(provider,prepared.article,{timeoutMs,catalog:prepared.catalog,onDiagnostic}),phase:'phase1'};
    },async()=>{const catalog=await loadCatalog();const article=value.mode==='url'?(await reader.read(value.value)).text:value.value;try{onDiagnostic?.({stage:'input',mode:value.mode,articleChars:article.length,articleSha256:createHash('sha256').update(article).digest('hex'),catalogCount:catalog.items.length});}catch{}return{catalog,article};});}catch(error){keys.delete(requestId);throw error;}
    const settled=job.finally(()=>{active.delete(owner);keys.delete(requestId);});active.set(owner,settled);return settled;
  };
}
module.exports={input,Lane,createService};
