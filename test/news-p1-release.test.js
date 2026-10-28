'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsTransport}=require('../lib/news-fetch'),{createNewsArticleLoader}=require('../lib/news-resolver');
const {createObservability}=require('../server/observability'),{fixtureRequest}=require('./fixtures/news-https.cjs');
const {createNewsService}=require('../server/news-service');
const {inspectNewsArticle}=require('../lib/news-article'),{getAssessments,issueEvidence}=require('../lib/news-evidence');
const {memoryTransport}=require('./fixtures/news-evidence.cjs');
const gateEnv={SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on'};
const date=new Date(Date.now()-60000).toISOString(),url='https://thunhoon.com/article-identity-123',title='AMATA รายงานผลประกอบการและแผนลงทุนล่าสุด',slug='amata-กำไร-q3-ส่อวูบ-5-โบรกชี้ยอด';
const html=(changes={})=>'<link rel="canonical" href="'+url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:date,articleBody:'AMATA รายงานรายละเอียดผลประกอบการและแผนลงทุนจากต้นฉบับ '.repeat(6),...changes})+'</script>';
const rss=()=>'<rss><channel><item><title>'+slug+'</title><link>'+url+'</link><pubDate>'+date+'</pubDate><source>Thunhoon</source></item></channel></rss>';
test('P1 Runtime: observed provider fetch never bypasses private DNS validation',async()=>{
 let unsafeCalls=0,sockets=0;const observed=createObservability({logger:{info(){}}}).observedFetch(async()=>{unsafeCalls++;return new Response('unsafe');});
 const transport=createNewsTransport({fetchImpl:observed,lookup:async()=>[{address:'127.0.0.1',family:4}],requestImpl:()=>{sockets++;}});
 await assert.rejects(transport(url),/NEWS_PRIVATE_ADDRESS/);assert.equal(unsafeCalls,0);assert.equal(sockets,0);
});
test('P1 Runtime: observed pinned transport connects with pinned public DNS even when DNS rebinds',async()=>{
 let lookups=0;const pinned=[];
 const request=fixtureRequest(async()=>new Response('safe'));
 const transport=createNewsTransport({lookup:async()=>{lookups++;return [{address:lookups===1?'8.8.8.8':'127.0.0.1',family:4}];},requestImpl:(target,options,callback)=>{
  assert.equal(target.hostname,'thunhoon.com');assert.notEqual(options.rejectUnauthorized,false);
  options.lookup(target.hostname,{all:true},(error,addresses)=>{assert.ifError(error);pinned.push(addresses[0].address);});
  return request(target,options,callback);
 }});
 const observed=createObservability({logger:{info(){}}}).observedFetch(transport);
 assert.equal((await observed(url)).status,200);assert.equal(lookups,1);assert.deepEqual(pinned,['8.8.8.8']);
});
test('P1 Runtime: redirect revalidates DNS and blocks a public-to-private rebind before second socket',async()=>{
 let lookups=0,sockets=0;
 const socket=fixtureRequest(async()=>new Response('',{status:302,headers:{location:'/article-next'}}));
 const pinned=createNewsTransport({lookup:async()=>[{address:++lookups===1?'8.8.8.8':'169.254.169.254',family:4}],requestImpl:(...args)=>{sockets++;return socket(...args);}});
 const loader=createNewsArticleLoader({transport:createObservability({logger:{info(){}}}).observedFetch(pinned)});
 assert.equal((await loader(url)).status,'UNVERIFIED');assert.equal(lookups,2);assert.equal(sockets,1);
});
test('P1 headline: slug recovery uses bound article headline, publication date and preserves original RSS evidence',async()=>{
 let probes=0;const fake=async input=>String(input).includes('/rss/search?')?new Response(rss()):(probes++,new Response(html(),{headers:{'content-type':'text/html'}}));
 const service=createNewsService({env:gateEnv,fetchImpl:fake,articleFetch:fake});
 const result=await service.getNews();assert.equal(result.items.length,1);const item=result.items[0];
 assert.equal(item.title,title);assert.equal(item.rssTitle,slug);assert.equal(item.pubDate,date);assert.equal(item.verification.basis,'article');assert.equal(probes,1);
 const db=memoryTransport();await db.service().ingest([item]);const stored=[...db.rows.values()][0];
 assert.equal(stored.verification_provenance.originalTitle,slug);assert.equal(stored.verification_provenance.headlineBasis,'article');
 assert.equal((await db.service().list()).items[0].rssTitle,slug);
 const spoof={...item,verification:{...item.verification}};assert.equal(require('../lib/news-evidence').trustedEvidence(spoof),null);
});
for(const [label,changes]of [['related identity',{url:'https://thunhoon.com/article-other'}],['missing date',{datePublished:undefined}],['slug headline',{headline:slug}],['missing content',{articleBody:''}]])
 test('P1 headline: '+label+' cannot recover a display headline',()=>{
  assert.notEqual(inspectNewsArticle(html(changes),{url,title:slug,strict:true,recoverHeadline:true}).status,'VERIFIED');
 });
