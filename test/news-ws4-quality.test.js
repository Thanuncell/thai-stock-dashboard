'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {article,memoryTransport}=require('./fixtures/news-evidence.cjs');
const {dedupeNewsItems,newsFingerprint}=require('../lib/broker-news');
const {mergeStockNews}=require('../server/watchlist-news');
const {reviewNewsItem}=require('../lib/news-quality');
const {createNewsService}=require('./fixtures/news-service.cjs');
const base='https://thunhoon.com/article-ws4-quality';
const candidates=()=>[
 article({url:base+'?id=1&fbclid=old&utm_source=rss',matchedSymbols:['PTT']}),
 article({url:base+'?id=1&gclid=new',matchedSymbols:['PTT']})
];
test('WS4: browser and server agree on tracking-only URL variants',async()=>{
 const domain=await import('../client/domain.mjs'),items=candidates();
 assert.equal(dedupeNewsItems(items).length,1);
 assert.equal(domain.newsKey(items[0]),domain.newsKey(items[1]));
 assert.equal(domain.selectNewsForDisplay(items,{featuredCount:0}).latest.length,1);
});
test('WS4: watchlist reuses canonical grouping rather than persisted fingerprint identity',()=>{
 assert.equal(mergeStockNews(candidates(),[{symbol:'PTT'}],Date.now()).length,1);
});
test('WS4: archive excludes the canonical equivalent of a featured URL before counting',async()=>{
 const db=memoryTransport(),archive=db.service(),item=candidates()[0];await archive.ingest([item]);
 const before=JSON.stringify([...db.rows.values()]);
 const result=await archive.list({excludeUrls:[base+'?id=1']});
 assert.equal(result.total,0);assert.equal(result.items.length,0);assert.equal(JSON.stringify([...db.rows.values()]),before);
});
test('WS4: verified SETTRADE article is not rejected solely by a reference-like headline',()=>{
 const item=article({title:'PTT - กรรมการบริษัท - SETTRADE',url:'https://www.settrade.com/th/news-and-articles/news/123456',source:'settrade',sourceName:'SETTRADE'});
 assert.equal(item.verification.status,'VERIFIED');
 assert.equal(reviewNewsItem(item).status,'VERIFIED');
});
test('WS4: known non-article display projection cannot reach AI analysis',async()=>{
 let ai=0;
 const item=article({title:'PTT รายงานการแต่งตั้งกรรมการบริษัท',url:base,snippet:'บริษัท PTT ประกาศแต่งตั้งกรรมการและแผนลงทุนตามข่าวต้นฉบับ'});
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-fixture'},logger:{warn(){}},
  displayProject:value=>({...value,linkVerification:{status:'REJECTED',kind:'NON_ARTICLE',reason:'ARTICLE_NOT_FOUND'}}),
  fetchImpl:async input=>{if(String(input).includes('api.openai.com')){ai++;return Response.json({output_text:'{}'});}return new Response('<article>'+'บริษัท PTT รายงานข่าวการลงทุนตามต้นฉบับ '.repeat(20)+'</article>',{headers:{'content-type':'text/html'}});}
 });
 await service.analyse([item]);assert.equal(ai,0);
});

