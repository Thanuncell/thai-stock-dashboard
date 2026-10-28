'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const quality=require('../lib/news-quality'),{inspectNewsArticle}=require('../lib/news-article');
const {article,env,memoryTransport}=require('./fixtures/news-evidence.cjs');
const {createNewsService}=require('../server/news-service');
const gate=(item,options)=>quality.reviewNewsForDisplay?quality.reviewNewsForDisplay(item,options):quality.reviewNewsItem(item);
const title='PTT รายงานผลประกอบการและแผนลงทุนล่าสุด';
const date=new Date(Date.now()-60000).toISOString();
const body='บริษัทเปิดเผยรายละเอียดผลประกอบการ แผนการลงทุน และข้อมูลการดำเนินงานที่ตรวจสอบได้จากบทความต้นฉบับ '.repeat(4);
const rss=items=>'<rss><channel>'+items.map(x=>'<item><title>'+x.title+'</title><link>'+x.url+'</link><pubDate>'+x.pubDate+'</pubDate><description>'+body+'</description><source>Thunhoon</source></item>').join('')+'</channel></rss>';
test('P1: metadata acceptance alone never authorizes display',()=>assert.notEqual(gate({title,url:'https://thunhoon.com/article-123456',source:'thunhoon',sourceName:'Thunhoon',snippet:body,pubDate:date}).status,'VERIFIED'));
for(const [name,changes] of [
 ['PDF filename',{title:'Quarterly_Report_2026.pdf'}],['PDF URL',{url:'https://thunhoon.com/files/report.pdf'}],
 ['slug with snippet and article-shaped URL',{title:'ptt-profit-investment-update'}],
 ['future publication',{pubDate:'2099-01-01T00:00:00Z'}],['wrong publisher',{sourceName:'Kaohoon'}]
])test('P1: '+name+' cannot display even with a bound positive claim',()=>{const item=article(changes);assert.notEqual(gate(item).status,'VERIFIED');});
test('P1: a caller-supplied article VERIFIED is not trusted',()=>{const good=article();assert.notEqual(gate({...good,verification:{...good.verification}}).status,'VERIFIED');assert.equal(gate(good).status,'VERIFIED');});
test('P1: archive hides metadata-only/legacy records before Featured/count without modifying rows',async()=>{
 const db=memoryTransport();const good=article({title});await db.service().ingest([good]);
 const stored=[...db.rows.values()][0];db.rows.set('legacy',{...stored,...Object.fromEntries(Object.keys(stored).filter(k=>k.startsWith('verification_')||k.startsWith('canonical_')).map(k=>[k,k==='verification_revision'?0:null])),fingerprint:'legacy',url:'https://thunhoon.com/article-legacy'});
 const before=structuredClone([...db.rows.values()]);const listed=await db.service().list({featuredCount:1});assert.equal(listed.featured.length,1);assert.equal(listed.total,0);assert.deepEqual([...db.rows.values()],before);
});
test('P1: strict extraction refuses missing or contradictory publication evidence',()=>{
 const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:'https://thunhoon.com/article-123456',headline:title,articleBody:body})+'</script>';
 assert.notEqual(inspectNewsArticle(html,{url:'https://thunhoon.com/article-123456',title,pubDate:date,strict:true}).status,'VERIFIED');
});
test('P1: write-mode discovery verifies every publisher and quarantines PDFs without budget escape',async()=>{
 const items=[{title,url:'https://thunhoon.com/article-123456',pubDate:date},{title:'report.pdf',url:'https://thunhoon.com/files/report.pdf',pubDate:date}];let probes=0;
 const service=createNewsService({env,fetchImpl:async value=>{if(String(value).includes('/rss/search?'))return new Response(rss(items));probes++;return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:items[0].url,headline:title,datePublished:date,articleBody:body})+'</script>',{headers:{'content-type':'text/html'}});}});
 const news=await service.getNews();assert.equal(news.items.length,1);assert.equal(news.items[0].verification.basis,'article');assert.equal(probes,1);assert.ok(service.quarantineReport().some(x=>x.title==='report.pdf'));
});
test('P1: browser selectors reject missing, metadata and negative claims before Featured/Latest',async()=>{
 const d=await import('../client/domain.mjs');const valid={title,url:'https://thunhoon.com/article-123456',pubDate:date,source:'thunhoon',sourceName:'Thunhoon',verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};
 const selected=d.selectNewsForDisplay([valid,{...valid,url:valid.url+'a',verification:undefined},{...valid,url:valid.url+'b',verification:{status:'VERIFIED',basis:'metadata'}},{...valid,url:valid.url+'c',verification:{status:'REJECTED'}}]);
 assert.equal(selected.filtered.length,1);
});

