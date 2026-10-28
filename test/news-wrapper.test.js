'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {getAssessments}=require('../lib/news-evidence');
const date=new Date(Date.now()-60000).toISOString(),title='PTT รายงานผลประกอบการและแผนลงทุนล่าสุด';
const wrapper='https://news.google.com/rss/articles/CBMiFixture',publisher='https://www.infoquest.co.th/2026/123456';
const rss=(source='Thunhoon')=>'<rss><channel><item><title>'+title+'</title><link>'+wrapper+'</link><pubDate>'+date+'</pubDate><description>หุ้น OR ข่าวบริษัท PTT และแผนการลงทุน</description><source>'+source+'</source></item></channel></rss>';
const article=(url=publisher)=>'<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:date,articleBody:'บริษัท PTT เปิดเผยรายละเอียดผลประกอบการและแผนลงทุนที่ตรวจสอบได้ '.repeat(6)})+'</script>';
for(const status of [200,404,410])test('P1 resolver: unresolved Google '+status+' never creates trusted REJECTED',async()=>{
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'on'},fetchImpl:async input=>String(input).includes('/rss/search?')?new Response(rss()):new Response('<link rel="canonical" href="https://news.google.com/articles/other"><main>Google wrapper</main>',{status,headers:{'content-type':'text/html'}})});
 const result=await service.getNews();assert.equal(result.items.length,0);
 assert.ok(getAssessments(result).length);assert.ok(getAssessments(result).every(x=>x.verification?.status!=='REJECTED'));
});
test('P1 resolver: public wrapper resolution precedes strict InfoQuest article/date proof',async()=>{
 const calls=[];const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'on'},fetchImpl:async(input,init={})=>{
  const url=String(input);if(url.includes('/rss/search?'))return new Response(rss('สำนักข่าวอินโฟเควสท์'));
  calls.push({url,method:init.method||'GET'});
  if(url===wrapper)return new Response('<div data-n-a-id="CBMiFixture" data-n-a-ts="1793100000" data-n-a-sg="synthetic-public-param"></div>',{headers:{'content-type':'text/html'}});
  if(url.includes('/batchexecute'))return new Response(")]}'\n\n"+JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres',publisher])]]));
  assert.equal(url,publisher);return new Response(article(),{headers:{'content-type':'text/html'}});
 }});
 const result=await service.getNews();assert.equal(result.items.length,1);assert.equal(result.items[0].verification.basis,'article');
 assert.equal(result.items[0].pubDate,date);assert.equal(result.items[0].source,'infoquest');assert.equal(calls.length,3);
 const watch=await service.getWatchlistNews([{symbol:'OR'}],{ownerId:'fixture-owner'});assert.equal(watch.items.length,0);
 const correct=await service.getWatchlistNews([{symbol:'PTT'}],{ownerId:'fixture-owner'});assert.equal(correct.items.length,1);assert.deepEqual(correct.items[0].matchedSymbols,['PTT']);
});
module.exports={date,title,wrapper,publisher,rss,article};

