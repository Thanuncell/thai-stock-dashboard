'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsService}=require('../server/news-service');
const date=new Date(Date.now()-60000).toUTCString();
const entry=(name,id)=>'<item><title>PTT รายงานกำไรและแผนลงทุนใหม่ '+id+'</title><link>https://news.google.com/rss/articles/'+id+'</link><source>'+name+'</source><pubDate>'+date+'</pubDate><description>PTT รายงานข้อมูลบริษัทและผลประกอบการจากสำนักข่าวต้นทาง</description></item>';
const rss='<rss><channel>'+entry('กรุงเทพธุรกิจ','bkk-uncovered')+entry('ฐานเศรษฐกิจ','than-uncovered')+entry('Investing.com','investing-uncovered')+'</channel></rss>';
for(const view of ['general','watchlist'])test('both optional adapters failing preserve all three legacy RSS publishers: '+view,async()=>{
 const service=createNewsService({env:{SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_NEWS_BANGKOKBIZNEWS:'on',SETSCOPE_NEWS_THANSETTAKIJ:'on'},fetchImpl:async()=>new Response(rss),articleFetch:async()=>{throw Error('optional source unavailable');}});
 const result=view==='general'?await service.getNews():await service.getWatchlistNews('PTT',{ownerId:'a'});assert.equal(result.items.length,3);assert.deepEqual(new Set(result.items.map(x=>x.sourceName)),new Set(['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ','Investing.com']));assert.ok(result.items.every(x=>x.verification.basis==='metadata'));
});

