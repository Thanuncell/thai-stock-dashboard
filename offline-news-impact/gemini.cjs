'use strict';
const {fail}=require('./reader.cjs');
const MODEL='gemini-3.5-flash-lite';
const ENDPOINT=`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
function createGeminiProvider({enabled=false,env=process.env,fetchImpl=global.fetch}={}){
  return{async generate({article,prompt,schema,catalog,signal}){
    if(!enabled)throw fail('PROVIDER_DISABLED');
    const key=env.GEMINI_API_KEY;
    if(typeof key!=='string'||!key.trim())throw fail('PROVIDER_CONFIG');
    // Provider grammar rejects the 499-symbol enum; keep catalog validation server-side.
    const providerSchema=structuredClone(schema);
    delete providerSchema.properties.stocks.items.properties.symbol.enum;
    let response;
    try{response=await fetchImpl(ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key},redirect:'error',signal,body:JSON.stringify({systemInstruction:{parts:[{text:prompt+'\nCatalog ของ Server:\n'+JSON.stringify(catalog)}]},contents:[{role:'user',parts:[{text:JSON.stringify({article})}]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:providerSchema,maxOutputTokens:4096,candidateCount:1}})});}
    catch{throw fail(signal?.aborted?'PROVIDER_TIMEOUT':'PROVIDER_FAILURE');}
    if(!response.ok){
      try{await response.body?.cancel();}catch{}
      throw fail(response.status===429?'PROVIDER_RATE_LIMIT':'PROVIDER_FAILURE');
    }
    const chunks=[];let bytes=0;
    try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65_536)throw Error('OVERSIZE');chunks.push(Buffer.from(chunk));}}catch{throw fail('INVALID_PROVIDER_OUTPUT');}
    const body=Buffer.concat(chunks).toString('utf8');
    let data;try{data=JSON.parse(body);}catch{throw fail('INVALID_PROVIDER_JSON');}
    if(data.promptFeedback?.blockReason)throw fail('PROVIDER_BLOCKED');
    if(!Array.isArray(data.candidates)||data.candidates.length!==1||data.candidates[0].finishReason!=='STOP'||!Array.isArray(data.candidates[0].content?.parts))throw fail('INVALID_PROVIDER_OUTPUT');
    const parts=data.candidates[0].content.parts.filter(p=>!p.thought);
    if(!parts.length||parts.some(p=>typeof p.text!=='string'))throw fail('INVALID_PROVIDER_OUTPUT');
    return parts.map(p=>p.text).join('');
  }};
}
module.exports={MODEL,ENDPOINT,createGeminiProvider};
