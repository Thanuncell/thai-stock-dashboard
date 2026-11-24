'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsArchiveService}=require('../server/news-archive-service');
const now=Date.parse('2026-11-23T12:00:00Z');
const row=i=>({id:String(i+1),fingerprint:'scale-fixture-'+i,title:'PTT ข่าวผลประกอบการ '+(i===3999?'DEEP_ONLY':i),
 url:'https://news.google.com/rss/articles/cursor-readiness-'+i,source:'infoquest',source_name:'InfoQuest',
 snippet:'บริษัทเปิดเผยข้อมูลผลประกอบการและแผนการลงทุนตามแหล่งข่าวต้นทาง',published_at:new Date(now-8*86400000-i*1000).toISOString(),matched_symbols:['PTT'],broker_firms:[]});
function harness(size,{queryIndex=false,removed=0}={}){
 const metrics={requests:0,transportRows:0,transportBytes:0,paths:[]};
 const fetchImpl=async(input,init={})=>{
  const u=new URL(input);assert.equal(u.origin,'https://fixture.invalid');metrics.requests++;metrics.paths.push(u.pathname);
  let body,headers={};
  if(u.pathname.endsWith('/rpc/list_news_archive_query')){
   const args=JSON.parse(init.body);
   body={groups:[],pageKeys:[],featuredKeys:[],total:size,matchingTotal:size,countExact:true,page:args.p_page,pageSize:args.p_page_size};
  }else if(u.searchParams.has('or')){
   const length=Math.min(411,removed);body=Array.from({length},(_,i)=>({url:'https://news.google.com/rss/articles/removed-'+i,source:'other',source_name:'Investing.com',title:'PTT ข่าว - Investing.com'}));
   headers['content-range']=`0-${length-1}/${removed}`;
  }else{
   assert.equal(init.method||'GET','GET');
   const [start,end]=init.headers.Range.split('-').map(Number);
   body=Array.from({length:Math.max(0,Math.min(end+1,size)-start)},(_,i)=>row(start+i));
   headers['content-range']=`${start}-${start+body.length-1}/${size}`;
  }
  if(Array.isArray(body))metrics.transportRows+=body.length;
  const text=JSON.stringify(body);metrics.transportBytes+=Buffer.byteLength(text);
  return new Response(text,{headers:{...headers,'content-type':'application/json'}});
 };
 const service=createNewsArchiveService({now:()=>now,env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:queryIndex?'on':'off'},fetchImpl});
 return{service,metrics};
}

test('4k fixture records actual legacy transport/cache/deep-search behavior without claiming DB cursor readiness',async()=>{
 const {service,metrics}=harness(4000);
 const first=await service.list();assert.equal(first.items.length,10);assert.equal(first.total,4000);
 const initial={...metrics,paths:undefined};assert.equal(initial.requests,8);assert.equal(initial.transportRows,4000);
 await service.list({page:2});const deep=await service.list({query:'DEEP_ONLY',source:'infoquest'});
 assert.equal(deep.items.length,1);assert.match(deep.items[0].title,/DEEP_ONLY/);assert.equal(metrics.requests,8);
 console.log('OFFLINE_LEGACY_TRANSPORT '+JSON.stringify({fixtureRows:4000,initial,subsequentTransportRequests:0,actualDatabaseReads:'NOT RUN',billedEgress:'NOT RUN'}));
});

for(const size of [40000,50000])test(`${size} synthetic fixture reproduces the legacy bounded-snapshot limit independently of native cursor verification`,async()=>{
 const {service,metrics}=harness(size);
 await assert.rejects(service.list(),/exceeds bounded scan limit/);assert.equal(metrics.requests,1);assert.equal(metrics.transportRows,500);
});

test('E02 50k/420 remains an availability failure in actual service code with synthetic transport',async()=>{
 const {service,metrics}=harness(50000,{queryIndex:true,removed:420});
 await assert.rejects(service.list(),/exceeds bounded scan limit/);
 assert.equal(metrics.requests,3);assert.equal(metrics.transportRows,911);
 assert.equal(metrics.paths.filter(x=>x.includes('/rpc/')).length,1);
 console.log('E02_OFFLINE_REPRODUCTION '+JSON.stringify({archiveRows:50000,removedPublisherRows:420,legacyAvailability:'FAIL',backendCursorScale:'NOT RUN (synthetic transport only)',realDatabase:'NOT RUN',requests:metrics.requests,transportRows:metrics.transportRows,transportBytes:metrics.transportBytes}));
});