test('WS4: 404/410 article responses cannot fall back to AI input',async()=>{
 for(const status of [404,410]){
  let ai=0;const item=article({url:base,snippet:'บริษัท PTT เปิดเผยข้อมูลข่าวและแผนลงทุนตามบทความต้นฉบับ'});
  const before=JSON.stringify(item);
  const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-fixture'},logger:{warn(){}},fetchImpl:async input=>{
   if(String(input).includes('api.openai.com')){ai++;return Response.json({output_text:'{}'});}return new Response('Not found',{status,headers:{'content-type':'text/html'}});
  }});
  await service.analyse([item]);assert.equal(ai,0);assert.equal(JSON.stringify(item),before);
 }
});
test('WS4: analysis results preserve input positions when a known non-article is blocked',async()=>{
 const first=article({url:base+'-missing',snippet:'ข่าวต้นฉบับจากรายการแรกที่ตรวจแล้วว่าไม่ใช่บทความ'});
 const second=article({url:base+'-good',snippet:'ข่าวต้นฉบับจากรายการที่สองซึ่งมีเนื้อหาข่าวจริง'});
 const service=createNewsService({env:{},displayProject:x=>x.url===first.url?{...x,linkVerification:{status:'REJECTED',kind:'NON_ARTICLE'}}:x});
 const result=await service.analyse([first,second]);assert.equal(result.items.length,2);assert.equal(result.items[0].mode,'unavailable');assert.equal(result.items[1].mode,'rules');
});
for(const title of ['รายชื่อผู้ถือหุ้น - SETTRADE','ข้อมูลบริษัท - SETTRADE']){
 test('WS4: actual SETTRADE article evidence survives reference-like title '+title,()=>{
  const item=article({title,url:'https://www.settrade.com/th/news-and-articles/news/123456',source:'settrade',sourceName:'SETTRADE'});
  assert.equal(reviewNewsItem(item).status,'VERIFIED');
 });
}
test('WS4: equivalent archived variants retain stored AI and first seen in the displayed copy',async()=>{
 const db=memoryTransport(),date=new Date(Date.now()-60000).toISOString();
 const a=article({url:base+'?fbclid=old',pubDate:date}),b=article({url:base+'?gclid=new',pubDate:date});
 await db.service().ingest([a,b]);
 const rows=[...db.rows.values()];rows[0].analysis_summary='Stored synthetic AI';rows[0].analysis_mode='ai';rows[0].first_seen_at=new Date(Date.now()-86400000).toISOString();
 db.rows.delete(rows[0].fingerprint);db.rows.set(rows[0].fingerprint,rows[0]);
 const before=JSON.stringify([...db.rows.values()]);const result=await db.service().list();
 assert.equal(result.total,1);assert.equal(result.items[0].analysisMode,'ai');assert.equal(result.items[0].analysisSummary,'Stored synthetic AI');
 assert.equal(result.items[0].firstSeenAt,rows[0].first_seen_at);assert.equal(JSON.stringify([...db.rows.values()]),before);
});

test('WS4: proven reference URLs remain blocked at server and cached browser display boundaries',async()=>{
 const domain=await import('../client/domain.mjs');
 const service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'off'}});
 for(const url of ['https://www.set.or.th/th/about/careers','https://www.settrade.com/th/equities/quote/PTT/company-profile','https://thunhoon.com/login','https://kaohoon.com/news/page/2']){
  const item={title:'ข่าวข้อมูลหลักทรัพย์ล่าสุด',url,source:'other',sourceName:'ข่าว',snippet:'ข้อมูลข่าวที่บันทึกไว้ในแคชจากระบบรุ่นเดิม',pubDate:new Date().toISOString(),verification:{status:'VERIFIED',basis:'metadata'}};
  assert.equal(service.filterForDisplay({items:[item]}).items.length,0);
  assert.equal(domain.canDisplayNews(item,Date.now(),{hardGate:false}),false);
 }
});
test('WS4: fixture dedup precision preserves semantic URL differences and same-headline events',async()=>{
 const domain=await import('../client/domain.mjs'),date=new Date(Date.now()-60000).toISOString();
 const duplicates=[
  [base,base+'#section'],[base+'?utm_source=a',base+'?utm_source=b'],
  [base+'?fbclid=a',base+'?gclid=b'],[base+'?x=1&y=2',base+'?y=2&x=1'],
  [base,base+'/'],[base,base.replace('https://','https://www.')]
 ];
 const distinct=[
  [base+'?id=1',base+'?id=2'],[base+'?part=1',base+'?part=2'],
  [base+'?ref=A',base+'?ref=B'],[base+'?tag=A&tag=B',base+'?tag=B&tag=A'],
  [base,base+'-another-event'],[base,base.replace('thunhoon.com','kaohoon.com')],
  [base,base.replace('article-ws4','Article-ws4')],
  ['https://news.google.com/rss/articles/opaque-A','https://news.google.com/rss/articles/opaque-B']
 ];
 for(const [a,b]of duplicates){
  const items=[a,b].map(url=>article({url,pubDate:date,matchedSymbols:['PTT']}));
  assert.equal(dedupeNewsItems(items).length,1);assert.equal(domain.selectNewsForDisplay(items,{featuredCount:0}).latest.length,1);
 }
 for(const [a,b]of distinct){
  const items=[a,b].map(url=>({...article({url,pubDate:date}),canonicalUrl:base}));
  assert.equal(dedupeNewsItems(items).length,2);assert.equal(domain.selectNewsForDisplay(items,{featuredCount:0}).latest.length,2);
 }
});

