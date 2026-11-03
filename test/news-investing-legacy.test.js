'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService,FEEDS}=require('../server/news-service');
const date=new Date(Date.now()-60000).toUTCString();
const rss='<rss><channel><item><title>PTT รายงานผลประกอบการใหม่ - Investing.com</title><link>https://news.google.com/rss/articles/investing-legacy-fixture</link><source>Investing.com</source><pubDate>'+date+'</pubDate><description>PTT รายงานกำไรและแผนลงทุนจากข้อมูลสำนักข่าวต้นทาง</description></item></channel></rss>';
for(const flag of [undefined,'off','on'])for(const view of ['general','watchlist'])test('legacy Investing flag '+(flag??'unset')+' cannot reenable '+view+' news',async()=>{
 const queries=[];let articleCalls=0;
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'off',...(flag===undefined?{}:{SETSCOPE_NEWS_INVESTING:flag})},
 fetchImpl:async value=>{const u=new URL(value);assert.equal(u.hostname,'news.google.com');queries.push(u.searchParams.get('q'));return new Response(rss);},
 articleFetch:async()=>{articleCalls++;throw Error('No direct source requests');}});
 for(let i=0;i<2;i++)assert.equal((view==='general'?await service.getNews():await service.getWatchlistNews('PTT',{ownerId:'a'})).items.length,0);
 assert.equal(articleCalls,0);assert.ok(queries.every(q=>!q.includes('investing.com')));
 assert.equal(queries.length,view==='general'?FEEDS.length*2:1);
});
test('removed Investing source never attempts article loading with hard gate on',async()=>{
 let calls=0;const service=createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'on'},fetchImpl:async()=>new Response(rss),articleFetch:async()=>{calls++;throw Error('No article IO');}});
 assert.equal((await service.getNews()).items.length,0);assert.equal((await service.getWatchlistNews('PTT',{ownerId:'a'})).items.length,0);assert.equal(calls,0);
});
test('legacy removal retains the existing 365-day archive retention',()=>{
 assert.equal(require('../server/news-archive-service').RETENTION_DAYS,365);
});
