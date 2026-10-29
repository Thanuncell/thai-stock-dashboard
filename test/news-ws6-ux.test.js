'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsArchiveService,MAX_ARCHIVE_SCAN_ROWS}=require('../server/news-archive-service');
const date=new Date(Date.now()-60000).toISOString();
const items=[
 {title:'PTT ข่าวลงทุน A',source:'other',sourceName:'กรุงเทพธุรกิจ',url:'https://news.google.com/rss/articles/ws6-a'},
 {title:'PTT ข่าวลงทุน B',source:'other',sourceName:'Investing.com',url:'https://news.google.com/rss/articles/ws6-b'},
 {title:'PTT ข่าวลงทุน C',source:'other',sourceName:'ฐานเศรษฐกิจ',url:'https://news.google.com/rss/articles/ws6-c'},
 {title:'PTT ข่าวลงทุน D',source:'infoquest',sourceName:'InfoQuest',url:'https://news.google.com/rss/articles/ws6-d',brokerCategory:true}
].map(x=>({...x,pubDate:date,snippet:'บริษัทเผยรายละเอียดผลประกอบการและการลงทุนตามข่าวต้นทาง',verification:{status:'VERIFIED',basis:'metadata'}}));
test('WS6: multi-publisher OR includes other storage sources and ignores discovery pathway',async()=>{
 const d=await import('../client/domain.mjs');
 assert.deepEqual(d.selectNewsForDisplay(items,{source:'bangkokbiznews,thansettakij',featuredCount:0}).filtered.map(x=>x.title),[items[0].title,items[2].title]);
 assert.equal(d.selectNewsForDisplay([{...items[1],discoverySource:'bangkokbiznews'}],{source:'bangkokbiznews'}).filtered.length,0);
 assert.equal(d.selectNewsForDisplay(items,{source:'investing,broker',featuredCount:0}).filtered.length,2);
 assert.equal(d.selectNewsForDisplay(items,{source:'other',featuredCount:0}).filtered.length,3);
});
test('WS6: multi-source navigation is canonical and old single-source URLs remain compatible',async()=>{
 const d=await import('../client/domain.mjs');
 const state=d.parseNavigationState('https://fixture.invalid/?source=thansettakij&source=bangkokbiznews&newsPage=4#news');
 assert.equal(state.source,'bangkokbiznews,thansettakij');assert.equal(d.navigationUrl(state),'/?source=bangkokbiznews%2Cthansettakij&newsPage=4#news');
 assert.equal(d.parseNavigationState('https://fixture.invalid/?source=infoquest#news').source,'infoquest');
 const watch=d.parseNavigationState('https://fixture.invalid/?source=investing,broker&watchPage=2#watchlist');
 assert.equal(watch.source,undefined);assert.equal(d.navigationUrl({...watch,source:'investing'}),'/?watchPage=2#watchlist');
});
test('WS6: compact page ranges stay bounded and clamp invalid numbers',async()=>{
 const {pageList}=await import('../client/domain.mjs');
 for(const total of [0,1,10,11,20,101,1001])for(const page of [0,1,5,50,total,total+10]){
  const list=pageList(page,total),numbers=list.filter(Number.isInteger);
  assert.ok(numbers.length<=10);assert.ok(numbers.every(x=>x>=1&&x<=total));assert.equal(new Set(numbers).size,numbers.length);
  if(total)assert.ok(numbers.includes(Math.max(1,Math.min(total,page||1))));
 }
});
test('WS6: archive union, quality, dedup and featured exclusions count before pagination without writes',async()=>{
 const rows=items.flatMap((item,i)=>Array.from({length:12},(_,n)=>({fingerprint:'ws6-'+i+'-'+n,title:item.title+' '+n,url:item.url+'-'+n,source:item.source,source_name:item.sourceName,snippet:item.snippet,published_at:date,matched_symbols:['PTT'],broker_firms:item.brokerCategory?['KS']:[]})));
 rows.push({...rows[0],fingerprint:'duplicate',url:rows[0].url+'?utm_source=rss'});
 rows.push({...rows[0],fingerprint:'document',url:'https://www.set.or.th/ws6.pdf',title:'notice.pdf'});
 let calls=0;const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic'},fetchImpl:async(_u,init={})=>{
  assert.equal(init.method||'GET','GET');calls++;return Response.json(rows,{headers:{'content-range':'0-'+(rows.length-1)+'/'+rows.length}});
 }});
 const result=await archive.list({source:'bangkokbiznews,thansettakij',featuredCount:5,page:999,pageSize:10,clampPage:true});
 assert.equal(result.total,19);assert.equal(result.matchingTotal,24);assert.equal(result.featured.length,5);assert.equal(result.page,2);assert.equal(result.items.length,9);assert.equal(result.countExact,true);
 assert.ok([...result.featured,...result.items].every(x=>['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ'].includes(x.sourceName)));
 assert.equal((await archive.list({source:'broker,investing'})).total,24);assert.equal(calls,1);assert.equal(MAX_ARCHIVE_SCAN_ROWS,20000);
});

