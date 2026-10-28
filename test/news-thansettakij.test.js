'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createThansettakijSource,parseThansettakijSitemap,SITEMAP}=require('../server/news-thansettakij');
const {createNewsService}=require('../server/news-service');
const {inspectNewsArticle}=require('../lib/news-article');
const {reviewNewsForDisplay}=require('../lib/news-quality');
const {publisherMatches,allowedNewsUrl,ROADMAP_NEWS_PUBLISHERS}=require('../lib/news-policy');
const {trustedEvidence}=require('../lib/news-evidence');
const {memoryTransport}=require('./fixtures/news-evidence.cjs');
const {newsSecuritySymbols,newsClickUrl}=require('../lib/news-content');
const date=new Date(Date.now()-60000).toISOString();
const item=(id=1234567,overrides={})=>({url:'https://www.thansettakij.com/finance/stock/'+id,title:'PTT รายงานกำไรและแผนลงทุนใหม่ '+id,pubDate:date,...overrides});
const esc=x=>x.replaceAll('&','&amp;').replaceAll('<','&lt;');
function sitemap(items=[item()]){return '<?xml version="1.0"?><urlset>'+items.map(x=>'<url><loc>'+esc(x.url)+'</loc><news:news><news:publication><news:name>Thansettakij</news:name></news:publication><news:title>'+esc(x.title)+'</news:title><news:publication_date>'+x.pubDate+'</news:publication_date></news:news></url>').join('')+'</urlset>';}
function article(news=item(),changes={}){
 const body='บริษัท PTT รายงานข้อมูลการดำเนินงานและแผนลงทุนที่ปรากฏในบทความต้นฉบับ '.repeat(4);
 return '<link rel="canonical" href="'+news.url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',mainEntityOfPage:{'@id':news.url},headline:news.title,datePublished:news.pubDate,...changes})+'</script><h1>'+news.title+'</h1><div id="paragraph-1" data-news-content="company" class="content-detail"><div><p>'+body+'</p></div></div><div class="related-news">OR unrelated card only</div>';
}
const response=(html,type='text/html',status=200)=>new Response(html,{status,headers:{'content-type':type}});
function fixture({items=[item()],env={},now=Date.now,html,fail}={}){
 const calls=[];const transport=async(value,init={})=>{const url=String(value);calls.push({url,init});if(fail)return fail(url,init);if(url===SITEMAP)return response(sitemap(items),'text/xml');const news=items.find(x=>x.url===url);return response(html?html(news):article(news));};
 return {calls,transport,source:createThansettakijSource({enabled:true,transport,now}),service:createNewsService({env:{SETSCOPE_NEWS_THANSETTAKIJ:'on',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',...env},articleFetch:transport,now,fetchImpl:async()=>response('<rss><channel></channel></rss>','text/xml')})};
}
test('default OFF performs zero source requests including watchlist access',async()=>{
 let calls=0;const source=createThansettakijSource({transport:async()=>{calls++;throw Error('hidden fetch');}});
 assert.equal((await source.getNews()).dataState,'disabled');assert.equal((await source.getNews({stock:{symbol:'PTT'}})).items.length,0);
 const news=createNewsService({env:{},articleFetch:async()=>{calls++;throw Error('hidden article fetch');},fetchImpl:async()=>response(sitemap(),'text/xml')});
 await news.getNews();assert.equal(calls,0);
});
test('sitemap reuses XML decoding and accepts only bounded current finance/business news',()=>{
 const bad=[item(1,{url:'https://evil.example/finance/1'}),item(2,{url:'https://www.thansettakij.com/search/2'}),item(3,{pubDate:'invalid'}),item(4,{pubDate:new Date(Date.now()+86400000).toISOString()}),item(5,{title:'report.pdf'}),item(6,{url:'https://api.thansettakij.com/finance/6'})];
 const result=parseThansettakijSitemap(sitemap([...bad,item(7,{title:'PTT & OR ผลประกอบการ'}),item(7,{url:item(7).url+'?utm_source=x',title:'PTT & OR ผลประกอบการ'})]));
 assert.equal(result.length,1);assert.equal(result[0].title,'PTT & OR ผลประกอบการ');assert.equal(result[0].source,'other');
 assert.equal(parseThansettakijSitemap(sitemap(Array.from({length:30},(_,i)=>item(i)))).length,20);
 for(const xml of ['<urlset>','<!DOCTYPE x><urlset></urlset>',sitemap().replace('</url>','')])assert.throws(()=>parseThansettakijSitemap(xml),/PARSER_MISMATCH/);
});
test('publisher identity checks host and label; remaining roadmap publishers stay disabled',()=>{
 const good={...item(),source:'other',sourceName:'ฐานเศรษฐกิจ'};
 assert.equal(publisherMatches(good),true);assert.equal(publisherMatches({...good,sourceName:'Other'}),false);
 assert.equal(publisherMatches({...good,url:'https://api.thansettakij.com/finance/1'}),false);
 assert.equal(allowedNewsUrl('https://thansettakij.com.evil.example/finance/1'),null);
 assert.ok(ROADMAP_NEWS_PUBLISHERS.every(x=>x.enabled===false));assert.equal(allowedNewsUrl('https://www.investing.com/news/123'),null);
});
test('JSON-LD identity/date plus source paragraphs verify; cards, metadata and paid content do not',()=>{
 const news=item(),inspect=html=>inspectNewsArticle(html,{url:news.url,title:news.title,strict:true});
 assert.equal(inspect(article(news)).status,'VERIFIED');assert.ok(!inspect(article(news)).text.includes('unrelated card'));
 for(const changes of [{datePublished:undefined},{headline:'พาดหัวข่าวอื่นที่ไม่ตรงกัน'},{isAccessibleForFree:false}])assert.notEqual(inspect(article(news,changes)).status,'VERIFIED');
 assert.notEqual(inspect(article(news,{mainEntityOfPage:{'@id':news.url+'wrong'}})).status,'VERIFIED');
 assert.notEqual(inspect(article(news).replace('data-news-content="company"','data-news-content="related"')).status,'VERIFIED');
 assert.notEqual(inspect(article(news).replace(/<div id="paragraph-1"[\s\S]*?<div class="related-news">/,'<div class="related-news">')).status,'VERIFIED');
});
test('source verifies at most 3 candidates within 12 HTTP requests and rotates after cache expiry',async()=>{
 let now=Date.now();const f=fixture({items:Array.from({length:9},(_,i)=>item(1234500+i)),now:()=>now}),seen=new Set();
 for(let round=0;round<3;round++){const before=f.calls.length;const result=await f.source.getNews();for(const x of result.items)seen.add(x.url);assert.ok(f.calls.length-before<=12);assert.equal(f.calls.slice(before).filter(x=>x.url!==SITEMAP).length,3);now+=300001;}
 assert.equal(seen.size,9);
});
test('source snapshot coalesces requests; one caller abort cannot mix or cancel another owner',async()=>{
 const f=fixture(),a=new AbortController();const one=f.source.getNews({stock:{symbol:'PTT'},signal:a.signal});a.abort();const two=f.source.getNews({stock:{symbol:'OR'}});
 await assert.rejects(one);assert.equal((await two).items.length,0);assert.equal(f.calls.filter(x=>x.url===SITEMAP).length,1);
 const ptt=await f.source.getNews({stock:{symbol:'PTT'}});assert.equal(ptt.items.length,1);assert.deepEqual(ptt.items[0].matchedSymbols,['PTT']);assert.ok(trustedEvidence(ptt.items[0]));
 assert.equal((await f.source.getNews()).items[0].matchedSymbols,undefined);
});
test('matchedSymbols require article evidence, never unrelated cards or sitemap title alone',async()=>{
 const f=fixture({items:[item(1234567,{title:'OR รายงานผลประกอบการใหม่'})],html:x=>article(x).replace('บริษัท PTT','บริษัท OR')});
 // Both title and body mention the issuer; the existing short-symbol matcher still requires its context.
 const result=await f.source.getNews({stock:{symbol:'OR'}});assert.equal(result.items.length,1);
 const other=fixture();assert.equal((await other.source.getNews({stock:{symbol:'OR'}})).items.length,0);
});
for(const [name,html,type,expected] of [
 ['PDF',()=>'%PDF-1.7','application/pdf','ARTICLE_RESPONSE_UNVERIFIED'],
 ['date mismatch',x=>article(x,{datePublished:new Date(Date.parse(date)-86400000).toISOString()}),'text/html','PUBLICATION_DATE_MISMATCH'],
 ['login',()=>'<form><input type="password"></form>','text/html','ARTICLE_IDENTITY_OR_TEXT_INSUFFICIENT'],
 ['missing body',x=>article(x).replace('content-detail','other-detail'),'text/html','ARTICLE_IDENTITY_OR_TEXT_INSUFFICIENT']
])test('uncertain '+name+' stays UNVERIFIED with no fabricated reject or evidence',async()=>{
 const f=fixture({fail:async u=>u===SITEMAP?response(sitemap(),'text/xml'):response(html(item()),type)});const result=await f.source.getNews();
 assert.equal(result.items.length,0);assert.equal(result.unverifiedCount,1);assert.equal(result.diagnostics[0].reason,expected);assert.equal(result.assessments.length,0);
});
for(const status of [401,403,429])test('source denial '+status+' stops requests and respects cooldown',async()=>{
 const f=fixture({fail:async()=>response('denied','text/plain',status)});await f.source.getNews();await f.source.getNews();assert.equal(f.calls.length,1);
});
test('source failure is isolated and stale fallback expires without resetting article age',async()=>{
 let now=Date.now(),fail=false;const f=fixture({now:()=>now});const transport=async(u,o)=>{if(fail)throw Error('source down');return f.transport(u,o);};
 const source=createThansettakijSource({enabled:true,transport,now:()=>now});assert.equal((await source.getNews()).items.length,1);
 now+=300001;fail=true;const stale=await source.getNews();assert.equal(stale.items.length,1);assert.equal(stale.dataState,'stale');
 now+=1800001;assert.equal((await source.getNews()).items.length,0);
 const news=fixture({fail:async()=>{throw Error('new source unavailable');}});const result=await news.service.getNews();assert.ok(result.errors.includes('thansettakij'));
});
test('News/Archive/Featured/Latest and Watchlist preserve G1 article evidence and stored AI across restart',async()=>{
 const f=fixture();const result=await f.service.getNews();assert.equal(result.items.length,1);const news=result.items[0];
 assert.equal(news.verification.basis,'article');assert.equal(reviewNewsForDisplay(news).status,'VERIFIED');assert.equal(newsSecuritySymbols(news),null);
 const db=memoryTransport();news.analysisMode='ai';news.analysisSummary='Stored AI for archive compatibility';await db.service().ingest([news]);
 const row=[...db.rows.values()][0];assert.equal(row.source,'other');row.analysis_mode='ai';row.analysis_summary=news.analysisSummary;const first=row.first_seen_at,fingerprint=row.fingerprint;
 const reread=await db.service().list();assert.equal(reread.items.length,1);assert.equal(reviewNewsForDisplay(reread.items[0]).status,'VERIFIED');
 assert.equal(reread.items[0].analysisSummary,news.analysisSummary);await db.service().ingest([news]);assert.equal([...db.rows.values()][0].first_seen_at,first);assert.equal([...db.rows.values()][0].fingerprint,fingerprint);assert.equal([...db.rows.values()][0].analysis_summary,news.analysisSummary);
 const domain=await import('../client/domain.mjs');for(const hardGate of [false,true]){assert.equal(domain.selectNewsForDisplay(reread.items,{hardGate}).featured.length,1);assert.equal(domain.selectNewsForDisplay(reread.items,{hardGate,featuredCount:0}).latest.length,1);}
 const watch=await f.service.getWatchlistNews('PTT',{ownerId:'owner-a'});assert.equal(watch.items.length,1);assert.ok(trustedEvidence(watch.items[0]));
 assert.equal((await f.service.getWatchlistNews('OR',{ownerId:'owner-b'})).items.length,0);assert.equal((await f.service.getWatchlistNews('PTT',{ownerId:'owner-a'})).items.length,1);
 assert.equal(newsClickUrl({...news,displayUrl:item().url,linkVerification:{status:'VERIFIED',kind:'ARTICLE'}}),item().url);
});
test('valid article mentioning PDF is not a document',async()=>{
 const f=fixture({items:[item(1234567,{title:'PTT เปิดคู่มือ PDF ประกอบบทความข่าว'})]});assert.equal((await f.service.getNews()).items.length,1);
});

test('confirmed PDF refresh cannot retain an older canonical/www article snapshot',async()=>{
 let now=Date.now(),pdf=false;const base=fixture();const source=createThansettakijSource({enabled:true,now:()=>now,transport:async(u,o)=>pdf&&String(u)!==SITEMAP?response('%PDF-1.7','application/pdf'):base.transport(u,o)});
 assert.equal((await source.getNews()).items.length,1);now+=300001;pdf=true;assert.equal((await source.getNews()).items.length,0);
});
test('new publisher redirects and private addresses use the existing safe transport',async()=>{
 const {createNewsTransport}=require('../lib/news-fetch');let sockets=0;
 const pinned=createNewsTransport({allowThansettakij:true,lookup:async()=>[{address:'127.0.0.1',family:4}],requestImpl:()=>{sockets++;throw Error('must not connect');}});
 const unsafe=createThansettakijSource({enabled:true,transport:pinned});assert.equal((await unsafe.getNews()).items.length,0);assert.equal(sockets,0);
 const f=fixture({fail:async u=>u===SITEMAP?response(sitemap(),'text/xml'):new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}})});
 const blocked=await f.source.getNews();assert.equal(blocked.items.length,0);assert.equal(blocked.diagnostics[0].reason,'ARTICLE_REDIRECT_BLOCKED');assert.equal(f.calls.length,2);
});
test('source deadline aborts pending IO and enters cooldown without a background retry',async t=>{
 const actual=setTimeout;let requests=0,aborted=false;
 t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>actual(fn,ms===10000?10:ms,...args));
 const source=createThansettakijSource({enabled:true,transport:async(_u,{signal})=>{requests++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('timeout'));},{once:true}));}});
 assert.deepEqual((await source.getNews()).errors,['SOURCE_TIMEOUT']);await source.getNews();assert.equal(requests,1);assert.equal(aborted,true);
});
test('failed new source cannot discard healthy legacy news; failed Google cannot discard new source',async()=>{
 const good=item(),rss='<rss><channel><item><title>'+good.title+'</title><link>https://thunhoon.com/article-123456</link><source>Thunhoon</source><pubDate>'+date+'</pubDate><description>Healthy source article details remain available to the reader.</description></item></channel></rss>';
 const old=createNewsService({env:{SETSCOPE_NEWS_THANSETTAKIJ:'on'},articleFetch:async()=>{throw Error('new source unavailable');},fetchImpl:async()=>response(rss,'text/xml')});
 const result=await old.getNews();assert.equal(result.items.length,1);assert.equal(result.items[0].source,'thunhoon');assert.ok(result.errors.includes('thansettakij'));
 const f=fixture();const news=createNewsService({env:{SETSCOPE_NEWS_THANSETTAKIJ:'on'},articleFetch:f.transport,fetchImpl:async()=>response('denied','text/plain',403)});
 const fresh=await news.getNews();assert.equal(fresh.items.length,1);assert.equal(fresh.items[0].sourceName,'ฐานเศรษฐกิจ');assert.equal(fresh.partial,true);
});

