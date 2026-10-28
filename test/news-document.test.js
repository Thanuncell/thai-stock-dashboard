'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {annotateNewsContent,reviewNewsItem,reviewNewsForDisplay}=require('../lib/news-quality'),{inspectNewsArticle}=require('../lib/news-article'),{issueEvidence}=require('../lib/news-evidence');
const {createNewsService}=require('./fixtures/news-service.cjs'),{createNewsArchiveService}=require('../server/news-archive-service'),{memoryTransport,article}=require('./fixtures/news-evidence.cjs');
const title='0528NWS271020261715395120T.pdf - SET - SET',date=new Date(Date.now()-60000).toISOString();
const document=()=>({title,url:'https://news.google.com/rss/articles/set-document',source:'settrade',sourceName:'SET',pubDate:date,snippet:'Existing SET metadata; document contents and date have not been verified'});
test('document classification preserves G1 metadata but never labels it article VERIFIED',()=>{
 const item=document();item.verification=reviewNewsItem(item);
 const off=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write'}}).filterForDisplay({items:[item]});
 assert.equal(off.items.length,0);const classified=annotateNewsContent(item);
 assert.equal(classified.contentType,'OFFICIAL_DOCUMENT');assert.equal(classified.articleVerified,false);assert.equal(classified.documentVerification.status,'UNVERIFIED');
 assert.equal(item.verification.status,'VERIFIED');assert.equal(item.verification.basis,'metadata');
 assert.notEqual(reviewNewsForDisplay(item).status,'VERIFIED');
});
test('PDF cannot acquire article evidence from Article-shaped HTML or caller-supplied VERIFIED',()=>{
 const url='https://media.set.or.th/news/notice.pdf',item={...document(),url,contentType:'ARTICLE_NEWS',articleVerified:true};
 const html='<link rel="canonical" href="'+url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url,headline:title,datePublished:date,articleBody:'Synthetic article-looking payload in a PDF URL '.repeat(8)})+'</script>';
 const inspection=inspectNewsArticle(html,{url,title,strict:true});assert.notEqual(inspection.status,'VERIFIED');
 assert.equal(issueEvidence(item,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{inspection}),null);
});
test('both gates hide legacy PDF while preserving archive/AI/fingerprint/first_seen without writes',async()=>{
 const db=memoryTransport(),item=document(),env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_NEWS_EVIDENCE:'write'};
 const off=createNewsArchiveService({env,fetchImpl:db.fetchImpl});await off.ingest([item]);const row=[...db.rows.values()][0];row.analysis_summary='Existing stored AI';row.analysis_mode='ai';
 const before=structuredClone(row);assert.equal((await off.list({featuredCount:1})).featured.length,0);assert.equal((await off.list()).total,0);
 const on=createNewsArchiveService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'on'},fetchImpl:db.fetchImpl});
 assert.equal((await on.list({featuredCount:1})).featured.length,0);assert.equal((await on.list()).total,0);assert.deepEqual([...db.rows.values()][0],before);
});
test('real article proof stays distinct from metadata and document evidence',()=>{
 const good=article(),service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'on'}});
 const shown=service.filterForDisplay({items:[good]}).items[0];assert.equal(shown.contentType,'ARTICLE_NEWS');assert.equal(shown.articleVerified,true);
 const metadata={...document(),title:'SET เผยภาวะตลาดล่าสุด',url:'https://www.set.or.th/news/article-1'};metadata.verification=reviewNewsItem(metadata);
 const off=createNewsService({env:{}}).filterForDisplay({items:[metadata]}).items[0];assert.equal(off.articleVerified,false);
});


test('classification ignores caller claims and catches encoded document URLs without rejecting ordinary PDF reporting',()=>{
 const {newsContentType}=require('../lib/news-content');
 assert.equal(newsContentType({...document(),contentType:'ARTICLE_NEWS',articleVerified:true}),'OFFICIAL_DOCUMENT');
 assert.equal(newsContentType({...document(),title:'รายงานตลาด',url:'https://media.set.or.th/notice%2Epdf'}),'OFFICIAL_DOCUMENT');
 assert.equal(newsContentType({title:'รายงานตลาด',url:'https://www.kaohoon.com/news/report.pdf',source:'kaohoon'}),'OTHER_DOCUMENT');
 assert.equal(newsContentType({title:'บริษัทเปิดตัว PDF สำหรับนักลงทุน',url:'https://www.kaohoon.com/news/123'}),'ARTICLE_NEWS');
 const copy=annotateNewsContent({...document(),documentVerification:{status:'VERIFIED'}});
 assert.equal(copy.documentVerification.status,'UNVERIFIED');
});

test('document metadata cannot trigger article extraction or a new AI summary',async()=>{
 let calls=0;const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-fixture'},fetchImpl:async()=>{calls++;throw Error('No document article request allowed');}});
 const result=await service.analyse([{...document(),verification:{status:'VERIFIED',basis:'article'}}]);
 assert.equal(calls,0);assert.equal(result.items[0].mode,'unavailable');assert.equal(result.items[0].summary,'');
});