test('WS6: filtering never upgrades metadata; article-only gate counts persisted trusted articles',async()=>{
 const d=await import('../client/domain.mjs'),{article,memoryTransport}=require('./fixtures/news-evidence.cjs');
 assert.equal(d.selectNewsForDisplay(items,{source:'bangkokbiznews,investing,thansettakij',hardGate:true}).filtered.length,0);
 const db=memoryTransport(),archive=db.service(),verified=[article({title:'PTT ข่าวจริงที่ตรวจบทความแล้ว',source:'infoquest',sourceName:'InfoQuest',url:'https://www.infoquest.co.th/news/123'}),article({title:'PTT ข่าวอีกบทความที่ตรวจแล้ว',url:'https://thunhoon.com/article-ws6-verified'})];
 await archive.ingest(verified);const before=JSON.stringify([...db.rows.values()]);
 const result=await archive.list({source:'infoquest,thunhoon',featuredCount:1});assert.equal(result.total,1);assert.equal(result.matchingTotal,2);assert.equal(result.countExact,true);
 assert.equal(d.selectNewsForDisplay([...items,...verified],{source:'infoquest,thunhoon',hardGate:true,featuredCount:0}).filtered.length,2);
 assert.equal(JSON.stringify([...db.rows.values()]),before);
 const cleared=d.parseNavigationState('https://fixture.invalid/#news',{query:'old',source:'investing',newsPage:20});assert.equal(cleared.source,'all');assert.equal(cleared.query,'');assert.equal(cleared.newsPage,1);
});

test('WS6: malformed cached entries cannot break source filtering or inflate counts',async()=>{
 const d=await import('../client/domain.mjs');
 assert.equal(d.selectNewsForDisplay([null,1,'invalid',...items],{source:'bangkokbiznews',featuredCount:0}).filtered.length,1);
});

test('WS6: an unconfirmed archive coverage total never claims an exact global count',async()=>{
 const row={fingerprint:'unknown-total',title:'PTT รายงานข้อมูลธุรกิจล่าสุด',url:'https://news.google.com/rss/articles/ws6-unknown-total',source:'infoquest',source_name:'InfoQuest',snippet:'บริษัทเผยรายละเอียดข่าวและการลงทุนตามต้นทาง',published_at:date,matched_symbols:[],broker_firms:[]};
 const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic'},fetchImpl:async()=>Response.json([row],{headers:{'content-range':'0-0/*'}})});
 const result=await archive.list();assert.equal(result.items.length,1);assert.equal(result.countExact,false);assert.equal(result.countCoverage,'loaded-archive-snapshot');
});

test('WS6: incomplete snapshot preserves page totals and ordered slices without claiming global coverage',async()=>{
 const rows=Array.from({length:125},(_,i)=>({fingerprint:'partial-'+i,title:'PTT ข่าวผลประกอบการ '+i,url:'https://news.google.com/rss/articles/ws6-partial-'+i,source:'infoquest',source_name:'InfoQuest',snippet:'บริษัทเปิดเผยข้อมูลผลประกอบการและรายละเอียดการลงทุน',published_at:new Date(Date.parse(date)-i*1000).toISOString(),matched_symbols:['PTT'],broker_firms:[]}));
 let reads=0;const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic'},fetchImpl:async(_u,init={})=>{assert.equal(init.method||'GET','GET');reads++;return Response.json(rows,{headers:{'content-range':'0-124/*'}});}});
 for(const page of [1,2,3,12]){
  const result=await archive.list({page,featuredCount:5,clampPage:true});
  assert.equal(result.countExact,false);assert.equal(result.total,120);assert.equal(result.page,page);assert.equal(result.items.length,10);
  assert.deepEqual(result.items.map(x=>x.title),rows.slice(5+(page-1)*10,5+page*10).map(x=>x.title));
 }
 const clamped=await archive.list({page:999,featuredCount:5,clampPage:true});assert.equal(clamped.page,12);assert.equal(clamped.items.length,10);assert.equal(reads,1);
});