test('redirect-heavy source refresh includes discovery in the shared 12-request ceiling',async()=>{
 let now=Date.now(),calls=[];const news=Array.from({length:5},(_,i)=>item(1234500+i));
 const source=createThansettakijSource({enabled:true,now:()=>now,transport:async value=>{
  const u=new URL(value);calls.push(u.href);if(u.href===SITEMAP)return response(sitemap(news),'text/xml');
  const hop=Number(u.searchParams.get('hop')||0),original=news.find(x=>new URL(x.url).pathname===u.pathname);
  if(hop<4){u.searchParams.set('hop',String(hop+1));return new Response('',{status:302,headers:{location:u.href}});}
  return response(article({...original,url:u.href}));
 }});
 for(let round=0;round<3;round++){calls=[];await source.getNews();assert.ok(calls.length<=12);assert.ok(new Set(calls.filter(x=>x!==SITEMAP).map(x=>new URL(x).pathname)).size<=3);now+=300001;}
});

test('default transport blocks all new-publisher IO before DNS, including legacy link review',async()=>{
 const {createNewsTransport}=require('../lib/news-fetch'),{createNewsArticleLoader}=require('../lib/news-resolver');let lookups=0;
 const transport=createNewsTransport({allowThansettakij:false,lookup:async()=>{lookups++;throw Error('no hidden DNS');}});
 for(const url of [SITEMAP,item().url])await assert.rejects(transport(url),/NEWS_OPTIONAL_SOURCE_DISABLED/);
 const loader=createNewsArticleLoader({transport});assert.equal((await loader(item().url)).reason,'ARTICLE_SOURCE_DISABLED');assert.equal(lookups,0);
});

