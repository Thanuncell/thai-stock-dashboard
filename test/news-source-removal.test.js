'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {FEEDS,createNewsService}=require('../server/news-service');
const {NEWS_FILTER_SOURCES,normalizeNewsSources,newsMatchesSources,newsDisplayBlocked,isRemovedNewsPublisher}=require('../lib/news-content');
const {reviewNewsItem,reviewNewsForDisplay}=require('../lib/news-quality');
const {createNewsArchiveService,reviewArchivedNewsRow,planNewsArchiveCleanup}=require('../server/news-archive-service');
const {memoryTransport,env}=require('./fixtures/news-evidence.cjs');
const date=new Date(Date.now()-60000).toISOString();
const deleted={title:'PTT reports better earnings - Investing.com',url:'https://news.google.com/rss/articles/removed-article',
 source:'other',sourceName:'Investing.com',snippet:'PTT reports better earnings for Thailand stocks and investors.',pubDate:date};
const normal={title:'PTT reports better earnings',url:'https://news.google.com/rss/articles/other-article',
 source:'infoquest',sourceName:'InfoQuest',snippet:'บริษัทประกาศรายงานผลประกอบการและผลการดำเนินงานจากต้นทาง',pubDate:date};
const row=item=>({fingerprint:item===deleted?'removed':'retained',title:item.title,url:item.url,source:item.source,
 source_name:item.sourceName,snippet:item.snippet,published_at:item.pubDate,fetched_at:item.pubDate,first_seen_at:item.pubDate,
 matched_symbols:[],broker_firms:[]});
const rssItems=rows=>'<rss><channel>'+rows.map(item=>'<item><title>'+item.title+'</title><link>'+item.url+'</link><source>'+item.sourceName+'</source><pubDate>'+date+'</pubDate><description>'+item.snippet+'</description></item>').join('')+'</channel></rss>';
test('Investing RSS query, roadmap enablement and filter chip are removed',()=>{
 assert.equal(FEEDS.some(([,name,q])=>/investing/i.test(name+' '+q)),false);
 assert.equal(NEWS_FILTER_SOURCES.includes('investing'),false);
 assert.equal(normalizeNewsSources('investing'),'all');
 assert.equal(normalizeNewsSources('investing,infoquest'),'infoquest');
 const policy=require('../lib/news-policy');
 assert.equal(policy.NEWS_PUBLISHERS.some(x=>/investing/.test(x.host)),false);
 assert.equal(policy.ROADMAP_NEWS_PUBLISHERS.some(x=>/investing/.test(x.host)&&x.enabled),false);
});
test('removed publisher is excluded without removing unrelated other publishers',()=>{
 const other={...normal,source:'other',sourceName:'กรุงเทพธุรกิจ'};
 const hosts=['https://th.investing.com/news/stock-market-news/a-123','https://www.investing.com/news/stock-market-news/a-123'];
 for(const url of hosts)assert.equal(isRemovedNewsPublisher({...other,url}),true);
 for(const item of [deleted,{...deleted,sourceName:'other'}, {...deleted,title:'untitled',url:'https://th.investing.com/news/foo-123',sourceName:'other'}]){
  assert.equal(isRemovedNewsPublisher(item),true);
  assert.equal(newsDisplayBlocked(item),true);
  assert.equal(reviewNewsItem(item).status,'REJECTED');
  assert.equal(reviewNewsItem(item).reason,'REMOVED_NEWS_PUBLISHER');
  assert.equal(reviewNewsForDisplay(item).status,'UNVERIFIED');
 }
 assert.equal(isRemovedNewsPublisher({...other,title:'Investing.com covered in a market story'}),false);
 assert.equal(newsMatchesSources(other,'other'),true);
 assert.equal(newsMatchesSources(deleted,'other'),false);
 assert.equal(newsMatchesSources(normal,'investing'),true);
});
test('Google RSS cannot reintroduce removed outlet through other feed results or Watchlist News',async()=>{
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'off',SETSCOPE_P1_DISPLAY_GATE:'off'},
  fetchImpl:async()=>new Response(rssItems([deleted,normal]),{headers:{'content-type':'application/rss+xml'}}),
  articleFetch:async()=>{throw Error('No publisher IO');}});
 const general=await service.getNews();
 assert.equal(general.items.some(isRemovedNewsPublisher),false);
 assert.ok(general.items.some(item=>item.sourceName==='InfoQuest'));
 const watched=await service.getWatchlistNews('PTT',{ownerId:'owner-a'});
 assert.equal(watched.items.some(isRemovedNewsPublisher),false);
 assert.ok(watched.items.some(item=>item.sourceName==='InfoQuest'),'Watchlist retains other publishers');
});
test('legacy archive rows stay stored but cannot pass read or write gating',async()=>{
 const db=memoryTransport(),a=row(deleted),b=row(normal);
 db.rows.set(a.fingerprint,a);db.rows.set(b.fingerprint,b);
 const service=createNewsArchiveService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_NEWS_ARCHIVE_QUERY:'off'},
  fetchImpl:db.fetchImpl});
 const before=JSON.stringify([...db.rows.values()]);
 const listed=await service.list({source:'all'});
 assert.equal(listed.items.some(isRemovedNewsPublisher),false);
 assert.ok(listed.items.some(item=>item.sourceName==='InfoQuest'));
 assert.equal(reviewArchivedNewsRow(a).status,'REJECTED');
 const plan=planNewsArchiveCleanup([a,b]);
 assert.ok(plan.candidates.some(x=>x.fingerprint===a.fingerprint&&x.reason==='REMOVED_NEWS_PUBLISHER'));
 await service.ingest([deleted]);
 assert.ok(db.calls.every(call=>(call.init.method||'GET')==='GET'),'removed-only ingestion performs zero writes, cleanup or deletes');
 assert.equal(JSON.stringify([...db.rows.values()]),before);
});
test('existing archive index generation remains compatible without a new migration',()=>{
 assert.equal(require('../server/news-archive-query').NEWS_QUERY_POLICY_VERSION,'news-query-2');
});
