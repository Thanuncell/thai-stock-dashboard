'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createGeminiProvider}=require('../gemini.cjs');
const {validate,analyze}=require('../analysis.cjs');
const {createService,Lane}=require('../service.cjs');
const {catalog}=require('../fixtures/coverage.cjs'),f=require('../fixtures/news.cjs');
const env={GEMINI_API_KEY:'fixture-private-marker'};
const envelope=output=>({candidates:[{finishReason:'STOP',content:{parts:[{text:typeof output==='string'?output:JSON.stringify(output)}]}}]});
test('diagnostics distinguish envelope, finish, part and generated JSON failures without content',async()=>{
  const cases=[['ENVELOPE_JSON',new Response('private article not json')],['CANDIDATE_COUNT',Response.json({candidates:[]})],['FINISH_REASON',Response.json({candidates:[{finishReason:'MAX_TOKENS'}]})],['CONTENT_PARTS',Response.json({candidates:[{finishReason:'STOP'}]})],['TEXT_PARTS',Response.json({candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{data:'private-marker'}}]}}]})]];
  for(const [constraint,response]of cases){const events=[];await assert.rejects(analyze(createGeminiProvider({enabled:true,env,fetchImpl:async()=>response,onDiagnostic:x=>events.push(x)}),f.text,{catalog,onDiagnostic:x=>events.push(x)}));assert.equal(events.at(-1).constraint,constraint);assert.equal(JSON.stringify(events).includes('private'),false);}
  const events=[];await assert.rejects(analyze(createGeminiProvider({enabled:true,env,fetchImpl:async()=>Response.json(envelope('{private malformed json')),onDiagnostic:x=>events.push(x)}),f.text,{catalog,onDiagnostic:x=>events.push(x)}),{code:'INVALID_PROVIDER_JSON'});assert.deepEqual(events,[{stage:'validation',constraint:'GENERATED_JSON'}]);
});
test('untrusted provider reason and unknown property names never enter diagnostics',async()=>{const events=[];await assert.rejects(analyze(createGeminiProvider({enabled:true,env,fetchImpl:async()=>Response.json({candidates:[{finishReason:'fixture-private-marker'}]}),onDiagnostic:x=>events.push(x)}),f.text,{catalog}));assert.equal(events[0].finishReason,'UNRECOGNIZED');assert.equal(JSON.stringify(events).includes(env.GEMINI_API_KEY),false);});
test('field diagnostics preserve strict rejection and record only fixed names, indexes and lengths',()=>{
  const cases=[['ROOT_FIELDS',v=>{v.secret='private';}],['SUMMARY_COUNT',v=>{v.summary=[];}],['SUMMARY_ITEM',v=>{v.summary[0]='x'.repeat(501);}],['STOCK_COUNT',v=>{v.stocks=Array(11).fill(v.stocks[0]);}],['STOCK_FIELDS',v=>{v.stocks[0].secret='private';}],['STOCK_SYMBOL',v=>{v.stocks[0].symbol='x'.repeat(21);}],['STOCK_REASON',v=>{v.stocks[0].reason='x'.repeat(601);}],['STOCK_EVIDENCE',v=>{v.stocks[0].evidence='x'.repeat(1001);}],['STOCK_DIRECTION',v=>{v.stocks[0].direction='private';}]];
  for(const [constraint,change]of cases){const events=[],value=structuredClone(f.output);change(value);assert.throws(()=>validate(JSON.stringify(value),f.text,catalog,x=>events.push(x)),{code:'INVALID_PROVIDER_OUTPUT'});assert.equal(events.at(-1).constraint,constraint);assert.equal(JSON.stringify(events).includes('private'),false);}
});
test('diagnostic callback failure cannot change accepted results or error mapping',async()=>{assert.deepEqual(validate(JSON.stringify(f.output),f.text,catalog,()=>{throw Error('private');}),validate(JSON.stringify(f.output),f.text,catalog));assert.throws(()=>validate('{broken',f.text,catalog,()=>{throw Error('private');}),{code:'INVALID_PROVIDER_JSON'});});
test('URL and pasted identical content preserve the same article and provider schema contract',async()=>{
  const events=[],calls=[];
  const provider={async generate(request){calls.push({article:request.article,prompt:request.prompt,schema:request.schema,catalog:request.catalog});return JSON.stringify(f.output);}};
  const service=createService({authenticate:async()=>({id:'verified-user'}),reader:{read:async()=>({text:f.text})},provider,loadCatalog:async()=>catalog,lane:new Lane({now:()=>0,wait:async()=>{}}),onDiagnostic:x=>events.push(x)});
  const a=await service({}, {mode:'text',value:f.text,requestKey:'text'}),b=await service({}, {mode:'url',value:'https://example.com/news',requestKey:'url'});
  assert.deepEqual(a,b);assert.deepEqual(calls[0],calls[1]);const prepared=events.filter(x=>x.stage==='input');assert.equal(prepared[0].articleSha256,prepared[1].articleSha256);assert.deepEqual(prepared.map(x=>x.mode),['text','url']);assert.equal(prepared.every(x=>x.catalogCount===499),true);assert.equal(JSON.stringify(events).includes(f.text),false);
});
