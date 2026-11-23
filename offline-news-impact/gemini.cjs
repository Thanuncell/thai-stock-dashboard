'use strict';
const {fail}=require('./reader.cjs');
const MODEL='gemini-3.5-flash-lite';
const ENDPOINT=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
function createGeminiProvider({enabled=false,env=process.env,fetchImpl=global.fetch,onUsage,onFailure,onDiagnostic}={}){
  const diagnostic=(constraint,details={})=>{try{onDiagnostic?.({stage:'provider',constraint,...details});}catch{}};
  return{async generate({article,prompt,schema,catalog,signal}){
    if(!enabled)throw fail('PROVIDER_DISABLED');
    const key=env.GEMINI_API_KEY;
    if(typeof key!=='string'||!key.trim())throw fail('PROVIDER_CONFIG');
    const started=Date.now();
    // Provider grammar rejects the 499-symbol enum; keep catalog validation server-side.
    const providerSchema=structuredClone(schema);
    delete providerSchema.properties.stocks.items.properties.symbol.enum;
    let response;
    try{response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},redirect:'error',signal,body:JSON.stringify({systemInstruction:{parts:[{text:prompt+'\nCatalog ของ Server:\n'+JSON.stringify(catalog)}]},contents:[{role:'user',parts:[{text:JSON.stringify({article})}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:providerSchema,maxOutputTokens:4096,candidateCount:1}})});}
    catch{throw fail(signal?.aborted?'PROVIDER_TIMEOUT':'PROVIDER_FAILURE');}
    if(!response.ok){
      try{onFailure?.({httpStatus:response.status,latencyMs:Date.now()-started});}catch{}
      try{await response.body?.cancel();}catch{}
      throw fail(response.status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_FAILURE');
    }
    const chunks=[];let bytes=0;
    try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65_536)throw Error('OVERSIZE');chunks.push(Buffer.from(chunk));}}catch{diagnostic('ENVELOPE_READ',{bytes});throw fail('INVALID_PROVIDER_OUTPUT');}
    const body=Buffer.concat(chunks).toString('utf8');
    let data;try{data=JSON.parse(body);}catch{diagnostic('ENVELOPE_JSON',{bytes});throw fail('INVALID_PROVIDER_JSON');}
    if(typeof onUsage==='function'&&data.usageMetadata){
      const usage={latencyMs:Date.now()-started};
      for(const name of ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','totalTokenCount','cachedContentTokenCount'])if(Number.isSafeInteger(data.usageMetadata[name])&&data.usageMetadata[name]>=0)usage[name]=data.usageMetadata[name];
      try{onUsage(usage);}catch{}
    }
    if(data.promptFeedback?.blockReason)throw fail('PROVIDER_BLOCKED');
    if(!Array.isArray(data.candidates)||data.candidates.length!==1){diagnostic('CANDIDATE_COUNT');throw fail('INVALID_PROVIDER_OUTPUT');}
    const candidate=data.candidates[0];
    if(candidate?.finishReason!=='STOP'){diagnostic('FINISH_REASON',{finishReason:['MAX_TOKENS','SAFETY','RECITATION','OTHER','BLOCKLIST','PROHIBITED_CONTENT','SPII','MALFORMED_FUNCTION_CALL','IMAGE_SAFETY','UNEXPECTED_TOOL_CALL','TOO_MANY_TOOL_CALLS'].includes(candidate?.finishReason)?candidate.finishReason:'UNRECOGNIZED'});throw fail('INVALID_PROVIDER_OUTPUT');}
    if(!Array.isArray(candidate.content?.parts)){diagnostic('CONTENT_PARTS');throw fail('INVALID_PROVIDER_OUTPUT');}
    const parts=data.candidates[0].content.parts.filter(p=>!p?.thought);
    if(!parts.length||parts.some(p=>typeof p?.text!=='string')){diagnostic('TEXT_PARTS',{partCount:parts.length});throw fail('INVALID_PROVIDER_OUTPUT');}
    return parts.map(p=>p.text).join('');
  }};
}
module.exports={MODEL,ENDPOINT,createGeminiProvider};
