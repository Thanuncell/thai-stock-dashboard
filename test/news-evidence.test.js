'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { article,memoryTransport,env } = require('./fixtures/news-evidence.cjs');
const { reviewNewsItem } = require('../lib/news-quality');
const { createNewsArchiveService,reviewArchivedNewsRow } = require('../server/news-archive-service');
const { issueEvidence,canonicalUrl,rowSubjectHash } = require('../lib/news-evidence');
const { newsFingerprint } = require('../lib/broker-news');
const { createNewsService } = require('../server/news-service');
const { getAssessments } = require('../lib/news-evidence');

test('RSS discovery, article probe and archive retain private trusted evidence end to end',async()=>{
  const url='https://thunhoon.com/article-123456',date=new Date().toUTCString();
  const news=createNewsService({fetchImpl:async input=>{
    if(String(input).includes('/rss/search?'))return new Response(`<rss><channel><item><title>Q3</title><link>https://news.google.com/articles/opaque</link><source>Thunhoon</source><pubDate>${date}</pubDate></item></channel></rss>`);
    if(String(input).includes('news.google.com/articles/opaque'))return new Response('',{status:302,headers:{location:url}});
    return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:'Q3',articleBody:'Synthetic real article body for identity testing only. '.repeat(4)})+'</script>',{headers:{'content-type':'text/html'}});
  }});
  const result=await news.getNews();assert.equal(result.items.length,1);assert.equal(result.items[0].verification.basis,'article');
  const db=memoryTransport();await db.service().ingest(result.items,{assessments:getAssessments(result)});
  assert.equal((await db.service().list()).items.length,1);
  assert.ok(!JSON.stringify(result).includes('assessments'));
  assert.equal([...db.rows.values()][0].verification_provenance.originalUrl,'https://news.google.com/articles/opaque');
});