for(const size of [4000,40000,50000])test(`AC-09/10 synthetic ${size}/420 window cost vs snapshot and sequential cursor`,async()=>{
 const {createArchiveCursorSession,cursorScope}=await import('../client/news-archive-cursor.mjs');
 const createFixture=require('./fixtures/news-archive-window.cjs');
 const items=Array.from({length:size},(_,i)=>{
  const raw=row(i);return{id:raw.id,title:raw.title,url:raw.url,source:raw.source,sourceName:i>=size-420?'Investing.com':'InfoQuest',snippet:raw.snippet,pubDate:raw.published_at,matchedSymbols:['PTT']};
 });
 const args={featuredCount:0},fixture=await createFixture({rows:items,now}),s=createArchiveCursorSession({scope:cursorScope(args)});
 let cacheHits=0;const opened=new Map(),metadata=[];
 for(const page of [1,5,2,4,7,1,5,2,4,7]){
  assert.equal(s.open(page),true);const req=s.begin();
  if(req.cached){cacheHits++;continue;}
  const response=fixture.read({...args,cursor:req.cursor,revision:req.revision,lookahead:req.lookahead});
  if(response.window){
   assert.doesNotMatch(JSON.stringify(response.window),/title|snippet|articleBody/);
   metadata.push({page,positions:response.window.pages.length,keys:fixture.metrics.selectedOrderingKeys});
   for(const position of response.window.pages)if(position.cursor)assert.deepEqual(Object.keys(JSON.parse(Buffer.from(position.cursor,'base64url'))).sort(),['i','r','s','t','v']);
  }
  assert.equal(s.accept(req,response),true);assert.ok(response.items.every(x=>x.sourceName==='InfoQuest'));
  assert.equal(response.items.length,10);opened.set(page,response.items.map(x=>x.url));
 }
 assert.equal(fixture.metrics.requests,5);assert.equal(fixture.metrics.articleRows,50);assert.equal(cacheHits,5);
 assert.equal(fixture.metrics.metadataRows,9);assert.equal(fixture.metrics.selectedOrderingKeys,93);
 assert.deepEqual(metadata.map(x=>[x.page,x.positions]),[[1,5],[5,2],[7,2]]);
 assert.equal(new Set([...opened.values()].flat()).size,50,'only chosen pages, no duplicates');
 const sequential=await createFixture({rows:items,now}),cache=new Map(),positions=new Map([[1,null]]);let sequentialHits=0;
 const fetchPage=page=>{const response=sequential.read({...args,cursor:positions.get(page),revision:'1'});cache.set(page,response);if(response.hasNext)positions.set(page+1,response.nextCursor);};
 for(const target of [1,5,2,4,7,1,5,2,4,7]){
  if(cache.has(target)){sequentialHits++;continue;}
  while(!positions.has(target)){let page=1;while(cache.has(page))page++;fetchPage(page);}
  fetchPage(target);
 }
 assert.equal(sequential.metrics.requests,7);assert.equal(sequential.metrics.articleRows,70);
 const comparison={archiveRows:size,removedPublishers:420,workload:[1,5,2,4,7,1,5,2,4,7],
  window:{...fixture.metrics,cacheHits,expansions:metadata},sequential:{...sequential.metrics,cacheHits:sequentialHits},
  fullSnapshotReference:{rows:items.length,bytes:Buffer.byteLength(JSON.stringify(items)),requests:Math.ceil(size/500),kind:'serialized synthetic reference; actual legacy bounded path fails above 20k'},
  nativeSqlRpc:'NOT RUN (synthetic fixture only)',actualDatabaseReads:'NOT RUN',supabaseBilledEgress:'NOT RUN'};
 console.log('CURSOR_WINDOW_COST '+JSON.stringify(comparison));
});

