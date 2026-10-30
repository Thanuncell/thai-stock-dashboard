'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{getEventListeners}=require('node:events');
const {createNewsWorker,createDurableNewsIngest}=require('../server/news-work');
const {createNewsWorkStore,workKey}=require('../server/news-work-store');
const {article,memoryTransport}=require('./fixtures/news-evidence.cjs');
function memoryStore(jobs=[]){
 const transitions=[],records=new Map(jobs.map(j=>[j.id,{attempts:1,state:'pending',...j}]));
 return {enabled:true,transitions,records,
  async enqueue({scope,key,stage,payload}){const id=workKey(scope,key);if(!records.has(id))records.set(id,{id,scope,stage,payload,state:'pending',attempts:0});return [records.get(id)];},
  async claim({scope}){const job=[...records.values()].find(j=>j.scope===scope&&j.state==='pending');if(!job)return [];job.state='processing';job.attempts++;job.lease_token='lease';return [{...job}];},
  async finish(job,action,{stage,checkpoint,error}={}){transitions.push({id:job.id,action,stage,error});const j=records.get(job.id);if(!j||j.lease_token!==job.lease_token)return false;j.state=action==='advance'?'pending':action;j.stage=stage||j.stage;if(action==='advance')j.checkpoint=checkpoint;return true;}
 };
}
test('queue OFF/unset makes zero network calls and retains legacy ingest contract',async()=>{
 for(const env of [{},{SETSCOPE_NEWS_WORK_QUEUE:'off'}]){
  let calls=0;const store=createNewsWorkStore({env,fetchImpl:()=>{calls++;throw Error('network');}});
  assert.deepEqual(await createNewsWorker({store}).runOnce(),{enabled:false,processed:0});
  const archive={ingest:async(items)=>({ingested:items.length})};
  assert.deepEqual(await createDurableNewsIngest({archive,store}).ingest([{}]),{ingested:1});assert.equal(calls,0);
 }
});
test('scope is part of the idempotency identity',()=>{assert.notEqual(workKey('A','same'),workKey('B','same'));assert.equal(workKey('A','same'),workKey('A','same'));});
test('discovery/extraction/persistence checkpoints resume without repeating completed stages',async()=>{
 const store=memoryStore([{id:1,scope:'general',stage:'discovery',payload:{url:'synthetic'}}]),seen=[];
 const handlers={discover:async x=>{seen.push('discovery');return {...x,discovered:true};},extract:async x=>{assert.equal(x.discovered,true);seen.push('extraction');return {...x,extracted:true};},persist:async x=>{assert.equal(x.extracted,true);seen.push('persistence');return {ack:true};}};
 await createNewsWorker({store,...handlers}).runOnce();assert.equal(store.records.get(1).stage,'extraction');
 await createNewsWorker({store,...handlers}).runOnce();await createNewsWorker({store,...handlers}).runOnce();
 assert.deepEqual(seen,['discovery','extraction','persistence']);assert.equal(store.records.get(1).state,'completed');
});
test('poison item is terminal while the next healthy item completes',async()=>{
 const store=memoryStore([{id:1,scope:'general',stage:'persistence',payload:{bad:true}},{id:2,scope:'general',stage:'persistence',payload:{bad:false}}]);
 const worker=createNewsWorker({store,persist:async x=>{if(x.bad)throw Object.assign(Error('denied'),{status:403});return {ack:true};}});
 const r=await worker.runOnce({limit:2});assert.deepEqual(r.outcomes.map(x=>x.outcome),['terminal','completed']);
});
test('429 and 5xx retry with stage-qualified bounded failure reasons',async()=>{
 for(const status of [429,500,503]){const store=memoryStore([{id:1,scope:'general',stage:'extraction',payload:{}}]);await createNewsWorker({store,extract:async()=>{throw Object.assign(Error('sensitive provider body'),{status});}}).runOnce();assert.equal(store.transitions[0].action,'retry');assert.equal(store.transitions[0].error,'EXTRACTION_HTTP_'+status);}
});
test('timeout aborts work, records retry and never advances a late result',async()=>{
 const store=memoryStore([{id:1,scope:'general',stage:'extraction',payload:{}}]);let aborted=false;
 const worker=createNewsWorker({store,timeoutMs:10,extract:(_, {signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve({late:true});},{once:true}))});
 const r=await worker.runOnce();assert.equal(aborted,true);assert.equal(r.outcomes[0].outcome,'retry');assert.equal(store.records.get(1).stage,'extraction');
});
test('listener lifecycle remains bounded over 100 worker slices',async()=>{
 const controller=new AbortController(),before=getEventListeners(controller.signal,'abort').length;
 const store=memoryStore(Array.from({length:100},(_,id)=>({id,scope:'general',stage:'persistence',payload:{}})));
 const worker=createNewsWorker({store,persist:async()=>({ack:true})});
 for(let n=0;n<100;n++){await worker.runOnce({signal:controller.signal});assert.equal(getEventListeners(controller.signal,'abort').length,before);}
});
test('trusted article survives durable serialization then existing archive ingest/read',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore();
 const item=article(),queue=createDurableNewsIngest({archive,store});
 await queue.ingest([item]);assert.equal(transport.rows.size,1);
 const row=[...transport.rows.values()][0];assert.equal(row.verification_basis,'article');
 const read=await archive.list();assert.equal(read.items[0].verification.basis,'article');
});
test('duplicate enqueue is deterministic despite later wall-clock preparation',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore();store.claim=async()=>[];
 const queue=createDurableNewsIngest({archive,store}),item=article();
 await queue.ingest([item]);await new Promise(r=>setTimeout(r,3));await queue.ingest([item]);assert.equal(store.records.size,1);
});
test('caller-supplied VERIFIED cannot acquire article evidence via the queue',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore(),queue=createDurableNewsIngest({archive,store});
 const fake={...article(),verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED'}};
 await queue.ingest([fake]);assert.ok([...transport.rows.values()].every(x=>x.verification_basis!=='article'));
});
test('archive conflict does not complete durable work',async()=>{
 const source=memoryTransport().service(),item=article();
 const store=memoryStore(),archive={...source,ingest:async()=>({configured:true,ingested:0,retained:0,conflicts:1})};
 const result=await createDurableNewsIngest({archive,store}).ingest([item]);assert.equal(result.outcomes[0].outcome,'retry');
});
test('oversized checkpoints and missing stage handlers terminate without erasing job payload',async()=>{
 const store=memoryStore([{id:1,scope:'general',stage:'extraction',payload:{original:true}}]);
 await createNewsWorker({store,extract:async()=>({x:'x'.repeat(65000)})}).runOnce();
 assert.equal(store.records.get(1).state,'terminal');assert.deepEqual(store.records.get(1).payload,{original:true});
});