test('P1 headline: failed recovery stays UNVERIFIED and cannot overwrite existing VERIFIED',async()=>{
 const fake=async input=>String(input).includes('/rss/search?')?new Response(rss()):new Response(html({datePublished:undefined}),{headers:{'content-type':'text/html'}});
 const service=createNewsService({env:gateEnv,fetchImpl:fake,articleFetch:fake});const result=await service.getNews();
 assert.equal(result.items.length,0);assert.ok(getAssessments(result).every(x=>x.verification.status==='UNVERIFIED'));
});
test('P1 gate: default OFF with G1 write preserves metadata/legacy reads and atomic evidence writer',async()=>{
 const db=memoryTransport(),archive=require('../server/news-archive-service'),env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_NEWS_EVIDENCE:'write'};
 const normal={title:'PTT รายงานผลประกอบการล่าสุด',url:'https://news.google.com/articles/g1-current',source:'thunhoon',sourceName:'Thunhoon',pubDate:date,snippet:'ข่าวผลประกอบการที่ผ่านหลักฐาน metadata เดิมของ G1'};
 const off=archive.createNewsArchiveService({env,fetchImpl:db.fetchImpl});assert.equal((await off.ingest([normal])).ingested,1);
 assert.ok(db.calls.some(x=>x.url.pathname.endsWith('/rpc/upsert_news_archive_evidence')));
 assert.equal((await off.list()).total,1);
 const before=structuredClone([...db.rows.values()]);const on=archive.createNewsArchiveService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'on'},fetchImpl:db.fetchImpl});
 assert.equal((await on.list()).total,0);assert.deepEqual([...db.rows.values()],before);
 const source=createNewsService({env});assert.equal(source.filterForDisplay({items:[normal]}).items.length,1);assert.equal(source.filterForDisplay({items:[normal]}).p1DisplayGate,false);
 assert.equal(createNewsService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'on'}}).filterForDisplay({items:[normal]}).items.length,0);
 const domain=await import('../client/domain.mjs');assert.equal(domain.canDisplayNews(normal),true);assert.equal(domain.canDisplayNews(normal,Date.now(),{hardGate:true}),false);
 assert.equal(domain.selectNewsForDisplay([normal]).filtered.length,1);assert.equal(domain.selectNewsForDisplay([normal],{hardGate:true}).filtered.length,0);
 assert.equal(domain.canDisplayNews({...normal,title:slug}),false);
});
test('P1 RPC: undocumented transport is optional default OFF and failures never mint REJECTED',async()=>{
 let posts=0;const wrapper='https://news.google.com/rss/articles/id';
 const transport=async(input,init={})=>{if(init.method==='POST'){posts++;return new Response('unavailable',{status:503});}
 return new Response('<div data-n-a-id="id" data-n-a-ts="1793100000" data-n-a-sg="synthetic"></div>',{headers:{'content-type':'text/html'}});};
 const off=await createNewsArticleLoader({transport})(wrapper);assert.equal(off.status,'UNVERIFIED');assert.equal(posts,0);
 const on=await createNewsArticleLoader({transport,allowGoogleRpc:true})(wrapper);assert.equal(on.status,'UNVERIFIED');assert.equal(posts,1);
});