test('window boundaries follow actual quality/publisher/search/dedupe/Featured eligibility in synthetic fixture',async()=>{
 const createFixture=require('./fixtures/news-archive-window.cjs'),{cursorScope,createArchiveCursorSession}=await import('../client/news-archive-cursor.mjs');
 const base=Array.from({length:85},(_,i)=>({id:String(i+1),title:'PTT ผลประกอบการ '+(i>60?'DEEP_MATCH':'NORMAL')+' '+i,url:'https://news.google.com/rss/articles/window-parity-'+i,
  source:i%2?'other':'infoquest',sourceName:i%2?'กรุงเทพธุรกิจ':'InfoQuest',snippet:'บริษัทเผยข้อมูลผลประกอบการและการลงทุนจากต้นทาง',pubDate:new Date(now-i*1000).toISOString(),matchedSymbols:['PTT']}));
 const rows=[...base,{...base[61],id:'99'},{...base[62],id:'100',sourceName:'Investing.com',url:base[62].url+'-removed'},
  {...base[63],id:'101',url:'https://www.set.or.th/invalid.pdf',title:'invalid.pdf'}];
 const args={query:'DEEP_MATCH',source:'infoquest',featuredCount:5},fixture=await createFixture({rows,now}),s=createArchiveCursorSession({scope:cursorScope(args)});
 const req=s.begin(),response=fixture.read({...args,lookahead:req.lookahead});assert.equal(s.accept(req,response),true);
 assert.equal(response.featured.length,5);assert.equal(response.items.length,7);assert.equal(response.hasNext,false);assert.deepEqual(s.window.pages,[1]);
 const identities=[...response.items,...response.featured].map(x=>x.url);assert.equal(new Set(identities).size,12);
 assert.ok([...response.items,...response.featured].every(x=>x.source==='infoquest'&&x.title.includes('DEEP_MATCH')));
 const second=fixture.read({...args});assert.equal(second.items.length,7);assert.equal(fixture.metrics.featuredSelections,1,'reuse same-scope Featured selection');
 fixture.setRevision('2');assert.throws(()=>fixture.read({...args,revision:'1'}),/INDEX_CHANGED/);
});

test('synthetic keyset windows preserve microsecond ties and bigint order without cross-scope/revision reuse',async()=>{
 const createFixture=require('./fixtures/news-archive-window.cjs'),{createArchiveCursorSession,cursorScope}=await import('../client/news-archive-cursor.mjs');
 const rows=Array.from({length:63},(_,i)=>({id:String(9007199254740992n+BigInt(i)),title:'PTT ข่าวธุรกิจต้นทาง '+i,url:'https://news.google.com/rss/articles/window-tie-'+i,
  source:'infoquest',sourceName:'InfoQuest',snippet:'บริษัทเผยข้อมูลผลประกอบการและแผนการลงทุนจากต้นทาง',pubDate:'2026-11-15T12:00:00.'+(i<30?'123001':'123002')+'Z',matchedSymbols:['PTT']}));
 const args={featuredCount:0},fixture=await createFixture({rows,now}),s=createArchiveCursorSession({scope:cursorScope(args)});
 const expected=rows.slice().sort((a,b)=>a.pubDate===b.pubDate?(BigInt(a.id)>BigInt(b.id)?-1:1):(a.pubDate>b.pubDate?-1:1));
 let saved;
 for(const page of [1,5,2,4,7]){
  assert.equal(s.open(page),true);const req=s.begin(),response=fixture.read({...args,cursor:req.cursor,revision:req.revision,lookahead:req.lookahead});
  assert.equal(s.accept(req,response),true);assert.deepEqual(response.items.map(x=>x.id),expected.slice((page-1)*10,page*10).map(x=>x.id));
  saved=response.window?.pages.find(x=>x.cursor)?.cursor||saved;
 }
 assert.throws(()=>fixture.read({...args,query:'different',cursor:saved}),/SCOPE_CHANGED/);
 fixture.setRevision('2');assert.throws(()=>fixture.read({...args,cursor:saved}),/INDEX_CHANGED/);
});
