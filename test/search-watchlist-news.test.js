'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createStockSearchService,rankStockSearchResults}=require('../server/search-service');
const {createMarketService}=require('../server/market-service');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {createWatchlistNewsCacheKey,createMemoryCache,PROVIDER_POLICIES}=require('../server/reliability');
const rows=['THAI','THANI'].map(symbol=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified'}));
test('prefix search merges registry identities with partial provider results, ranks exact first and deduplicates',async()=>{
 const service=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>[{symbol:'THANI',name:'Ratchthani Leasing'},{symbol:'THAI',name:'Thai Airways'}]});
 assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);
 assert.equal((await service.search('thani'))[0].symbol,'THANI');
 assert.equal((await service.search('THAI.BK'))[0].name,'Thai Airways');
 assert.deepEqual(rankStockSearchResults('tha',[{symbol:'PTT',name:'PTT'},...rows]),rankStockSearchResults('tha',[...rows,{symbol:'PTT',name:'PTT'}]));
});
test('registry prefix survives foreign result crowding without another provider query',async()=>{
 let calls=0;
 const market=createMarketService({fetchImpl:async()=>{calls++;return Response.json({quotes:[{symbol:'THA',quoteType:'EQUITY'}]});}});
 const service=createStockSearchService({registrySearch:async()=>rows,providerSearch:market.search});
 assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);assert.equal(calls,1);
});
for(const status of [403,429,503])test(`search provider ${status} retains valid registry discovery without bypassing denial`,async()=>{
 let calls=0;const service=createStockSearchService({registrySearch:async()=>rows,providerSearch:async()=>{calls++;throw Object.assign(Error('unavailable'),{status});}});
 assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);assert.equal(calls,1);
});
test('search excludes invalid/inactive registry mappings and keeps name search/provider fallback compatible',async()=>{
 const service=createStockSearchService({registrySearch:async()=>[...rows,{...rows[0],symbol:'THAX',active:false},{...rows[0],symbol:'THAZ',provider_symbol:'OTHER.BK'}],providerSearch:async()=>[]});
 assert.deepEqual((await service.search('tha')).map(r=>r.symbol),['THAI','THANI']);
 const fallback=createStockSearchService({registrySearch:async()=>{throw Error('database unavailable');},providerSearch:async()=>[{symbol:'KBANK',name:'กสิกรไทย'}]});
 assert.equal((await fallback.search('กสิกร'))[0].symbol,'KBANK');
});
const NOW=Date.parse('2026-10-26T11:00:00Z');
const rss='<rss><channel><item><title>THAI รายงานผลประกอบการล่าสุด</title><link>https://news.google.com/articles/fixture-thai</link><pubDate>'+new Date(NOW).toUTCString()+'</pubDate><description>บริษัทเปิดเผยผลประกอบการและรายละเอียดการดำเนินงานล่าสุด</description><source>ทันหุ้น</source></item></channel></rss>';
test('valid RSS end-tag whitespace does not turn existing news into an empty result',async()=>{
 const service=createNewsService({now:()=>NOW,fetchImpl:async()=>new Response(rss.replace('</item>','</item >').replace('</channel>','</channel >').replace('</rss>','</rss >'))});
 assert.equal((await service.getWatchlistNews([{symbol:'THAI'}])).items.length,1);
});
for(const failure of ['html','truncated','429'])test(`Watchlist ${failure} preserves bounded same-owner news without leaking fallback to another owner`,async()=>{
 let broken=false,calls=0,time=NOW;
 const service=createNewsService({now:()=>time,fetchImpl:async()=>{calls++;return broken?failure==='429'?new Response('denied',{status:429}):new Response(failure==='html'?'<html>temporary error</html>':'<rss><channel><item>broken</channel></rss>'):new Response(rss);}});
 const stocks=[{symbol:'THAI',name:'THAI'}],before=await service.getWatchlistNews(stocks,{ownerId:'owner-a'});assert.equal(before.items.length,1);
 const beforeCalls=calls;broken=true;time+=1000;
 const retained=await service.getWatchlistNews(stocks,{ownerId:'owner-a',refresh:true});assert.equal(retained.items.length,1);assert.equal(retained.stale,true);assert.equal(retained.fetchedAt,before.fetchedAt);
 assert.equal((await service.getWatchlistNews(stocks,{ownerId:'owner-b'})).dataState,'unavailable');
 if(failure==='429')assert.equal(calls,beforeCalls+1);
 time+=31*60000;assert.equal((await service.getWatchlistNews(stocks,{ownerId:'owner-a',refresh:true})).dataState,'unavailable');
});
test('a valid empty refresh retains unexpired verified stories, while owner caches remain separate',async()=>{
 let empty=false;const service=createNewsService({now:()=>NOW,fetchImpl:async()=>new Response(empty?'<rss><channel></channel></rss>':rss)});
 assert.equal((await service.getWatchlistNews([{symbol:'THAI'}])).items.length,1);empty=true;
 const none=await service.getWatchlistNews([{symbol:'THAI'}],{refresh:true});assert.equal(none.items.length,1);assert.equal(none.stale,false);
 const cache=createMemoryCache(),stocks=[{symbol:'THAI',name:'Thai'}];let loads=0;
 const keyA=createWatchlistNewsCacheKey(stocks,'a'),keyB=createWatchlistNewsCacheKey(stocks,'b');assert.notEqual(keyA,keyB);
 await cache.get(keyA,PROVIDER_POLICIES.watchlistNews,async()=>++loads);await cache.get(keyB,PROVIDER_POLICIES.watchlistNews,async()=>++loads);
 assert.equal((await cache.get(keyA,PROVIDER_POLICIES.watchlistNews,async()=>++loads)).value,1);
 assert.equal((await cache.get(keyA,PROVIDER_POLICIES.watchlistNews,async()=>++loads,{force:true})).value,3);
 assert.equal((await cache.get(keyB,PROVIDER_POLICIES.watchlistNews,async()=>++loads)).value,2);
});
test('Watchlist News reports bounded no-match diagnostics without exposing the watchlist', async () => {
 const service=createNewsService({now:()=>NOW,fetchImpl:async()=>new Response('<rss><channel></channel></rss>')});
 const result=await service.getWatchlistNews([{symbol:'THAI',name:'THAI'}]);
 assert.equal(result.dataState,'fresh');
 assert.equal(result.items.length,0);
 assert.equal(result.matchedCandidates,0);
 assert.equal(result.qualityExcluded,0);
 assert.deepEqual(result.stockStatus.map(stock=>stock.symbol),['THAI']);assert.ok(!JSON.stringify(result).includes('ownerId'));
});

test('Watchlist distinguishes no-match from deterministic quality exclusions without accepting rejected news',async()=>{
 const rejected=rss.replace('THAI รายงานผลประกอบการล่าสุด','THAI Login').replace('https://news.google.com/articles/fixture-thai','https://www.kaohoon.com/login');
 const service=createNewsService({now:()=>NOW,fetchImpl:async()=>new Response(rejected)});
 const result=await service.getWatchlistNews([{symbol:'THAI'}]);
 assert.equal(result.items.length,0);assert.equal(result.matchedCandidates,1);assert.equal(result.qualityExcluded,1);
 assert.equal(service.quarantineReport()[0].status,'REJECTED');
});