test('confirmed canonical rejection is retained privately and a later verified article clears quarantine',async()=>{
  let now=Date.now(),missing=false;
  const url='https://thunhoon.com/article-123456';
  const news=createNewsService({now:()=>now,fetchImpl:async input=>{
    if(String(input).includes('/rss/search?'))return new Response(`<rss><channel><item><title>Q3</title><link>https://news.google.com/articles/opaque</link><source>Thunhoon</source><pubDate>${new Date(now).toUTCString()}</pubDate></item></channel></rss>`);
    if(String(input).includes('news.google.com/articles/opaque'))return new Response('',{status:302,headers:{location:url}});
    if(missing)return new Response('',{status:404});
    return new Response('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,articleBody:'Synthetic article identity fixture only. '.repeat(5)})+'</script>',{headers:{'content-type':'text/html'}});
  }});
  assert.equal((await news.getNews()).items.length,1);
  now+=7*3600000;missing=true;
  const rejected=await news.getNews();assert.equal(rejected.items.length,0);
  assert.ok(getAssessments(rejected).some(x=>x.item.url===url&&x.verification.status==='REJECTED'));
  assert.ok(news.quarantineReport().some(x=>x.url===url));
  now+=7*3600000;missing=false;
  assert.equal((await news.getNews()).items.length,1);assert.equal(news.quarantineReport().length,0);
});

test('AC-G1-01: article-only verification survives persist, read and service restart',async()=>{
  const db=memoryTransport(),item=article();
  assert.equal((await db.service().ingest([item])).ingested,1);
  const result=await db.service().list();
  assert.equal(result.items.length,1);assert.equal(result.items[0].verification.basis,'article');
  assert.equal(result.items[0].verification.status,'VERIFIED');
  assert.equal(reviewNewsItem(result.items[0]).basis,'article');
  assert.ok(!JSON.stringify(result).includes('verification_subject_hash'));
});
test('AC-G1-02: JSON/clone/spoof cannot grant positive evidence; metadata basis is stable',async()=>{
  const valid=article(),spoof=JSON.parse(JSON.stringify(valid)),db=memoryTransport();
  assert.equal(reviewNewsItem(spoof).status,'UNVERIFIED');
  assert.equal((await db.service().ingest([spoof])).ingested,0);assert.equal(db.calls.length,0);
  const metadata={...spoof,snippet:'Sufficient synthetic source snippet for metadata verification'};
  const first=reviewNewsItem(metadata);assert.equal(first.basis,'metadata');
  assert.equal(reviewNewsItem({...metadata,verification:first}).basis,'metadata');
  assert.equal(reviewNewsItem({...valid,title:'Changed subject'}).status,'UNVERIFIED');
  assert.equal(reviewNewsItem({...metadata,verification:{status:'REJECTED',accepted:true}}).status,'REJECTED');
});
test('AC-G1-03: legacy verified/unknown/rejected remain distinct and no read deletes data',async()=>{
  const row={title:'Q3',url:'https://news.google.com/articles/legacy',source:'other',source_name:'Unknown publisher',
    snippet:'Sufficient synthetic source evidence for a genuine news item',published_at:new Date().toISOString(),verification_revision:0};
  assert.equal(reviewArchivedNewsRow(row).status,'VERIFIED');
  assert.equal(reviewArchivedNewsRow({...row,snippet:''}).status,'UNVERIFIED');
  assert.equal(reviewArchivedNewsRow({...row,title:'Login'}).status,'REJECTED');
  const before=JSON.stringify(row);reviewArchivedNewsRow(row);assert.equal(JSON.stringify(row),before);
});
test('AC-G1-04: canonical identity is additive and duplicate ingest keeps trusted article evidence',async()=>{
  const first=article(),second={...JSON.parse(JSON.stringify(first)),snippet:'Sufficient synthetic metadata snippet for the duplicate'};
  const db=memoryTransport();await db.service().ingest([first,second]);assert.equal(db.rows.size,1);
  assert.equal([...db.rows.values()][0].verification_basis,'article');
  const a='https://www.thunhoon.com/article-123456/?fbclid=tracking',b='https://thunhoon.com/article-123456';
  assert.equal(canonicalUrl(a),canonicalUrl(b));assert.notEqual(newsFingerprint({url:a}),newsFingerprint({url:b}));
});
test('AC-G1-05: changed subject, policy or malformed evidence never gains legacy fallback',async()=>{
  const db=memoryTransport();await db.service().ingest([article()]);const row=[...db.rows.values()][0];
  for(const changed of [{...row,snippet:'Changed content'}, {...row,verification_policy_version:'unknown'},
    {...row,verification_subject_hash:null},{...row,canonical_key:'incorrect'}])assert.equal(reviewArchivedNewsRow(changed).status,'UNVERIFIED');
  assert.equal(row.verification_subject_hash,rowSubjectHash(row));
});
test('AC-G1-06: failed database write is not acknowledged and cleanup failure cannot erase a commit',async()=>{
  const failed=memoryTransport({failWrite:true});await assert.rejects(failed.service().ingest([article()]));assert.equal(failed.rows.size,0);
  const cleanup=memoryTransport({failCleanup:true});const result=await cleanup.service().ingest([article()]);
  assert.equal(result.ingested,1);assert.equal(result.cleanupUnavailable,true);assert.equal((await cleanup.service().list()).items.length,1);
});
test('AC-G1-07: private negative assessments stay server-side and cannot insert rejected archive rows',async()=>{
  const item=article();const denied=issueEvidence(item,{status:'UNVERIFIED',reason:'ARTICLE_NOT_VERIFIED',basis:'article'});
  const db=memoryTransport();await db.service().ingest([],{assessments:[{item,verification:{...denied}}]});
  assert.equal(db.calls.length,0,'serialized/untrusted negative cannot modify shared archive');
});
test('AC-G1-08: legacy mode never queries added columns or calls evidence RPC',async()=>{
  const calls=[];const service=createNewsArchiveService({env:{...env,SETSCOPE_NEWS_EVIDENCE:''},fetchImpl:async(url,init={})=>{
    calls.push(String(url));return init.method==='POST'?new Response(null,{status:204}):Response.json([],{headers:{'content-range':'0-0/0'}});
  }});
  await service.list();assert.ok(calls.every(url=>!url.includes('verification_')&&!url.includes('upsert_news_archive_evidence')));
});

test('read-only compatibility mode makes zero write or cleanup requests',async()=>{
  const service=createNewsArchiveService({env:{...env,SETSCOPE_NEWS_EVIDENCE:'read'},fetchImpl:()=>{throw Error('Unexpected write');}});
  assert.equal((await service.ingest([article()])).persistence,'read-only');
});