for(const flag of [undefined,'off','on'])for(const view of ['general','watchlist'])test('compatibility '+view+' Google RSS with source flag '+(flag??'unset'),async()=>{
 const enabled=flag==='on',newsItem=item(),wrapper='https://news.google.com/rss/articles/compat-thansettakij',otherUrl='https://news.google.com/rss/articles/compat-infoquest';
 const outlet=view==='general'?'ฐานเศรษฐกิจ':'Thansettakij';
 const entry=(url,name,title)=>'<item><title>'+esc(title)+'</title><link>'+url+'</link><source>'+name+'</source><pubDate>'+date+'</pubDate><description>PTT รายงานรายละเอียดผลประกอบการจากข้อมูลสำนักข่าวต้นทาง</description></item>';
 const rss='<rss><channel>'+entry(wrapper,outlet,newsItem.title)+entry(otherUrl,'InfoQuest','PTT ข่าวจากสำนักข่าวเดิมที่ต้องรักษาไว้')+'</channel></rss>';
 const adapter=fixture();let articleCalls=0,lookups=0;
 const {createNewsTransport}=require('../lib/news-fetch');
 const disabledTransport=createNewsTransport({allowThansettakij:false,lookup:async()=>{lookups++;throw Error('disabled source must not resolve DNS');}});
 const service=createNewsService({env:{...(flag===undefined?{}:{SETSCOPE_NEWS_THANSETTAKIJ:flag}),SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_GOOGLE_NEWS_RPC:'off'},
  fetchImpl:async()=>response(rss,'text/xml'),articleFetch:async(...args)=>{articleCalls++;return enabled?adapter.transport(...args):disabledTransport(...args);}});
 const read=()=>view==='general'?service.getNews():service.getWatchlistNews('PTT',{ownerId:'compat-owner'});
 for(let pass=0;pass<2;pass++){
  const result=await read(),than=result.items.filter(x=>/^(?:ฐานเศรษฐกิจ|Thansettakij)$/.test(x.sourceName));
  assert.equal(result.items.length,enabled?3:2,'unresolved RSS coverage is retained alongside the optional article');assert.equal(than.length,enabled?2:1);
  const selected=than.find(x=>x.verification.basis===(enabled?'article':'metadata'));
  assert.equal(than.find(x=>x.url===wrapper).verification.basis,'metadata');
  assert.equal(selected.verification.status,'VERIFIED');assert.equal(selected.verification.basis,enabled?'article':'metadata');
  assert.equal(selected.url,enabled?'https://thansettakij.com/finance/stock/1234567':wrapper);
  assert.equal(reviewNewsForDisplay(selected).status,enabled?'VERIFIED':'UNVERIFIED','metadata never becomes article proof');
  assert.equal(result.items.find(x=>x.sourceName==='InfoQuest').url,otherUrl);
  if(view==='watchlist')assert.deepEqual(selected.matchedSymbols,['PTT']);
 }
 assert.equal(lookups,0);
 if(enabled){assert.equal(articleCalls,2,'one sitemap plus one article, reused on the second read');assert.equal(adapter.calls.filter(x=>x.url===SITEMAP).length,1);assert.ok(adapter.calls.every(x=>!x.url.includes('news.google.com')));}
 else{assert.equal(articleCalls,0,'legacy Google RSS does not activate the source adapter or article transport');assert.equal(adapter.calls.length,0);}
});

