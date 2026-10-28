'use strict';
const {allowedNewsUrl,isGoogleNewsUrl,resolveAllowedNewsRedirect}=require('./news-policy');
const {decodeXml}=require('./settrade-parser');
const {createNewsTransport}=require('./news-fetch');
const RPC='https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je';
function decodedLegacyUrl(value) {
 try {
  const url=allowedNewsUrl(value);
  if(!isGoogleNewsUrl(url)||!/^\/(?:rss\/)?(?:articles|read)\/[A-Za-z0-9_-]{1,2048}$/.test(url.pathname))return null;
  const data=Buffer.from(url.pathname.split('/').pop(),'base64url');
  if(data[0]!==8||data[1]!==19||data[2]!==34)return null;
  let length=0,shift=0,index=3;
  for(;index<data.length&&shift<28;shift+=7){const byte=data[index++];length+=(byte&127)*2**shift;if(!(byte&128))break;}
  if(length<1||length>2048||index+length>data.length)return null;
  const result=allowedNewsUrl(data.subarray(index,index+length).toString('utf8'));
  return result&&!isGoogleNewsUrl(result)?result:null;
 }catch{return null;}
}
function wrapperParams(html,id) {
 for(const match of html.matchAll(/<[^>]+\bdata-n-a-id=["'][^"']+["'][^>]*>/g)){
  const attr=key=>decodeXml(match[0].match(new RegExp('\\b'+key+'=["\\x27]([^"\\x27]*)["\\x27]'))?.[1]||'');
  const signature=attr('data-n-a-sg'),timestamp=attr('data-n-a-ts');
  if(attr('data-n-a-id')===id&&/^\d{1,12}$/.test(timestamp)&&signature&&signature.length<=1024)
   return {signature,timestamp:Number(timestamp)};
 }
 return null;
}
function resolvedRpcUrl(text) {
 const values=[];
 for(const line of text.split('\n')){
  try{
   const frames=JSON.parse(line);
   if(!Array.isArray(frames))continue;
   for(const frame of frames){
    if(!Array.isArray(frame)||frame[0]!=='wrb.fr'||frame[1]!=='Fbv4je'||typeof frame[2]!=='string')continue;
    const result=JSON.parse(frame[2]);
    if(Array.isArray(result)&&result[0]==='garturlres'&&typeof result[1]==='string')values.push(result[1]);
   }
  }catch{/* Length prefixes and anti-XSSI framing are not JSON payloads. */}
 }
 if(values.length!==1)return null;
 const url=allowedNewsUrl(values[0]);return url&&!isGoogleNewsUrl(url)?url:null;
}
function createNewsArticleLoader({fetchImpl=globalThis.fetch,now=Date.now}={}) {
 const transport=createNewsTransport({fetchImpl}),denied=new Map();
 const load = async function(value,{budget={httpRemaining:6},signal,maxBytes=256000}={}) {
  const unknown=reason=>({status:'UNVERIFIED',reason});
  let target=allowedNewsUrl(value),rpcUsed=false,requests=0;
  if(!target)return unknown('INVALID_ARTICLE_URL');
  const originalWrapper=isGoogleNewsUrl(target);
  const legacy=decodedLegacyUrl(target);if(legacy)target=legacy;
  const requestSignal=signal||AbortSignal.timeout(7000);
  async function request(url,options={}){
   if(requestSignal.aborted)throw Error('NEWS_REQUEST_ABORTED');
   if((denied.get(url.origin)||0)>Number(now()))throw Error('NEWS_SOURCE_DENIED');
   if(budget.httpRemaining===undefined)budget.httpRemaining=12;
   if(budget.httpRemaining<=0||requests>=6)throw Error('NEWS_REQUEST_BUDGET');
   budget.httpRemaining--;requests++;
   const response=await transport(url,{redirect:'manual',signal:requestSignal,maxBytes:isGoogleNewsUrl(url)?1000000:maxBytes,
    headers:{'user-agent':'SETscope/1.0 news verifier',accept:'text/html,application/xhtml+xml'},...options});
   if([401,403,429].includes(response.status))denied.set(url.origin,response.status===429?Number(now())+300000:Infinity);
   return response;
  }
  try{
   for(let step=0;step<6;step++){
    const response=await request(target);
    if([401,403,429].includes(response.status))return unknown('ARTICLE_ACCESS_DENIED');
    if([301,302,303,307,308].includes(response.status)){
     const next=resolveAllowedNewsRedirect(target,response.headers.get('location'));
     if(!next)return unknown('ARTICLE_REDIRECT_BLOCKED');
     target=next;continue;
    }
    if(isGoogleNewsUrl(target)){
     if(!response.ok)return unknown('WRAPPER_UNRESOLVED');
     const id=target.pathname.match(/^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{1,2048})$/)?.[1];
     if(!id||rpcUsed)return unknown('WRAPPER_UNRESOLVED');
     // Wrapper markup is resolution data, never Article/negative evidence.
     const reader=response.body?.getReader(),chunks=[];let size=0;
     if(!reader)return unknown('WRAPPER_UNRESOLVED');
     while(size<1000000){const part=await reader.read();if(part.done)break;const chunk=part.value.slice(0,1000000-size);chunks.push(chunk);size+=chunk.length;if(size>=1000000){reader.cancel().catch(()=>{});break;}}
     const params=wrapperParams(Buffer.concat(chunks).toString('utf8'),id);
     if(!params)return unknown('WRAPPER_UNRESOLVED');
     const context=[['en-US','US',['FINANCE_TOP_INDICES','WEB_TEST_1_0_0'],null,null,1,1,'US:en',null,1,null,null,null,null,null,0,1],'en-US','US',1,[1,1,1],1,1,null,0,0,null,0];
     const packet=[[['Fbv4je',JSON.stringify(['garturlreq',context,id,params.timestamp,params.signature])]]];
     rpcUsed=true;
     const reply=await request(new URL(RPC),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8',Origin:'https://news.google.com',Referer:'https://news.google.com/'},
      body:new URLSearchParams({'f.req':JSON.stringify(packet)}).toString(),maxBytes:64000});
     if(!reply.ok)return unknown('WRAPPER_UNRESOLVED');
     const rpcReader=reply.body?.getReader(),rpcChunks=[];let rpcSize=0;
     if(!rpcReader)return unknown('WRAPPER_UNRESOLVED');
     while(rpcSize<64000){const part=await rpcReader.read();if(part.done)break;const chunk=part.value.slice(0,64000-rpcSize);rpcChunks.push(chunk);rpcSize+=chunk.length;if(rpcSize>=64000){rpcReader.cancel().catch(()=>{});break;}}
     const resolved=resolvedRpcUrl(Buffer.concat(rpcChunks).toString('utf8'));
     if(!resolved)return unknown('WRAPPER_UNRESOLVED');
     target=resolved;continue;
    }
    return {target,response,requests,originalWrapper};
   }
   return unknown('ARTICLE_REDIRECT_LIMIT');
  }catch(error){
   return unknown(error.message==='NEWS_REQUEST_BUDGET'?'ARTICLE_REQUEST_BUDGET':error.message==='NEWS_SOURCE_DENIED'?'ARTICLE_ACCESS_DENIED':'ARTICLE_NOT_VERIFIED');
  }
 };
 load.blockOrigin=(value,ttl=Infinity)=>{const url=allowedNewsUrl(value);if(url)denied.set(url.origin,ttl===Infinity?Infinity:Number(now())+ttl);};
 load.isBlocked=value=>{const url=allowedNewsUrl(value);return Boolean(url&&(denied.get(url.origin)||0)>Number(now()));};
 return load;
}
module.exports={decodedLegacyUrl,wrapperParams,resolvedRpcUrl,createNewsArticleLoader};
