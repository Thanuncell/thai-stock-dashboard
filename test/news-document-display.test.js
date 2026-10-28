'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {createNewsArchiveService}=require('../server/news-archive-service');
const {article,memoryTransport}=require('./fixtures/news-evidence.cjs');
const {reviewNewsItem}=require('../lib/news-quality');
const date=new Date(Date.now()-60000).toISOString();
const good=()=>article({title:'PTT เปิดตัวคู่มือ PDF สำหรับนักลงทุน',matchedSymbols:['PTT']});
const documents=()=>[
 {title:'notice.pdf - SET - SET',url:'https://news.google.com/rss/articles/document',source:'settrade',sourceName:'SET'},
 {title:'รายงานต้นฉบับ',url:'https://thunhoon.com/report%2Epdf',source:'thunhoon',sourceName:'Thunhoon'},
 {title:'เอกสารที่ระบุประเภทไว้แล้ว',url:'https://thunhoon.com/opaque-document',source:'thunhoon',sourceName:'Thunhoon',contentType:'OTHER_DOCUMENT'},
 {title:'ประกาศจากข้อมูลเก่า',url:'https://www.set.or.th/opaque-document',source:'settrade',sourceName:'SET',contentType:'OFFICIAL_DOCUMENT'}
].map(x=>({...x,pubDate:date,matchedSymbols:['PTT'],snippet:'Synthetic document metadata only',verification:{status:'VERIFIED',basis:'metadata'}}));

for(const hardGate of [false,true]){
 test('display/cache filter excludes all document kinds without changing evidence, gate '+hardGate,()=>{
  const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:hardGate?'on':'off'}});
  const input={items:[...documents(),article({title:'PTT เอกสารที่ระบุประเภท',contentType:'OTHER_DOCUMENT'}),good()],total:6},before=JSON.stringify(input);
  for(let i=0;i<2;i++){const result=service.filterForDisplay(input);assert.equal(result.items.length,1);assert.equal(result.items[0].title,good().title);assert.equal(result.total,1);}
  assert.equal(JSON.stringify(input),before);assert.equal(service.quarantineReport().some(x=>x.status==='REJECTED'),false);
 });
 test('cached client selectors exclude documents from Featured/Latest/Archive/Watchlist, gate '+hardGate,async()=>{
  const domain=await import('../client/domain.mjs'),items=[...documents(),article({title:'PTT เอกสารที่ระบุประเภท',contentType:'OFFICIAL_DOCUMENT'}),good()],before=JSON.stringify(items);
  assert.equal(domain.selectNewsForDisplay(items,{hardGate}).featured.length,1);
  const latest=domain.selectNewsForDisplay(items,{hardGate,featuredCount:0});assert.equal(latest.latest.length,1);assert.equal(latest.filtered.length,1);
  assert.equal(domain.retainWatchlistNews(items,[{symbol:'PTT'}],Date.now(),{hardGate}).length,1);
  assert.equal(JSON.stringify(items),before);
 });
 test('watchlist fresh and cached results omit documents without rejecting stored metadata, gate '+hardGate,async()=>{
  const valid=good(),url=valid.url,title=valid.title;
  const doc={title:'PTT-notice.pdf - SET - SET',url:'https://news.google.com/rss/articles/watch-document',sourceName:'SET'};
  const xml='<rss><channel>'+[doc,{title,url,sourceName:'Thunhoon'}].map(x=>'<item><title>'+x.title+'</title><link>'+x.url+'</link><pubDate>'+date+'</pubDate><description>PTT เปิดเผยรายละเอียดสำหรับนักลงทุน</description><source>'+x.sourceName+'</source></item>').join('')+'</channel></rss>';
  const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:date,articleBody:'PTT synthetic article body for watchlist verification. '.repeat(5)})+'</script>';
  let rssCalls=0;
  const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:hardGate?'on':'off'},fetchImpl:async input=>{
   if(String(input).includes('/rss/search?')){rssCalls++;return new Response(xml);}
   assert.equal(String(input),url);return new Response(html,{headers:{'content-type':'text/html'}});
  }});
  for(let i=0;i<2;i++){const result=await service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'synthetic-owner'});assert.equal(result.total,1);assert.equal(result.items[0].title,title);assert.equal(result.stockStatus[0].retained,1);}
  assert.equal(rssCalls,1);assert.equal(service.quarantineReport().some(x=>x.url===doc.url&&x.status==='REJECTED'),false);
 });
 test('archive filters before count/featured/pagination and leaves durable rows untouched, gate '+hardGate,async()=>{
  const db=memoryTransport(),env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:hardGate?'on':'off'};
  const archive=createNewsArchiveService({env,fetchImpl:db.fetchImpl});
  const docs=documents().slice(0,2).map(x=>{const item={...x};delete item.verification;item.verification=reviewNewsItem(item);return item;});
  const news=Array.from({length:3},(_,i)=>article({title:good().title+' '+i,url:'https://thunhoon.com/article-page-'+i,matchedSymbols:['PTT']}));
  await archive.ingest([...docs,...news]);for(const row of db.rows.values()){row.analysis_summary='Preserved stored AI';row.analysis_mode='ai';}
  const before=JSON.stringify([...db.rows.values()]);db.calls.length=0;
  const urls=[];
  for(let page=1;page<=3;page++){const result=await archive.list({page,pageSize:1});assert.equal(result.total,3);assert.equal(result.items.length,1);assert.equal(result.qualityFiltered,2);urls.push(result.items[0].url);}
  assert.equal(new Set(urls).size,3);assert.equal((await archive.list({page:4,pageSize:1})).items.length,0);
  const featured=await archive.list({featuredCount:1,pageSize:1});assert.equal(featured.featured.length,1);assert.equal(featured.total,2);
  assert.equal((await archive.list({symbol:'PTT'})).total,3);
  assert.equal(JSON.stringify([...db.rows.values()]),before);assert.ok(db.calls.every(x=>!x.init.method||x.init.method==='GET'));
 });
}