test('WS4: article keywords are not blanket rejection rules and metadata never becomes article proof',()=>{
 const {classifyNewsItem}=require('../lib/news-quality');
 const headlines=['PTT แต่งตั้งกรรมการบริษัทคนใหม่','บริษัทแจ้งรายชื่อผู้ถือหุ้นและวันประชุม','SET เปิดรับสมัครงานพร้อมขยายทีมวิเคราะห์','บทสัมภาษณ์กรรมการและผู้ถือหุ้นเรื่องทิศทางบริษัท'];
 for(const title of headlines){
  const item={title,url:base,source:'thunhoon',sourceName:'Thunhoon',pubDate:new Date().toISOString(),snippet:'บริษัทเปิดเผยรายละเอียดข่าวและเนื้อหาที่ตรวจสอบได้จากต้นทาง'};
  assert.equal(classifyNewsItem(item).decision,'ACCEPT');assert.equal(reviewNewsItem(item).basis,'metadata');
 }
 const unclear={title:'รายชื่อผู้ถือหุ้น - SETTRADE',url:'https://www.settrade.com/th/news-and-articles/news/123456',source:'settrade',sourceName:'SETTRADE',pubDate:new Date().toISOString(),verification:{status:'VERIFIED',basis:'article'}};
 assert.equal(classifyNewsItem(unclear).decision,'AMBIGUOUS');assert.equal(reviewNewsItem(unclear).status,'UNVERIFIED');
});
test('WS4: 403/429 and transient failures remain uncertainty, not article-not-found evidence',async()=>{
 for(const status of [403,429,503]){
  const service=createNewsService({env:{},fetchImpl:async()=>new Response('',{status})});
  const item=article({url:base,snippet:'บริษัทเผยรายละเอียดข่าวจากบทความต้นฉบับ'});
  const before=JSON.stringify(item),result=await service.extractArticle(item);
  assert.equal(result.state,'UNVERIFIED');assert.notEqual(result.reason,'ARTICLE_NOT_FOUND');assert.equal(JSON.stringify(item),before);
 }
 const service=createNewsService({env:{},fetchImpl:async()=>{throw Object.assign(Error('synthetic timeout'),{name:'TimeoutError'});}});
 const result=await service.extractArticle(article({url:base}));assert.equal(result.state,'UNVERIFIED');assert.notEqual(result.reason,'ARTICLE_NOT_FOUND');
});

test('WS4: production display projector keeps null/scalar analysis positions safe',async()=>{
 const projector=require('../server/news-link-review').createNewsLinkReview({loadArticle:async()=>({reason:'ARTICLE_NOT_VERIFIED'})});
 const service=createNewsService({env:{},displayProject:projector.project});
 const result=await service.analyse([null,1,'invalid']);assert.equal(result.items.length,3);assert.ok(result.items.every(x=>x.mode==='unavailable'));
});
test('WS4: confirmed PDF response is excluded from AI without rejecting stored news evidence',async()=>{
 let ai=0;const item=article({url:base,snippet:'บริษัท PTT เปิดเผยรายละเอียดประกาศที่บันทึกไว้ตามต้นทาง'}),before=JSON.stringify(item);
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-fixture'},logger:{warn(){}},fetchImpl:async input=>{
  if(String(input).includes('api.openai.com')){ai++;return Response.json({output_text:'{}'});}
  return new Response('%PDF synthetic',{headers:{'content-type':'application/pdf'}});
 }});
 const result=await service.analyse([item]);assert.equal(ai,0);assert.equal(result.items[0].mode,'unavailable');assert.equal(JSON.stringify(item),before);
});

test('WS4: cached canonical copies retain AI only for the same content version',async()=>{
 const domain=await import('../client/domain.mjs'),a=article({url:base+'?fbclid=first'}),b={...a,url:base+'?gclid=second',analysisMode:'ai',analysisSummary:'Stored cache AI'};
 const result=domain.selectNewsForDisplay([a,b],{featuredCount:0});assert.equal(result.latest.length,1);assert.equal(result.latest[0].analysisSummary,'Stored cache AI');
 const changed={...b,title:'Different updated article title'};assert.equal(domain.selectNewsForDisplay([a,changed],{featuredCount:0}).latest[0].title,a.title);
});
