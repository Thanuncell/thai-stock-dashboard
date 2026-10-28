'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService,FEEDS}=require('../server/news-service');
const {trustedEvidence}=require('../lib/news-evidence');
const {reviewNewsForDisplay}=require('../lib/news-quality');
const date=new Date(Date.now()-60000).toUTCString(),wrapper='https://news.google.com/rss/articles/investing-legacy-fixture';
const rss='<rss><channel><item><title>PTT รายงานผลประกอบการใหม่ - Investing.com</title><link>'+wrapper+'</link><source>Investing.com</source><pubDate>'+date+'</pubDate><description>PTT รายงานกำไรและแผนลงทุนจากข้อมูลสำนักข่าวต้นทาง</description></item></channel></rss>';
for(const flag of [undefined,'off','on'])for(const view of ['general','watchlist'])test('Investing legacy RSS '+view+' flag '+(flag??'unset')+' is independent of a direct adapter',async()=>{
 const queries=[];let articleCalls=0;const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_GOOGLE_NEWS_RPC:'off',...(flag===undefined?{}:{SETSCOPE_NEWS_INVESTING:flag})},
 fetchImpl:async value=>{const u=new URL(value);assert.equal(u.hostname,'news.google.com');queries.push(u.searchParams.get('q'));return new Response(view==='watchlist'||u.searchParams.get('q').includes('site:th.investing.com')?rss:'<rss><channel></channel></rss>');},
 articleFetch:async()=>{articleCalls++;throw Error('no direct Investing acquisition');}});
 for(let read=0;read<2;read++){const result=view==='general'?await service.getNews():await service.getWatchlistNews('PTT',{ownerId:'owner-a'});assert.equal(result.items.length,1);const item=result.items[0];assert.equal(item.sourceName,'Investing.com');assert.equal(item.source,'other');assert.equal(item.url,wrapper);assert.equal(item.verification.basis,'metadata');assert.ok(trustedEvidence(item));assert.equal(reviewNewsForDisplay(item).status,'UNVERIFIED');}
 assert.equal(articleCalls,0);if(view==='general'){assert.ok(queries.includes('site:th.investing.com when:30d'));assert.equal(queries.length,FEEDS.length*2);}else{assert.equal(queries.length,1);assert.equal((await service.getWatchlistNews('OR',{ownerId:'owner-b'})).items.length,0);}
});
test('Investing RSS keeps Hard Gate ON fail-closed without enabling direct acquisition',async()=>{
 const seen=[];const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'on',SETSCOPE_GOOGLE_NEWS_RPC:'off'},fetchImpl:async()=>new Response(rss),articleFetch:async value=>{seen.push(String(value));return new Response('<html>Unresolved Google wrapper</html>',{headers:{'content-type':'text/html'}});}});
 for(const result of [await service.getNews(),await service.getWatchlistNews('PTT',{ownerId:'a'})])assert.equal(result.items.length,0);
 assert.ok(seen.every(x=>new URL(x).hostname==='news.google.com'));assert.ok(seen.length<=6);
});
test('Investing metadata survives synthetic archive restart without becoming article evidence',async()=>{
 const {memoryTransport,env}=require('./fixtures/news-evidence.cjs'),{createNewsArchiveService}=require('../server/news-archive-service');
 const db=memoryTransport(),settings={env:{...env,SETSCOPE_P1_DISPLAY_GATE:'off'},fetchImpl:db.fetchImpl};const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write'},fetchImpl:async()=>new Response(rss),articleFetch:async()=>{throw Error('no hidden IO');}});
 const news=await service.getNews();assert.equal(news.items.length,1);await createNewsArchiveService(settings).ingest(news.items);const first=[...db.rows.values()][0];const fingerprint=first.fingerprint,seen=first.first_seen_at;
 const result=await createNewsArchiveService(settings).list();assert.equal(result.items.length,1);assert.equal(result.items[0].verification.basis,'metadata');assert.equal(reviewNewsForDisplay(result.items[0]).status,'UNVERIFIED');assert.equal(first.fingerprint,fingerprint);assert.equal(first.first_seen_at,seen);
});