test('durable persistence does not apply display filtering to stored document metadata',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore();
 const item={title:'notice.pdf - SET - SET',url:'https://news.google.com/rss/articles/document',source:'settrade',sourceName:'SET',snippet:'Synthetic official announcement metadata',pubDate:new Date(Date.now()-60000).toISOString()};
 item.verification=require('../lib/news-quality').reviewNewsItem(item);
 const result=await createDurableNewsIngest({archive,store}).ingest([item]);
 assert.equal(result.outcomes[0].outcome,'completed');assert.equal(transport.rows.size,1);
 assert.equal([...transport.rows.values()][0].verification_basis,'metadata');assert.equal((await archive.list()).items.length,0);
});
test('trusted negative checkpoint persists through existing assessment path without deleting the row',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore(),item=article();
 const queue=createDurableNewsIngest({archive,store});await queue.ingest([item]);
 const negative=require('../lib/news-evidence').issueEvidence(item,{status:'REJECTED',reason:'ARTICLE_NOT_FOUND',basis:'article'},{checkedAt:Date.now()+1,originalUrl:item.url});
 const result=await queue.ingest([],{assessments:[{item,verification:negative}]});
 assert.equal(result.outcomes[0].outcome,'completed');assert.equal(transport.rows.size,1);assert.equal([...transport.rows.values()][0].verification_status,'REJECTED');
});
test('malformed RPC acknowledgements and cross-scope claims fail closed',async()=>{
 const env={SETSCOPE_NEWS_WORK_QUEUE:'on',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture'};
 const store=createNewsWorkStore({env,fetchImpl:async()=>Response.json({success:true})});
 await assert.rejects(store.enqueue({scope:'general',key:'x',payload:{}}),/INVALID_ACK/);
 await assert.rejects(store.claim({scope:'general'}),/INVALID_CLAIM/);
 await assert.rejects(store.finish({id:1,scope:'general',lease_token:'x'},'completed'),/INVALID_ACK/);
});
test('queue activation cannot drain work with a legacy/read-only archive writer',async()=>{
 const store=memoryStore(),archive={canQueue:false,prepare(){throw Error('must not prepare');}};
 await assert.rejects(createDurableNewsIngest({archive,store}).ingest([]),/REQUIRES_G1_WRITE/);
 assert.equal(store.records.size,0);
});

test('discovered candidate crosses JSON checkpoints, real article review and persistence with provenance intact',async()=>{
 const transport=memoryTransport(),archive=transport.service(),store=memoryStore();
 const oldClaim=store.claim;store.claim=async options=>JSON.parse(JSON.stringify(await oldClaim(options)));
 const candidate=require('../lib/news-discovery').recordDiscovery({
  title:'PTT รายงานผลประกอบการและแผนลงทุนล่าสุด',url:'https://thunhoon.com/article-queued-discovery',
  source:'thunhoon',sourceName:'Thunhoon',snippet:'บริษัท PTT รายงานผลประกอบการและแผนลงทุน',
  pubDate:new Date(Date.now()-60000).toISOString()
 },{pathway:'google-news-rss/general'});
 let requests=0;
 const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:candidate.url,headline:candidate.title,datePublished:candidate.pubDate,articleBody:'บริษัท PTT รายงานผลประกอบการและรายละเอียดการลงทุนตามบทความต้นฉบับ '.repeat(8)})+'</script>';
 const review=require('./fixtures/news-service.cjs').createNewsService({
  env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on'},
  fetchImpl:async input=>{requests++;assert.equal(String(input),candidate.url);return new Response(html,{headers:{'content-type':'text/html'}});}
 }).reviewDiscovered;
 const queue=createDurableNewsIngest({archive,store,review});
 await queue.captureDiscovered([candidate]);
 for(let n=0;n<3;n++)await queue.runOnce();
 const job=[...store.records.values()][0];assert.equal(job.state,'completed');assert.equal(requests,1);
 const row=[...transport.rows.values()][0];assert.equal(row.verification_basis,'article');
 assert.equal(row.verification_provenance.discovery.pathway,'google-news-rss/general');
 assert.equal(row.verification_provenance.discovery.originalUrl,candidate.url);
 assert.equal(row.verification_provenance.discovery.publisher,candidate.sourceName);
 assert.equal((await archive.list()).items[0].verification.basis,'article');
});

