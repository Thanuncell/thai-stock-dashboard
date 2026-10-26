'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStockSearchService,SEARCH_ENRICHMENT_MS}=require('../server/search-service');
const {createMarketService}=require('../server/market-service');
const registry=['THAI','THANI'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'}));
test('synthetic registry exact search passes 500/500 with the correct first result and unchanged verification data',async t=>{
 const symbols=[...Array.from({length:498},(_,i)=>'S'+String(i).padStart(4,'0')),'THAI','THANI'];
 const rows=symbols.map((symbol,i)=>Object.freeze({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,
  status:['verified','pending','partial','temporary_failed'][i%4],symbol_verified:i%4===0,chart_ready:i%4===0,technical_ready:i%4===0,last_verified_at:i%4===0?'2026-10-26T11:00:00Z':null}));
 Object.freeze(rows);const before=structuredClone(rows);let passed=0;
 const service=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>[]});
 for(const symbol of symbols){const items=await service.search(symbol.toLowerCase());assert.equal(items[0]?.symbol,symbol);assert.equal(items[0].name,symbol);passed++;}
 assert.equal(passed,500);assert.deepEqual(rows,before);assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);
 t.diagnostic('Synthetic exact symbol match: 500/500; registry and verification fields unchanged. Registry has ticker identities only.');
});
for(const kind of ['abort-aware','ignored-abort','body-stall'])test(`registry-backed ${kind} enrichment is bounded and late results cannot replace ticker identities`,{timeout:5000},async()=>{
 let signal,calls=0,release;
 const market=createMarketService({fetchImpl:async(_input,init)=>{
  signal=init.signal;calls++;
  if(kind==='abort-aware')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  if(kind==='ignored-abort')return new Promise(resolve=>{release=()=>resolve(Response.json({quotes:[{symbol:'OTHER.BK',quoteType:'EQUITY'}]}));});
  const response=Response.json({});response.json=()=>new Promise(resolve=>{release=()=>resolve({quotes:[{symbol:'OTHER.BK',quoteType:'EQUITY'}]});});return response;
 }});
 const service=createStockSearchService({registrySearch:async()=>registry,providerSearch:market.search,enrichmentMs:25});
 const items=await service.search('tha');assert.deepEqual(items.map(r=>r.symbol),['THAI','THANI']);assert.equal(signal.aborted,true);assert.equal(calls,1);
 if(release){release();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(items.map(r=>r.symbol),['THAI','THANI']);}
});
test('production enrichment default is 750ms and cannot be configured beyond that bound',async()=>{
 assert.equal(SEARCH_ENRICHMENT_MS,750);assert.throws(()=>createStockSearchService({enrichmentMs:751}));
 let options;
 const service=createStockSearchService({registrySearch:async()=>registry,providerSearch:async(_q,o)=>{options=o;return [{symbol:'THAI',name:'Thai Airways'}];}});
 assert.equal((await service.search('thai'))[0].name,'Thai Airways');assert.equal(options.signal.aborted,false);assert.equal(options.allowSuffixFallback,false);
});
test('Yahoo search keeps suffix fallback and propagates one external signal through both requests',async()=>{
 const control=new AbortController(),seen=[];
 const market=createMarketService({fetchImpl:async(input,init)=>{const q=new URL(String(input)).searchParams.get('q');seen.push({q,signal:init.signal});
  return Response.json({quotes:q==='AE.BK'?[{symbol:'AE.BK',quoteType:'EQUITY'}]:[]});}});
 assert.equal((await market.search('AE',{signal:control.signal}))[0].symbol,'AE');assert.deepEqual(seen.map(r=>r.q),['AE','AE.BK']);
 control.abort();assert.ok(seen.every(r=>r.signal.aborted));
 const before=seen.length;await assert.rejects(market.search('AE',{signal:control.signal}));assert.equal(seen.length,before);
});
for(const status of [403,429,503])test(`enrichment HTTP ${status} uses registry without retrying the denied/failed source`,async()=>{
 let calls=0;const market=createMarketService({fetchImpl:async()=>{calls++;return Response.json({},{status});}});
 const service=createStockSearchService({registrySearch:async()=>registry,providerSearch:market.search});
 assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);assert.equal(calls,1);
});
test('registry unavailable keeps provider-only ticker/name discovery and legacy fallback',async()=>{
 const queries=[];const market=createMarketService({fetchImpl:async input=>{const q=new URL(String(input)).searchParams.get('q');queries.push(q);
  return Response.json({quotes:q==='AE.BK'?[{symbol:'AE.BK',quoteType:'EQUITY',longname:'Provider supplied name'}]:[]});}});
 const service=createStockSearchService({registrySearch:async()=>{throw Error('fixture registry unavailable');},providerSearch:market.search});
 assert.equal((await service.search('AE'))[0].name,'Provider supplied name');assert.deepEqual(queries,['AE','AE.BK']);
});