const {dedupeNewsItems,newsFingerprint}=require('../lib/broker-news');
const {article,memoryTransport,env:archiveEnv}=require('./fixtures/news-evidence.cjs');
const {issueEvidence,trustedEvidence,canonicalUrl,projectEvidence}=require('../lib/news-evidence');
const {inspectNewsArticle}=require('../lib/news-article');
const {reviewNewsForDisplay,reviewNewsItem}=require('../lib/news-quality');
function resolved(originalUrl){
 const item=article({matchedSymbols:['PTT']});
 const inspection=inspectNewsArticle('<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:item.url,headline:item.title,datePublished:item.pubDate,articleBody:'Synthetic article verification content only. '.repeat(5)})+'</script>',{url:item.url,title:item.title,strict:true});
 item.verification=issueEvidence(item,{status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article'},{inspection,originalUrl,pathway:'fixture/rss-resolved'});return item;
}
test('trusted article identity deduplicates RSS wrappers without changing fingerprints or proof',()=>{
 const wrapper='https://news.google.com/rss/articles/proven-original',native=resolved(wrapper),metadata={...native,url:wrapper,verification:{status:'VERIFIED',basis:'metadata'},matchedSymbols:['OR'],matchedBrokerFirms:['KGI']};
 const before=newsFingerprint(native);for(const order of [[metadata,native],[native,metadata]]){const items=dedupeNewsItems(order);assert.equal(items.length,1);assert.equal(items[0].url,native.url);assert.equal(newsFingerprint(items[0]),before);assert.equal(trustedEvidence(items[0]).originalUrl,wrapper);assert.equal(reviewNewsForDisplay(items[0]).status,'VERIFIED');assert.deepEqual(items[0].matchedSymbols,['PTT']);assert.deepEqual(items[0].matchedBrokerFirms,[]);}
});
test('untrusted canonical/resolved URL and serialized proof cannot suppress another RSS article',()=>{
 const native=resolved('https://news.google.com/rss/articles/proven-one'),fake={...JSON.parse(JSON.stringify(native)),url:'https://news.google.com/rss/articles/unrelated',canonicalUrl:native.url,resolvedUrl:native.url};
 assert.equal(dedupeNewsItems([fake,native]).length,2);assert.equal(trustedEvidence(fake),null);
 const other={...fake,url:'https://news.google.com/rss/articles/another'};assert.equal(dedupeNewsItems([fake,other]).length,2,'same title alone is insufficient');
});
test('canonical tracking aliases deduplicate while article identity and query IDs remain distinct',()=>{
 const native=resolved('https://news.google.com/rss/articles/proven-two'),before=newsFingerprint(native);
 const duplicate={...native,url:native.url.replace('https://','https://www.')+'/?utm_campaign=x&fbclid=y'};
 const result=dedupeNewsItems([duplicate,native]);assert.equal(result.length,1);assert.equal(result[0].url,native.url);assert.ok(trustedEvidence(result[0]));assert.equal(newsFingerprint(native),before);
 assert.equal(dedupeNewsItems([{...duplicate,url:native.url+'?id=1'},{...duplicate,url:native.url+'?id=2'}]).length,2);
});
test('a trusted bridge merges earlier wrapper and canonical groups without losing either alias',()=>{
 const wrapper='https://news.google.com/rss/articles/bridge',native=resolved(wrapper),rss={...native,url:wrapper,verification:null};
 const direct={...native,verification:null};const result=dedupeNewsItems([rss,direct,native,{...rss}]);assert.equal(result.length,1);assert.ok(trustedEvidence(result[0]));assert.equal(result[0].url,native.url);
});
for(const hardGate of [false,true])for(const view of ['general','watchlist'])test('RSS retains partial adapter coverage with Gate '+hardGate+': '+view,async()=>{
 const {createNewsService}=require('../server/news-service');const {SITEMAP:bkkMap}=require('../server/news-bangkokbiznews'),{SITEMAP:thanMap}=require('../server/news-thansettakij');
 const native={url:'https://bangkokbiznews.com/finance/stock/1234567',title:'PTT รายงานกำไรและแผนลงทุนใหม่',pubDate:new Date(date).toISOString()};
 const map='<urlset><url><loc>'+native.url+'</loc><news:news><news:publication><news:name>Bangkokbiznews</news:name></news:publication><news:title>'+native.title+'</news:title><news:publication_date>'+native.pubDate+'</news:publication_date></news:news></url></urlset>';
 const html='<link rel="canonical" href="'+native.url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:native.url,headline:native.title,datePublished:native.pubDate})+'</script><h1>'+native.title+'</h1><div id="paragraph-1" data-news-content="company" class="content-detail"><p>'+('บริษัท PTT รายงานแผนลงทุนและผลประกอบการตามต้นฉบับ '.repeat(6))+'</p></div>';
 const calls=[];const service=createNewsService({env:{SETSCOPE_NEWS_BANGKOKBIZNEWS:'on',SETSCOPE_NEWS_THANSETTAKIJ:'on',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:hardGate?'on':'off',SETSCOPE_GOOGLE_NEWS_RPC:'off'},fetchImpl:async()=>new Response(rss),articleFetch:async value=>{const url=String(value);calls.push(url);if(url===bkkMap)return new Response(map,{headers:{'content-type':'text/xml'}});if(url===thanMap)throw Error('optional unavailable');if(url===native.url)return new Response(html,{headers:{'content-type':'text/html'}});return new Response('<html>Unresolved wrapper</html>',{headers:{'content-type':'text/html'}});}});
 const result=view==='general'?await service.getNews():await service.getWatchlistNews('PTT',{ownerId:'coverage-owner'});assert.equal(result.items.length,hardGate?1:4);assert.equal(result.items.filter(x=>reviewNewsForDisplay(x).status==='VERIFIED').length,1);assert.equal(result.items.filter(x=>x.verification.basis==='metadata').length,hardGate?0:3);
 assert.equal(calls.filter(x=>new URL(x).hostname==='news.google.com').length,hardGate?3:0);assert.ok(calls.length<=6);
});
test('canonical grouping happens before archive totals/pages and preserves stored AI and first seen',async()=>{
 const db=memoryTransport(),one=article({matchedSymbols:['PTT']}),two={...one,url:one.url.replace('https://','https://www.')+'?utm_source=fixture'};
 two.verification=projectEvidence(one,two,one.verification);one.analysisMode=two.analysisMode='ai';one.analysisSummary=two.analysisSummary='Stored AI preserved';
 const {createNewsArchiveService}=require('../server/news-archive-service');const settings={env:archiveEnv,fetchImpl:db.fetchImpl};await createNewsArchiveService(settings).ingest([one,two]);for(const row of db.rows.values()){row.analysis_mode='ai';row.analysis_summary='Stored AI preserved';}const baseline=[...db.rows.values()].map(x=>[x.fingerprint,x.first_seen_at,x.analysis_summary]);assert.equal(baseline.length,2,'grouping does not delete stored rows');
 const service=createNewsArchiveService(settings);const read=await service.list({page:1,pageSize:10});assert.equal(read.total,1);assert.equal(read.items.length,1);assert.equal(read.items[0].analysisSummary,'Stored AI preserved');assert.equal(reviewNewsForDisplay(read.items[0]).status,'VERIFIED');assert.deepEqual([...db.rows.values()].map(x=>[x.fingerprint,x.first_seen_at,x.analysis_summary]),baseline);
});

test('dedicated publisher queries supplement every existing Google RSS query within a fixed pass',async()=>{
 const {FEEDS}=require('../server/news-service');const legacy=['site:thunhoon.com','site:kaohoon.com','site:settrade.com','site:set.or.th','site:bot.or.th','"Infoquest"','site:efinancethai.com'];for(const query of [...legacy,'site:bangkokbiznews.com','site:thansettakij.com'])assert.ok(FEEDS.some(x=>x[2]===query));assert.equal(FEEDS.filter(x=>x[0]==='broker').length,1);
 const queries=[];const service=createNewsService({env:{},fetchImpl:async value=>{queries.push(new URL(value).searchParams.get('q'));return new Response('<rss><channel></channel></rss>');},articleFetch:async()=>{throw Error('adapters OFF');}});await service.getNews();assert.equal(queries.length,FEEDS.length);assert.equal(new Set(queries).size,FEEDS.length);
});