test('recovery store accepts the same legacy Service Role credential contract as Archive',async()=>{
 for(const keys of [{SUPABASE_SERVICE_ROLE_KEY:'synthetic-legacy'},{SUPABASE_SECRET_KEY:'sb_secret_synthetic-primary',SUPABASE_SERVICE_ROLE_KEY:'synthetic-legacy'}]){
  const expected=keys.SUPABASE_SECRET_KEY||keys.SUPABASE_SERVICE_ROLE_KEY;let calls=0;
  const store=createNewsWorkStore({env:{SETSCOPE_NEWS_WORK_QUEUE:'on',SUPABASE_URL:'https://fixture.invalid',...keys},fetchImpl:async(input,init)=>{
   calls++;assert.equal(new URL(input).origin,'https://fixture.invalid');assert.equal(init.headers.apikey,expected);assert.equal(init.headers.Authorization,expected.startsWith('sb_secret_')?undefined:'Bearer '+expected);
   if(String(input).includes('/news_work?'))return Response.json([],{headers:{'content-range':'*/0'}});
   if(String(input).endsWith('/enqueue_news_work')){const p=JSON.parse(init.body);return Response.json([{work_key:p.p_key,scope:p.p_scope}]);}
   return Response.json(String(input).endsWith('/finish_news_work')?true:[]);
  }});
  await store.enqueue({scope:'recovery',key:'fixture',payload:{original:true}});assert.deepEqual(await store.claim({scope:'recovery'}),[]);assert.equal(await store.finish({id:1,lease_token:'synthetic',scope:'recovery'},'completed'),true);assert.equal((await store.inspect({scope:'recovery'})).depth,0);assert.equal(calls,4);
 }
});
