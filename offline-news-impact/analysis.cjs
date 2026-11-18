'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hasIdentityEvidence}=require('./catalog.cjs');
const {fail}=require('./reader.cjs');
const {comparisonOnlyEvidence}=require('./temporal-evidence.cjs');
const SCHEMA=require('./response.schema.json');
function schemaFor(catalog){if(!catalog?.items?.length)throw fail('CATALOG_UNAVAILABLE');const schema=structuredClone(SCHEMA);schema.properties.stocks.items.properties.symbol.enum=catalog.items.map(x=>x.symbol);return schema;}
const PROMPT=fs.readFileSync(path.join(__dirname,'SYSTEM_PROMPT.txt'),'utf8').trim();
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===[...expected].sort().join();
const str=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function validate(raw,article,catalog){
  if(!catalog?.items?.length)throw fail('CATALOG_UNAVAILABLE');
  let value;if(typeof raw!=='string'||raw.length>32_000)throw fail('INVALID_PROVIDER_OUTPUT');
  try{value=JSON.parse(raw);}catch{throw fail('INVALID_PROVIDER_JSON');}
  if(!keys(value,['summary','stocks'])||!Array.isArray(value.summary)||value.summary.length<2||value.summary.length>4||value.summary.some(x=>!str(x,500))||!Array.isArray(value.stocks)||value.stocks.length>10)throw fail('INVALID_PROVIDER_OUTPUT');
  const result={summary:value.summary,positive:[],negative:[],status:'no_match'};const seen=new Set();
  for(const item of value.stocks){
    if(!keys(item,['symbol','direction','reason','evidence'])||!str(item.symbol,20)||!['positive','negative'].includes(item.direction)||!str(item.reason,600)||!str(item.evidence,1000))throw fail('INVALID_PROVIDER_OUTPUT');
    const identity=catalog.items.find(x=>x.symbol===item.symbol);
    if(!identity||!article.includes(item.evidence)||!hasIdentityEvidence(identity,item.evidence,catalog)||comparisonOnlyEvidence(article,item.evidence))continue;
    if(seen.has(item.symbol))throw fail('CONFLICTING_CLASSIFICATION');seen.add(item.symbol);
    result[item.direction].push({symbol:identity.symbol,name:identity.name,reason:item.reason,evidence:item.evidence,reference:identity.source});
  }
  if(seen.size)result.status='success';return result;
}
async function analyze(provider,article,{timeoutMs=10_000,catalog}={}){
  const schema=schemaFor(catalog);
  const controller=new AbortController();let timer;
  try{
    const raw=await Promise.race([provider.generate({article,prompt:PROMPT,schema,catalog:catalog.items.map(({symbol,name})=>({symbol,name})),signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('PROVIDER_TIMEOUT'));},timeoutMs);})]);
    return validate(raw,article,catalog);
  }catch(error){if(['INVALID_PROVIDER_OUTPUT','INVALID_PROVIDER_JSON','CONFLICTING_CLASSIFICATION','PROVIDER_TIMEOUT','PROVIDER_FAILURE','PROVIDER_RATE_LIMIT','PROVIDER_DISABLED','PROVIDER_CONFIG','PROVIDER_BLOCKED'].includes(error.code))throw error;throw fail('PROVIDER_FAILURE');}
  finally{clearTimeout(timer);}
}
module.exports={SCHEMA,PROMPT,validate,analyze,schemaFor};