test('Thansettakij native dispatch is paced and a queued abort cannot create a late socket',async()=>{
 const {createNewsTransport}=require('../lib/news-fetch'),{fixtureRequest}=require('./fixtures/news-https.cjs');const dispatch=[];
 const mock=fixtureRequest(async()=>response('synthetic response'));
 const transport=createNewsTransport({allowThansettakij:true,lookup:async()=>[{address:'8.8.8.8',family:4}],requestImpl:(...args)=>{dispatch.push(Date.now());return mock(...args);}});
 await Promise.all([transport(item().url),transport(item().url),transport(item().url)]);assert.equal(dispatch.length,3);for(let i=1;i<dispatch.length;i++)assert.ok(dispatch[i]-dispatch[i-1]>=140);
 const controller=new AbortController(),pending=transport(item().url,{signal:controller.signal});controller.abort();await assert.rejects(pending,/Abort|NEWS_REQUEST_ABORTED/);
 await transport(item().url);assert.equal(dispatch.length,4);
});
test('both requested flags preserve Brand Inside baseline while its acquisition path is unavailable',async()=>{
 const f=fixture(),rss='<rss><channel><item><title>PTT รายงานผลประกอบการใหม่</title><link>https://news.google.com/rss/articles/brand-compat</link><source>Brand Inside</source><pubDate>'+date+'</pubDate><description>PTT รายละเอียดต้นทางจาก Google RSS ยังคงเป็น metadata เท่านั้น</description></item></channel></rss>';
 const service=createNewsService({env:{SETSCOPE_NEWS_THANSETTAKIJ:'on',SETSCOPE_NEWS_BRANDINSIDE:'on'},fetchImpl:async()=>response(rss,'text/xml'),articleFetch:f.transport});
 for(const result of [await service.getNews(),await service.getWatchlistNews('PTT',{ownerId:'a'})]){assert.equal(result.items.length,2);assert.equal(result.items.find(x=>x.sourceName==='Brand Inside').verification.basis,'metadata');assert.equal(result.items.find(x=>x.sourceName==='ฐานเศรษฐกิจ').verification.basis,'article');}
 assert.ok(f.calls.every(x=>new URL(x.url).hostname.endsWith('thansettakij.com')));assert.equal(allowedNewsUrl('https://brandinside.asia/story/'),null);
});
test('direct publisher URLs cannot duplicate verified items by changing the Google outlet name',async()=>{
 const f=fixture(),rss='<rss><channel><item><title>'+item().title+'</title><link>'+item().url+'</link><source>Other</source><pubDate>'+date+'</pubDate><description>PTT ข้อมูลข่าวจากต้นทางที่ตรวจสอบได้</description></item></channel></rss>';
 const service=createNewsService({env:{SETSCOPE_NEWS_THANSETTAKIJ:'on'},fetchImpl:async()=>response(rss,'text/xml'),articleFetch:f.transport});const result=await service.getNews();assert.equal(result.items.length,1);assert.equal(result.items[0].verification.basis,'article');
});
test('a denied article origin is not retried for later candidates or later refreshes',async()=>{
 let now=Date.now();const items=Array.from({length:3},(_,i)=>item(1234500+i));const f=fixture({now:()=>now,items,fail:async u=>u===SITEMAP?response(sitemap(items),'text/xml'):response('denied','text/html',403)});
 const held=await f.source.getNews();assert.equal(held.items.length,0);assert.ok(held.diagnostics.every(x=>x.reason==='ARTICLE_ACCESS_DENIED'));assert.equal(f.calls.length,2);
 now+=300001;await f.source.getNews();assert.equal(f.calls.filter(x=>x.url!==SITEMAP).length,1);
});
test('RSS/Sitemap metadata and a serialized VERIFIED cannot become trusted article proof',async()=>{
 const {issueEvidence}=require('../lib/news-evidence'),{reviewNewsItem}=require('../lib/news-quality');const f=fixture(),news=(await f.source.getNews()).items[0],copy=JSON.parse(JSON.stringify(news));
 assert.equal(trustedEvidence(copy),null);assert.equal(reviewNewsForDisplay(copy).status,'UNVERIFIED');assert.notEqual(reviewNewsItem(copy).basis,'article');
 const parsed=parseThansettakijSitemap(sitemap())[0];assert.equal(issueEvidence(parsed,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{}),null);
});
