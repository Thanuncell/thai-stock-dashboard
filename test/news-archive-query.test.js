'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsArchiveService}=require('../server/news-archive-service'),{createArchiveQuery}=require('../server/news-archive-query');
const {article}=require('./fixtures/news-evidence.cjs'),{dedupeNewsGroups,dedupeNewsItems}=require('../lib/broker-news');
test('WS7 groups reuse canonical identity, trusted evidence and existing dedup output',()=>{
 const date=new Date(Date.now()-60000).toISOString(),a=article({url:'https://thunhoon.com/article-ws7?fbclid=a',pubDate:date,matchedSymbols:['PTT']}),b=article({url:'https://thunhoon.com/article-ws7?gclid=b',pubDate:date,matchedSymbols:['OR']});
 const groups=dedupeNewsGroups([a,b]);assert.equal(groups.length,1);assert.equal(groups[0].first,a);assert.equal(groups[0].contributors.length,2);assert.deepEqual(groups.map(x=>x.item),dedupeNewsItems([a,b]));assert.deepEqual(new Set(groups[0].item.matchedSymbols),new Set(['PTT','OR']));
});
test('WS7 disabled index maintenance has no hidden database requests',async()=>{
 const query=createArchiveQuery({enabled:false,request:async()=>{throw Error('Unexpected query');}});assert.deepEqual(await query.refresh(),{enabled:false,pending:null});
});
test('WS7 read and write evidence modes share the same compatible query policy',async()=>{
 const policies=[];for(const mode of ['read','write']){
  const service=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'on',SETSCOPE_NEWS_EVIDENCE:mode},fetchImpl:async(_u,init)=>{policies.push(JSON.parse(init.body).p_policy);return Response.json({});}});
  await assert.rejects(service.list(),/NEWS_QUERY_RESPONSE_INVALID/);
 }assert.deepEqual(policies,['news-query-1:read:metadata','news-query-1:read:metadata']);
});
test('WS7 rejects missing totals instead of claiming success or zero news',async()=>{
 const service=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic',SETSCOPE_NEWS_ARCHIVE_QUERY:'on'},fetchImpl:async()=>Response.json({groups:[],pageKeys:[],featuredKeys:[],page:1,pageSize:10,countExact:true})});
 await assert.rejects(service.list(),/NEWS_QUERY_RESPONSE_INVALID/);
});
test('WS7 link-review exclusions are bounded read-only facts, never trusted article evidence',async()=>{
 const {createNewsLinkReview}=require('../server/news-link-review');let requests=0;const review=createNewsLinkReview({loadArticle:async value=>{requests++;return{response:new Response('',{status:404}),target:new URL(value)};}});
 const item={url:'https://www.kaohoon.com/news/ws7-negative',title:'PTT รายงานผลประกอบการ',pubDate:new Date().toISOString(),source:'kaohoon',sourceName:'ข่าวหุ้น'};
 const facts=await review.inspect(item);assert.equal(facts.link.status,'UNVERIFIED');assert.deepEqual(review.withheldUrls,[item.url]);assert.deepEqual(review.withheldUrls,[item.url]);assert.equal(requests,1);
});
test('WS7 revision conflicts are bounded and dirty work is not falsely acknowledged',async()=>{
 let calls=0;const query=createArchiveQuery({enabled:true,policy:'news-query-1:read:metadata',headers:x=>x,fromRow:x=>x,displayProject:x=>x,request:async path=>{calls++;return Response.json(path.endsWith('_work')?{sourceRevision:'1',indexRevision:'1',fingerprints:['pending'],rows:[]}:{sourceRevision:'2',indexRevision:'1',groups:[],rows:[]});}});
 const result=await query.refresh({maxBatches:2});assert.equal(result.pending,true);assert.equal(result.conflicts,2);assert.equal(calls,4);
});

test('WS7 coalesced maintenance does not acknowledge later dirty work as complete',async()=>{
 let release,started;const gate=new Promise(r=>{started=r;}),reply=new Promise(r=>{release=r;});let calls=0;
 const query=createArchiveQuery({enabled:true,policy:'news-query-1:read:metadata',headers:x=>x,request:async()=>{calls++;if(calls===1){started();await reply;return Response.json({fingerprints:[],rows:[]});}return Response.json({fingerprints:['arrived-later'],rows:[]});}});
 const first=query.refresh();await gate;const second=query.refresh();release();assert.equal((await first).pending,0);assert.equal((await second).pending,true);assert.equal(calls,2);
});

test('WS7 page reads preserve the original review cadence, including invalidation and expiry',async()=>{
 let time=1000,reviews=0,calls=0;const query=createArchiveQuery({enabled:true,policy:'fixture',now:()=>time,headers:x=>x,displayOverlays:()=>[],displayReview:async items=>{reviews++;return items;},request:async(_path,init)=>{calls++;const args=JSON.parse(init.body);return Response.json({groups:[],pageKeys:[],featuredKeys:[],page:args.p_page,pageSize:10,total:0,matchingTotal:0,countExact:true});}});
 await query.list({page:1});await query.list({page:2});await query.list({page:3});assert.equal(reviews,1);assert.equal(calls,3);
 time+=300001;await query.list({page:4});assert.equal(reviews,2);query.invalidateReview();await query.list({page:5});assert.equal(reviews,3);
});

test('WS7 SET cache overlays retain subject binding and expire without issuing article evidence',async()=>{
 const {createNewsLinkReview}=require('../server/news-link-review');let time=Date.now();const url='https://www.set.or.th/th/market/news-and-alert/newsdetails?id=ws7-overlay',pubDate=new Date(time-60000).toISOString(),item={url,title:'PTT แจ้งผลประกอบการและการลงทุน',pubDate,source:'settrade',sourceName:'SET'};
 const body='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:item.title,datePublished:pubDate,articleBody:'รายละเอียดการลงทุนจากบริษัทที่เปิดเผยข้อมูลอย่างเป็นทางการ '.repeat(8),about:{'@type':'Corporation',tickerSymbol:'PTT'}})+'</script>';
 const review=createNewsLinkReview({now:()=>time,registrySearch:async()=>[{symbol:'PTT',provider_symbol:'PTT.BK',provider:'Yahoo Finance',active:true,status:'verified'}],loadArticle:async()=>({response:new Response(body,{headers:{'content-type':'text/html'}}),target:new URL(url)})});
 await review.inspect(item);assert.deepEqual(review.queryOverlays,[{url,title:item.title,published_at:pubDate,source:'settrade',source_name:'SET',symbols:['PTT']}]);assert.equal(review.project(item).articleVerified,undefined);
 time+=21600001;assert.deepEqual(review.queryOverlays,[]);
});