const {createNewsArticleLoader,decodedLegacyUrl,wrapperParams,resolvedRpcUrl}=require('../lib/news-resolver');
const {allowedNewsUrl,publisherMatches,ROADMAP_NEWS_PUBLISHERS}=require('../lib/news-policy');
const {publicNewsAddress,publicNewsLookup}=require('../lib/news-fetch');
const {reviewNewsItem}=require('../lib/news-quality');
const {memoryTransport,env}=require('./fixtures/news-evidence.cjs');
const {archiveFingerprint}=require('../server/news-archive-service');
test('P1 resolver security: private, local, mapped and special IPs are denied',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','0.0.0.0','198.18.0.1','192.0.2.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])assert.equal(publicNewsAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2001:4860:4860::8888'])assert.equal(publicNewsAddress(ip),true,ip);
 await assert.rejects(publicNewsLookup('thunhoon.com',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/PRIVATE_ADDRESS/);
 const answers=[{address:'8.8.8.8',family:4}];assert.deepEqual(await publicNewsLookup('thunhoon.com',async()=>answers),answers);
});
test('P1 resolver security: unsafe ports, credentials, deceptive hosts and protocols fail before fetch',async()=>{
 let calls=0;const loader=createNewsArticleLoader({transport:async()=>{calls++;throw Error('must not fetch');}});
 for(const url of ['https://thunhoon.com:8443/a','https://news.google.com:5432/a','http://thunhoon.com/a','https://user:pass@thunhoon.com/a','https://thunhoon.com.evil.invalid/a','https://127.0.0.1/a']){
  assert.equal(allowedNewsUrl(url),null);assert.equal((await loader(url)).status,'UNVERIFIED');
 }assert.equal(calls,0);
});
test('P1 resolver: explicit redirect is resolved and revalidated on every hop',async()=>{
 const calls=[];const loader=createNewsArticleLoader({transport:async u=>{calls.push(String(u));return new Response('',{status:302,headers:{location:'https://169.254.169.254/latest/meta-data'}});}});
 assert.equal((await loader(wrapper)).status,'UNVERIFIED');assert.equal(calls.length,1);
});
test('P1 resolver: RPC cannot authorize arbitrary URLs, multiple identities or a different wrapper id',()=>{
 assert.equal(wrapperParams('<div data-n-a-id="other" data-n-a-ts="1" data-n-a-sg="fixture"></div>','expected'),null);
 for(const url of ['https://127.0.0.1/a','https://thunhoon.com:8443/a','https://news.google.com/articles/again']){
  assert.equal(resolvedRpcUrl(JSON.stringify([['wrb.fr','Fbv4je',JSON.stringify(['garturlres',url])]])),null);
 }
 const frame=['wrb.fr','Fbv4je',JSON.stringify(['garturlres',publisher])];
 assert.equal(resolvedRpcUrl(JSON.stringify([frame,frame])),null);
 assert.equal(resolvedRpcUrl(JSON.stringify([['wrb.fr','Fbv4je',null]])),null);
});
test('P1 resolver: legacy embedded URL decoding uses bounded framing and still requires article proof',async()=>{
 const bytes=Buffer.from(publisher),length=[];let n=bytes.length;do{let b=n&127;n=Math.floor(n/128);length.push(n?b|128:b);}while(n);
 const encoded=Buffer.concat([Buffer.from([8,19,34,...length]),bytes,Buffer.from([210,1,0])]).toString('base64url');
 const input='https://news.google.com/rss/articles/'+encoded;assert.equal(decodedLegacyUrl(input).href,publisher);
 const calls=[];const loader=createNewsArticleLoader({transport:async u=>{calls.push(String(u));return new Response(article(),{headers:{'content-type':'text/html'}});}});
 const result=await loader(input);assert.equal(result.target.href,publisher);assert.deepEqual(calls,[publisher]);
});
for(const status of [401,403,429])test('P1 resolver: '+status+' stops only the affected origin without retry/rotation',async()=>{
 let now=Date.now(),calls=0;const loader=createNewsArticleLoader({now:()=>now,transport:async()=>{calls++;return new Response('',{status});}});
 await loader(wrapper);await loader(wrapper+'other');assert.equal(calls,1);
 if(status===429){now+=300001;await loader(wrapper);assert.equal(calls,2);}
});
test('P1 resolver: HTTP budget bounds loops and pending resolution',async()=>{
 let calls=0;const loader=createNewsArticleLoader({transport:async()=>{calls++;return new Response('',{status:302,headers:{location:'/articles/next'}});}});
 const budget={httpRemaining:2};assert.equal((await loader(wrapper,{budget})).status,'UNVERIFIED');assert.equal(calls,2);assert.equal(budget.httpRemaining,0);
});
test('P1 resolver: unresolved refresh preserves persisted VERIFIED metadata, fingerprint and stored AI',async()=>{
 const item={title,url:wrapper,source:'thunhoon',sourceName:'Thunhoon',snippet:'Sufficient synthetic RSS metadata for the accepted legacy record',pubDate:date};
 item.verification=reviewNewsItem(item);
 const db=memoryTransport();await db.service().ingest([item]);const row=[...db.rows.values()][0];row.analysis_mode='ai';row.analysis_summary='Preserved AI';
 const before=structuredClone(row);
 const service=createNewsService({env,fetchImpl:async u=>String(u).includes('/rss/search?')?new Response(rss()):new Response('<link rel="canonical" href="https://news.google.com/"><main>Wrapper</main>',{headers:{'content-type':'text/html'}})});
 const result=await service.getNews();const assessments=getAssessments(result);assert.ok(assessments.every(x=>x.verification.status==='UNVERIFIED'));
 // In a real RPC these are retained; the existing native PostgreSQL fixture asserts that outcome too.
 assert.equal(result.items.length,0);assert.deepEqual([...db.rows.values()][0],before);
});
test('P1 resolver: resolved article refresh retains the original archive fingerprint and stored AI',async()=>{
 const item={title,url:wrapper,source:'infoquest',sourceName:'InfoQuest',snippet:'Sufficient synthetic accepted metadata before publisher resolution',pubDate:date};
 item.verification=reviewNewsItem(item);const original=archiveFingerprint(item);
 const db=memoryTransport();await db.service().ingest([item]);const row=[...db.rows.values()][0];row.analysis_summary='Legacy AI';row.analysis_mode='ai';const first=row.first_seen_at;
 const service=createNewsService({env,fetchImpl:async u=>{
  if(String(u).includes('/rss/search?'))return new Response(rss('InfoQuest'));
  if(String(u)===wrapper)return new Response('',{status:302,headers:{location:publisher}});
  return new Response(article(),{headers:{'content-type':'text/html'}});
 }});
 const result=await service.getNews();assert.equal(result.items.length,1);assert.equal(archiveFingerprint(result.items[0]),original);
 await db.service().ingest(result.items);assert.equal(db.rows.size,1);
 const after=[...db.rows.values()][0];assert.equal(after.fingerprint,original);assert.equal(after.url,require('../lib/news-evidence').canonicalUrl(publisher));
 assert.equal(after.analysis_summary,'Legacy AI');assert.equal(after.first_seen_at,first);
 const reread=(await db.service().list()).items[0];assert.equal(archiveFingerprint(reread),original);
});
test('P1 sources: InfoQuest mapping is explicit; remaining roadmap sources stay disabled at both gates',async()=>{
 const domain=await import('../client/domain.mjs');
 assert.equal(publisherMatches({url:publisher,source:'infoquest',sourceName:'สำนักข่าวอินโฟเควสท์'}),true);
 assert.equal(domain.canDisplayNews({url:publisher,title,pubDate:date,verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}}),true);
 assert.equal(publisherMatches({url:publisher,source:'thunhoon',sourceName:'Thunhoon'}),false);
 for(const x of ROADMAP_NEWS_PUBLISHERS){assert.equal(x.enabled,false);assert.equal(allowedNewsUrl('https://'+x.host+'/news/123'),null);
 assert.equal(domain.canDisplayNews({url:'https://'+x.host+'/news/123',title,pubDate:date,verification:{status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'}},Date.now(),{hardGate:true}),false);}
});

test('P1 InfoQuest adapter: same-article JSON-LD identity/date plus explicit content container, never related cards',()=>{
 const {inspectNewsArticle}=require('../lib/news-article'),url=publisher;
 const ld=overrides=>'<script type="application/ld+json">'+JSON.stringify({'@type':'Article','@id':url+'#article',headline:title,datePublished:date,...overrides})+'</script>';
 const visible='<h1>'+title+'</h1><div class="elementor-widget-theme-post-content"><div><p>'+'PTT ผลประกอบการและแผนลงทุนจากบทความต้นฉบับ '.repeat(6)+'</p></div></div>';
 const wrap=content=>'<link rel="canonical" href="'+url+'">'+content+'<article><p>Unrelated card text '.repeat(5)+'</p></article>';
 assert.equal(inspectNewsArticle(wrap(ld({})+visible),{url,title,strict:true}).status,'VERIFIED');
 assert.equal(inspectNewsArticle(wrap(ld({datePublished:undefined})+visible),{url,title,strict:true}).status,'UNVERIFIED');
 assert.notEqual(inspectNewsArticle(wrap(ld({'@id':url+'wrong'})+visible),{url,title,strict:true}).status,'VERIFIED');
 assert.notEqual(inspectNewsArticle(wrap(ld({})+visible.replace('elementor-widget-theme-post-content','unbound-widget')),{url,title,strict:true}).status,'VERIFIED');
 assert.notEqual(inspectNewsArticle(wrap(ld({})+visible.replace('<h1>','<h1>Unrelated ')),{url,title:'บริษัทคนละแห่งประกาศเรื่องอื่น',strict:true}).status,'VERIFIED');
 assert.notEqual(inspectNewsArticle(wrap(ld({})+visible+visible),{url,title,strict:true}).status,'VERIFIED');
});

test('P1 resolver: a 200 challenge also stops further acquisition from that origin',async()=>{
 let calls=0;const input='<rss><channel>'+[1,2].map(i=>'<item><title>'+title+'</title><link>https://thunhoon.com/article-challenge-'+i+'</link><pubDate>'+date+'</pubDate><source>Thunhoon</source></item>').join('')+'</channel></rss>';
 const service=createNewsService({env,fetchImpl:async url=>{
  if(String(url).includes('/rss/search?'))return new Response(input);
  calls++;return new Response('<article>Verify you are human CAPTCHA</article>',{headers:{'content-type':'text/html'}});
 }});
 const result=await service.getNews();assert.equal(result.items.length,0);assert.equal(calls,1);
 assert.ok(getAssessments(result).every(x=>x.verification.status==='UNVERIFIED'));
});

test('P1 Watchlist: bounded cold request exposes partial coverage and manual warm request completes it',async()=>{
 let probes=0;
 const service=createNewsService({env,fetchImpl:async(input)=>{
  const u=new URL(input);
  if(u.pathname==='/rss/search'){
   const symbol=(u.searchParams.get('q')||'').match(/^\("([A-Z]+)"/)?.[1]||'AAA';
   return new Response('<rss><channel><item><title>'+symbol+' รายงานผลประกอบการและแผนลงทุนล่าสุด</title><link>https://thunhoon.com/article-'+symbol+'</link><pubDate>'+date+'</pubDate><source>Thunhoon</source></item></channel></rss>');
  }
  probes++;const symbol=u.pathname.split('-').pop(),headline=symbol+' รายงานผลประกอบการและแผนลงทุนล่าสุด';
  return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:u.href,headline,datePublished:date,articleBody:(symbol+' รายงานรายละเอียดผลประกอบการและแผนลงทุนล่าสุด ').repeat(6)})+'</script>',{headers:{'content-type':'text/html'}});
 }});
 const stocks=['AAA','BBB','CCC','DDD'].map(symbol=>({symbol}));
 const cold=await service.getWatchlistNews(stocks,{ownerId:'bounded-owner'});assert.equal(cold.items.length,3);assert.equal(cold.partial,true);assert.equal(probes,3);
 const warm=await service.getWatchlistNews(stocks,{ownerId:'bounded-owner'});assert.equal(warm.items.length,4);assert.equal(probes,4);
});
