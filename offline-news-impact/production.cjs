'use strict';

// Optional production composition. Disabled unless explicitly configured.
function createProductionImpact({env=process.env,auth,repository,nodeVersion=process.versions.node,
  fetchImpl=global.fetch,loaderOptions={},onUsage=()=>{},onFailure=()=>{},onReaderRequest=()=>{},runtimeFactory}={}) {
  const requested=env.SETSCOPE_NEWS_IMPACT_ENABLED==='true';
  const status={requested,enabled:false,nodeVersion,keyPresent:typeof env.GEMINI_API_KEY==='string'&&Boolean(env.GEMINI_API_KEY.trim()),authConfigured:auth?.configured===true,coverageConfigured:repository?.configured===true};
  if(!requested)return{runtime:null,status:{...status,state:'disabled'}};
  const users=new Set(String(env.SETSCOPE_NEWS_IMPACT_ALLOWED_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean));
  const rpm=Number(env.SETSCOPE_NEWS_IMPACT_RPM);
  const redirects=env.SETSCOPE_NEWS_IMPACT_READER_REDIRECTS===undefined?2:Number(env.SETSCOPE_NEWS_IMPACT_READER_REDIRECTS);
  const missing=[];
  const major=Number(nodeVersion.split('.')[0]);
  if(!Number.isInteger(major)||major<24)missing.push('NODE_VERSION');
  if(!status.keyPresent)missing.push('PROVIDER_KEY');
  if(!status.authConfigured||typeof auth?.authorize!=='function')missing.push('AUTH');
  if(!status.coverageConfigured)missing.push('COVERAGE');
  if(!users.size||[...users].some(x=>x.length>128))missing.push('CONTROLLED_USERS');
  if(!Number.isInteger(rpm)||rpm<1||rpm>15)missing.push('RATE_CONFIG');
  if(!Number.isInteger(redirects)||redirects<0||redirects>2)missing.push('READER_CONFIG');
  if(missing.length)return{runtime:null,status:{...status,state:'not_ready',missing}};
  // No credentials, user identifiers, article text or raw provider errors in status.
  try {
  const {createImpactRuntime}=require('./runtime.cjs');
  const {createReader}=require('./reader.cjs');
  const {createUrlLoader}=require('./url-loader.cjs');
  const {createGeminiProvider}=require('./gemini.cjs');
  const {Lane}=require('./service.cjs');
  const runtime=(runtimeFactory||createImpactRuntime)({repository,
    entryModule:'production.mjs',canAnalyze:user=>users.has(user?.id),
    reader:createReader({loadHtml:createUrlLoader({...loaderOptions,enabled:true,maxRedirects:redirects,onRequest:onReaderRequest})}),
    provider:createGeminiProvider({enabled:true,env,fetchImpl,onUsage,onFailure}),lane:new Lane({rpm})});
  return{runtime,status:{...status,enabled:true,state:'ready',rpm,controlledUsers:users.size,readerRedirects:redirects}};
  }catch{return{runtime:null,status:{...status,state:'not_ready',missing:['MODULE_INITIALIZATION']}};}
}
module.exports={createProductionImpact};