test('P1: article verification also supports the existing Kaohoon source',async()=>{
 const url='https://www.kaohoon.com/news/123456';
 const service=createNewsService({env,fetchImpl:async value=>{
  if(String(value).includes('/rss/search?'))return new Response(rss([{title,url,pubDate:date}]).replaceAll('Thunhoon','ข่าวหุ้น'));
  return new Response('<link rel="canonical" href="'+url+'"><article><h1>'+title+'</h1><time datetime="'+date+'"></time><p>'+body+'</p></article>',{headers:{'content-type':'text/html'}});
 }});
 const result=await service.getNews();assert.equal(result.items.length,1);assert.equal(result.items[0].source,'kaohoon');assert.equal(result.items[0].verification.basis,'article');
});
test('P1: shared quarantine fences stale feed and cached archive without downgrading stored evidence',async()=>{
 const quarantine=new Map();let bad=false;
 const item={title,url:'https://thunhoon.com/article-123456',pubDate:date};
 const service=createNewsService({env,quarantine,fetchImpl:async value=>{
  if(String(value).includes('/rss/search?'))return new Response(rss([{...item,title:bad?'PTT เรื่องอื่นที่ยังไม่ได้พิสูจน์':title}]));
  if(bad)return new Response('upstream unavailable',{status:503});
  return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:item.url,headline:title,datePublished:date,articleBody:body})+'</script>',{headers:{'content-type':'text/html'}});
 }});
 const good=await service.getNews();assert.equal(good.items.length,1);
 const db=memoryTransport();await db.service().ingest([article({title,pubDate:date})]);const original=structuredClone([...db.rows.values()]);
 const {createNewsArchiveService}=require('../server/news-archive-service');const archive=createNewsArchiveService({env,quarantine,fetchImpl:db.fetchImpl});
 assert.equal((await archive.list()).total,1);bad=true;
 assert.equal((await service.getNews()).items.length,0);
 assert.equal(service.filterForDisplay(good).items.length,0);
 assert.equal((await archive.list({featuredCount:1})).items.length,0);
 assert.deepEqual([...db.rows.values()],original);assert.equal(original[0].verification_status,'VERIFIED');
});
test('P1: RSS-only OR mention does not authorize stock association absent from the article',async()=>{
 const xml='<rss><channel><item><title>'+title+'</title><link>https://thunhoon.com/article-123456</link><pubDate>'+date+'</pubDate><description>หุ้น OR รายงานผลประกอบการ</description><source>Thunhoon</source></item></channel></rss>';
 const service=createNewsService({env,fetchImpl:async value=>String(value).includes('/rss/search?')?new Response(xml):new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:'https://thunhoon.com/article-123456',headline:title,datePublished:date,articleBody:body})+'</script>',{headers:{'content-type':'text/html'}})});
 const result=await service.getWatchlistNews([{symbol:'OR'}],{ownerId:'A'});assert.equal(result.items.length,0);assert.ok(service.quarantineReport().some(x=>x.reason==='STOCK_IDENTITY_UNVERIFIED'));
});
test('P1: a serialized positive cannot cross the shared server response gate',()=>{
 const service=createNewsService({env});const valid=article({title});
 assert.equal(gate(null).status,'UNVERIFIED');assert.equal(service.filterForDisplay({items:[null,valid]}).items.length,1);
 assert.equal(service.filterForDisplay({items:[valid]}).items.length,1);
 assert.equal(service.filterForDisplay({items:[JSON.parse(JSON.stringify(valid))]}).items.length,0);
});
test('P1: negative and unknown cached article claims cannot reach browser retention',async()=>{
 const d=await import('../client/domain.mjs');const valid={title,url:'https://thunhoon.com/article-123456',pubDate:date,matchedSymbols:['PTT'],verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}};
 assert.equal(d.retainWatchlistNews([valid,{...valid,url:valid.url+'x',verification:{status:'UNVERIFIED'}}],[{symbol:'PTT'}]).length,1);
 assert.equal(d.canDisplayNews({...valid,url:'https://untrusted.example/news/1'}),false);
});

test('P1: legacy article proof without publication evidence remains stored VERIFIED but is held for review',async()=>{
 const db=memoryTransport(),item=article();await db.service().ingest([item]);const row=[...db.rows.values()][0];
 delete row.verification_provenance.displayPolicy;delete row.verification_provenance.articlePublishedAt;
 const before=structuredClone(row);assert.equal((await db.service().list()).items.length,0);assert.deepEqual([...db.rows.values()][0],before);assert.equal(row.verification_status,'VERIFIED');
});
test('P1: persisted publication evidence cannot be detached from its subject date',async()=>{
 const db=memoryTransport();await db.service().ingest([article()]);const row=[...db.rows.values()][0];row.verification_provenance.articlePublishedAt='2020-01-01T00:00:00Z';
 assert.equal((await db.service().list()).items.length,0);assert.equal(row.verification_status,'VERIFIED');
});

test('P1: a response never exports another scope quarantine URLs',()=>{
 const quarantine=new Map(),service=createNewsService({env,quarantine});
 const a=article({url:'https://thunhoon.com/article-owner-a',title});
 service.filterForDisplay({items:[JSON.parse(JSON.stringify(a))]});
 const b=article({url:'https://thunhoon.com/article-owner-b',title});
 const response=service.filterForDisplay({items:[b]});assert.equal(response.items.length,1);assert.equal(response.withheldUrls,undefined);
});

test('P1: timezone-free publication time is held rather than inferred from the server timezone',()=>{
 const url='https://thunhoon.com/article-123456',html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:'2026-10-28T09:00:00',articleBody:body})+'</script>';
 assert.equal(inspectNewsArticle(html,{url,title,strict:true}).status,'UNVERIFIED');
});
