'use strict';
// Explicit isolated benchmark child. No Production URL or credentials are accepted.
const assert=require('node:assert/strict'),{createNewsArchiveService}=require('../../server/news-archive-service');
(async()=>{
 const base=new URL(process.env.SETSCOPE_WS7_HTTP_BASE);assert.equal(base.hostname,'127.0.0.1');assert.equal(base.protocol,'http:');
 const mode=process.env.SETSCOPE_WS7_BENCH_MODE,size=Number(process.env.SETSCOPE_WS7_BENCH_SIZE);assert.ok([40000,50000].includes(size));
 const samples=[],requests=[],payload=[],outcomes=[];let currentRequests=0,currentBytes=0;
 const transport=async(input,init={})=>{const u=new URL(input);assert.equal(u.origin,'https://benchmark.invalid');const r=await fetch(base.origin+u.pathname.slice('/rest/v1'.length)+u.search,{...init,headers:{...init.headers,Connection:'close'}}),body=await r.text();currentRequests++;currentBytes+=Buffer.byteLength(body);return new Response(body,{status:r.status,headers:r.headers});};
 const env={SUPABASE_URL:'https://benchmark.invalid',SUPABASE_SECRET_KEY:process.env.SETSCOPE_WS7_HTTP_TOKEN,SETSCOPE_NEWS_EVIDENCE:'read',SETSCOPE_NEWS_ARCHIVE_QUERY:mode==='database'?'on':'off',SETSCOPE_NEWS_WORK_QUEUE:'off'};
 const workloads=[{page:1,featuredCount:5},{page:Math.floor(size/10),featuredCount:5},{page:2,source:'bangkokbiznews,thansettakij'},{page:1,query:'Stored AI'},{page:3,source:'broker',symbol:'PTT'}];
 for(const args of workloads){
  global.gc?.();currentRequests=0;currentBytes=0;let service=createNewsArchiveService({env,fetchImpl:transport,...(mode==='fullscan-reference'?{maxScanRows:60000}:{})}),result=null,start=performance.now();
  try{result=await service.list(args);outcomes.push({total:result.total,items:result.items.length});}catch(error){if(mode!=='bounded-baseline')throw error;outcomes.push({error:'BOUNDED_SCAN_LIMIT'});}
  samples.push(performance.now()-start);requests.push(currentRequests);payload.push(currentBytes);service=null;result=null;
 }
 const ordered=samples.slice().sort((a,b)=>a-b),percentile=p=>Number(ordered[Math.min(ordered.length-1,Math.ceil(ordered.length*p)-1)].toFixed(2));
 console.log(JSON.stringify({environment:'isolated-node20-pg17-postgrest',mode,size,samples:samples.length,p50Ms:percentile(.5),p95Ms:percentile(.95),requestCounts:requests,responseBytes:payload,peakRssMiB:Number((process.resourceUsage().maxRSS/1024).toFixed(2)),outcomes}));
})().catch(error=>{console.error(JSON.stringify({message:error.message,cause:error.cause?.code||error.cause?.message||null}));process.exitCode=1;});
