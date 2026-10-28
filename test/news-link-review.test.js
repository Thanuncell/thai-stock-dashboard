'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsLinkReview}=require('../server/news-link-review');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {createNewsArchiveService}=require('../server/news-archive-service');
const {identifySetSecurities}=require('../lib/news-set-security');
const {newsDisplayBlocked,newsSecuritySymbols,newsClickUrl}=require('../lib/news-content');
const {reviewNewsItem}=require('../lib/news-quality');
const {article,memoryTransport}=require('./fixtures/news-evidence.cjs');
const {createNewsTransport}=require('../lib/news-fetch');
const {fixtureRequest}=require('./fixtures/news-https.cjs');
const date=new Date(Date.now()-60000).toISOString(),url='https://www.set.or.th/th/market/news-and-alert/newsdetails?id=fixture';
const item=(overrides={})=>({title:'แจ้งการเลิกกิจการของบริษัทย่อย - SET',url,source:'settrade',sourceName:'SET',pubDate:date,snippet:'',matchedSymbols:[],...overrides});
const registry=['PTT','PTTEP','OR'].map((symbol,i)=>({symbol,provider_symbol:symbol+'.BK',provider:'Yahoo Finance',active:true,status:'verified',company_name_en:['PTT PUBLIC COMPANY LIMITED','PTT EXPLORATION AND PRODUCTION PUBLIC COMPANY LIMITED','PTT OIL AND RETAIL BUSINESS PUBLIC COMPANY LIMITED'][i],name_source:'https://market.sec.or.th/public/idisc/en/company/listed/'+symbol,name_checked_at:date}));
function html(news=item(),{about=[],body='รายละเอียดเกี่ยวกับบริษัทและผลประกอบการที่เผยแพร่จากต้นทาง '.repeat(5),published=date,canonical=news.url}={}){
 return '<link rel="canonical" href="'+canonical+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:news.url,headline:news.title.replace(/ - SET$/,''),datePublished:published,articleBody:body,about})+'</script>';
}
const response=(body,type='text/html',status=200)=>new Response(body,{status,headers:{'content-type':type}});
const reviewer=(transport,extra={})=>createNewsLinkReview({transport,registrySearch:async()=>registry,...extra});

test('official issuer metadata identifies multiple securities, with independent G1 metadata and display URL',async()=>{
 const news=item();news.verification=reviewNewsItem(news);const before=JSON.stringify(news);
 const review=reviewer(async()=>response(html(news,{about:[{'@type':'Corporation',tickerSymbol:'XBKK PTT'},{'@type':'Corporation',tickerSymbol:'SET:PTTEP'}]})));
 const projected=(await review.review([news]))[0];
 assert.equal(projected.linkVerification.status,'VERIFIED');assert.deepEqual(projected.securityIdentification.symbols,['PTT','PTTEP']);assert.equal(newsClickUrl(projected),url);
 assert.equal(projected.verification,news.verification);assert.equal(projected.verification.basis,'metadata');assert.equal(JSON.stringify(news),before);assert.deepEqual(projected.matchedSymbols,[]);
 assert.equal(createNewsService({env:{SETSCOPE_P1_DISPLAY_GATE:'on'},displayProject:review.project}).filterForDisplay({items:[projected]}).items.length,0);
});
test('issuer identification handles names, OR ambiguity, unknown, conflicting names, duplicate/inactive registry and publisher scope',()=>{
 const news=item(),project=(about,rows=registry)=>identifySetSecurities(news,{url,html:html(news,{about})},rows);
 assert.deepEqual(project([{'@type':'Corporation',legalName:registry[2].company_name_en}]).symbols,['OR']);
 assert.deepEqual(project([{'@type':'Corporation',legalName:'บริษัท ปตท. จำกัด (มหาชน)'}]).symbols,['PTT']);
 assert.deepEqual(project([{'@type':'Corporation',legalName:'บริษัท ปตท. น้ำมันและการค้าปลีก จำกัด (มหาชน)'}]).symbols,['OR']);
 assert.deepEqual(project([]).symbols,[]);
 assert.deepEqual(identifySetSecurities(news,{url,html:html(news),text:'growth or investment'},registry).symbols,[]);
 assert.deepEqual(identifySetSecurities(news,{url,html:html(news),text:'หุ้น OR เปิดเผยผลประกอบการ'},registry).symbols,['OR']);
 assert.deepEqual(project([{'@type':'Corporation',tickerSymbol:'PTT',legalName:registry[1].company_name_en}]).symbols,[]);
 assert.deepEqual(project([{'@type':'Corporation',tickerSymbol:'PTT'}],[...registry,registry[0]]).symbols,[]);
 assert.deepEqual(project([{'@type':'Corporation',tickerSymbol:'PTT'}],registry.map(x=>({...x,active:false}))).symbols,[]);
 for(const host of ['kaohoon.com','thunhoon.com','infoquest.co.th','efinancethai.com','investing.com','bangkokbiznews.com','prachachat.net'])assert.equal(identifySetSecurities({...news,source:'other',sourceName:host},{url:'https://'+host+'/article',html:html(news)},registry),null);
 assert.deepEqual(identifySetSecurities(news,{url:'https://www.infoquest.co.th/2026/a',html:html(news)},registry).symbols,[]);
 assert.deepEqual(identifySetSecurities(news,{url,html:html(news,{canonical:'https://www.set.or.th/other',about:[{'@type':'Corporation',tickerSymbol:'PTT'}]})},registry).symbols,[]);
});
test('RSS symbols, snippets, unrelated JSON/footer and caller-supplied issuer/link claims cannot create identity',async()=>{
 const news=item({matchedSymbols:['OR'],snippet:'หุ้น OR',securityIdentification:{status:'IDENTIFIED',symbols:['OR'],publisherUrl:url},linkVerification:{status:'VERIFIED',kind:'ARTICLE'},displayUrl:'https://evil.invalid/'});
 const review=reviewer(async()=>response('<h1>ข่าว</h1><footer>หุ้น OR</footer><script type="application/ld+json">'+JSON.stringify({'@type':'WebSite',about:{'@type':'Corporation',tickerSymbol:'OR'}})+'</script>'));
 const result=(await review.review([news]))[0];assert.deepEqual(result.securityIdentification.symbols,[]);assert.equal(result.displayUrl,undefined);assert.equal(result.linkVerification.status,'UNVERIFIED');
});
for(const [name,transport,kind,reason] of [
 ['redirect PDF',async u=>String(u)===url?new Response('',{status:302,headers:{location:'https://media.set.or.th/download?id=fixture'}}):response('%PDF-1.7 synthetic','application/pdf'),'DOCUMENT','DOCUMENT_RESPONSE'],
 ['PDF disguised as HTML',async()=>response('%PDF-1.7 synthetic'),'DOCUMENT','PDF_RESPONSE_SIGNATURE'],
 ['binary PDF',async()=>response('%PDF-1.7 synthetic','application/octet-stream'),'DOCUMENT','PDF_RESPONSE_SIGNATURE'],
 ['login',async()=>response('<form><input type="password"></form>'),'NON_ARTICLE','LOGIN_FORM'],
 ['profile',async u=>String(u)===url?new Response('',{status:302,headers:{location:'https://www.set.or.th/company-profile/PTT'}}):response('<h1>ข้อมูลบริษัท</h1>'),'NON_ARTICLE','COMPANY_PROFILE_PATH'],
 ['listing',async u=>String(u)===url?new Response('',{status:302,headers:{location:'https://www.set.or.th/category/news'}}):response('<h1>ข่าวล่าสุด</h1>'),'NON_ARTICLE','ARCHIVE_LISTING_PATH'],
 ['missing article date',async()=>response(html(item(),{published:''})),'UNKNOWN','ARTICLE_DATE_UNVERIFIED'],
 ['404',async()=>response('missing','text/html',404),'NON_ARTICLE','LINK_HTTP_404'],
 ['network',async()=>{throw Error('synthetic network outage');},'UNKNOWN','ARTICLE_NOT_VERIFIED'],
 ['non-HTML',async()=>response('{}','application/json'),'UNKNOWN','LINK_CONTENT_TYPE_UNVERIFIED'],
 ['canonical mismatch',async()=>response(html(item(),{canonical:'https://www.set.or.th/other'})),'UNKNOWN','LINK_CANONICAL_IDENTITY_UNVERIFIED']
])test('link outcome '+name+' is read-only UNVERIFIED without fabricated rejection',async()=>{
 const news=item();news.verification=reviewNewsItem(news);const original=JSON.stringify(news),review=reviewer(transport),result=(await review.review([news]))[0];
 assert.equal(result.linkVerification.kind,kind);assert.equal(result.linkVerification.reason,reason);assert.equal(result.linkVerification.status,'UNVERIFIED');assert.equal(JSON.stringify(news),original);
 assert.equal(newsDisplayBlocked(result),['DOCUMENT','NON_ARTICLE'].includes(kind));
});
test('wrapper redirect precedes proof, RPC OFF holds uncertainty but does not blanket-hide metadata when display OFF',async()=>{
 const news=item({url:'https://news.google.com/rss/articles/fixture'});news.verification=reviewNewsItem(news);let calls=0;
 const review=reviewer(async()=>{calls++;return response('<div>Google wrapper</div>');}),result=(await review.review([news]))[0];
 assert.equal(result.linkVerification.reason,'WRAPPER_RPC_DISABLED');assert.equal(calls,1);
 assert.equal(createNewsService({env:{},displayProject:review.project}).filterForDisplay({items:[result]}).items.length,1);
 const resolved=reviewer(async u=>String(u)===news.url?new Response('',{status:302,headers:{location:url}}):response(html(item())));
 const good=(await resolved.review([news]))[0];assert.equal(good.linkVerification.status,'VERIFIED');assert.equal(good.url,news.url);assert.equal(good.displayUrl,url);
});
test('bounded candidate window, cache, denial and timeout never drain or retry a denied source',async()=>{
 let calls=0;const review=reviewer(async()=>{calls++;return response('', 'text/html',403);});
 const news=Array.from({length:20},(_,i)=>item({url:url+'&n='+i}));
 await review.review(news);await review.review(news);assert.equal(calls,1);
 let more=0;const bounded=reviewer(async()=>{more++;return response(html(item()));});
 await bounded.review(news);await bounded.review(news);assert.equal(more,3);
 const timeout=reviewer(async(_u,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(Error('timeout')),{once:true})));
 const result=await timeout.inspect(item(),{signal:AbortSignal.timeout(10)});assert.equal(result.link.status,'UNVERIFIED');
});
test('runtime pinned transport rejects private/rebinding destinations before request, including redirect hops',async()=>{
 let sockets=0,lookups=0;const transport=createNewsTransport({lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];},requestImpl:()=>{sockets++;throw Error('Must not connect');}});
 const result=(await reviewer(transport).review([item()]))[0];assert.equal(result.linkVerification.status,'UNVERIFIED');assert.equal(sockets,0);assert.equal(lookups,1);
 let n=0;const pinned=createNewsTransport({lookup:async()=>[{address:++n===1?'8.8.8.8':'127.0.0.1',family:4}],requestImpl:fixtureRequest(async()=>{sockets++;return new Response('',{status:302,headers:{location:'https://www.settrade.com/th/news-and-articles/news/123-fixture'}});})});
 const redirected=(await reviewer(pinned).review([item()]))[0];assert.equal(redirected.linkVerification.status,'UNVERIFIED');assert.equal(sockets,1);
});
for(const hardGate of [false,true])test('link findings filter all views, search/counts and cache without changing archive rows; gate '+hardGate,async()=>{
 const db=memoryTransport(),env={SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-fixture',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:hardGate?'on':'off'};
 const good=article({title:'PTT ข่าวจริงกล่าวถึง PDF สำหรับนักลงทุน',source:'settrade',sourceName:'SET',url,matchedSymbols:['PTT']});
 const bad=article({title:'PTT ข่าวผิดปลายทาง',url:'https://thunhoon.com/opaque',matchedSymbols:['PTT']});
 const review=reviewer(async u=>String(u)===url?response(html(good,{about:[{'@type':'Corporation',tickerSymbol:'PTT'}]})):response('%PDF-x','application/pdf'));
 const archive=createNewsArchiveService({env,fetchImpl:db.fetchImpl,displayReview:review.review,displayProject:review.project});await archive.ingest([good,bad]);
 const before=JSON.stringify([...db.rows.values()]);db.calls.length=0;
 const first=await archive.list({pageSize:1,query:'PTT'});assert.equal(first.total,1);assert.equal(first.items[0].title,good.title);
 assert.equal((await archive.list({featuredCount:1})).featured.length,1);assert.equal((await archive.list({page:2,pageSize:1})).items.length,0);
 assert.equal((await archive.list({symbol:'PTT'})).total,1);
 const service=createNewsService({env,displayProject:review.project});assert.equal(service.filterForDisplay({items:[good,bad],total:2}).total,1);
 const domain=await import('../client/domain.mjs'),values=[review.project(good),review.project(bad)];
 assert.equal(domain.selectNewsForDisplay(values,{hardGate}).featured.length,1);assert.equal(domain.selectNewsForDisplay(values,{hardGate,featuredCount:0}).latest.length,1);
 assert.equal(domain.retainWatchlistNews(values,[{symbol:'PTT'}],Date.now(),{hardGate}).length,1);assert.equal(domain.matchesNewsQuery(values[0],'ptt'),true);
 assert.equal(JSON.stringify([...db.rows.values()]),before);assert.ok(db.calls.every(c=>!c.init.method||c.init.method==='GET'));
});
module.exports={registry,item,html,date,url};


test('source-scoped security and links survive cache uncertainty without stale negatives resurfacing',async()=>{
 let now=Date.now(),deny=false;
 const review=reviewer(async()=>{if(deny)throw Error('offline');return response('%PDF-x','application/pdf');},{now:()=>now});
 const old=item();const blocked=(await review.review([old]))[0];assert.equal(newsDisplayBlocked(blocked),true);
 now+=300001;deny=true;await review.review([old]);assert.equal(newsDisplayBlocked(review.project(old)),true);
 // Even an evicted display response can retain a negative restriction, never positive authority.
 const fresh=reviewer(async()=>{throw Error('no request');});assert.equal(newsDisplayBlocked(fresh.project(blocked)),true);
 assert.deepEqual(newsSecuritySymbols(item({securityIdentification:{status:'IDENTIFIED',symbols:['OR'],publisherUrl:'https://www.infoquest.co.th/2026/x'}})),[]);
 assert.equal(newsSecuritySymbols({...item(),source:'infoquest',sourceName:'InfoQuest',matchedSymbols:['PTT']}),null);
});


test('canonical-bound SET labels identify issuer without turning an announcement into Article VERIFIED',()=>{
 const news=item(),headline=news.title.replace(/ - SET$/,'');
 const source='<link rel="canonical" href="'+url+'"><main><h1>'+headline+'</h1><dl><dt>หลักทรัพย์</dt><dd>PTT PTTEP</dd><dt>แหล่งข่าว</dt><dd>PTT PTTEP</dd></dl><h2>รายละเอียดแบบเต็ม</h2><p>ข้อความประกาศ</p></main>';
 assert.deepEqual(identifySetSecurities(news,{url,html:source},registry).symbols,['PTT','PTTEP']);
 assert.deepEqual(identifySetSecurities(news,{url,html:source.replace('PTT PTTEP</dd><dt>แหล่งข่าว','OR</dd><dt>แหล่งข่าว')},registry).symbols,[]);
 assert.deepEqual(identifySetSecurities(news,{url,html:source.replace('<main>','<footer>').replace('</main>','</footer>')},registry).symbols,[]);
});


test('DNS lookup timeout cannot hold an article request or open a late private/public socket',async()=>{
 const controller=new AbortController();let sockets=0;const timer=setTimeout(()=>controller.abort(),10);
 const transport=createNewsTransport({lookup:async()=>new Promise(()=>{}),requestImpl:()=>{sockets++;throw Error('No connection after DNS timeout');}});
 try{await assert.rejects(transport(url,{signal:controller.signal}),/NEWS_REQUEST_ABORTED/);assert.equal(sockets,0);}finally{clearTimeout(timer);}
});


test('a confirmed invalid raw fallback cannot reappear after bounded LRU eviction',async()=>{
 const review=reviewer(async()=>response('%PDF-x','application/pdf'));let broken=false;
 const headline='PTT อัปเดตข้อมูลบริษัทล่าสุด',link='https://thunhoon.com/fallback-link';
 const feed='<rss><channel><item><title>'+headline+'</title><link>'+link+'</link><pubDate>'+date+'</pubDate><description>รายละเอียดผลการดำเนินงานบริษัท PTT</description><source>Thunhoon</source></item></channel></rss>';
 const service=createNewsService({env:{},displayProject:review.project,fetchImpl:async()=>broken?response('unavailable','text/html',503):response(feed,'application/rss+xml')});
 const first=await service.getNews();assert.ok(first.items.length);await review.review(first.items);
 assert.equal(service.filterForDisplay(first).items.length,0);
 for(let i=0;i<201;i++)await review.inspect(item({url:url+'&evict='+i}));
 broken=true;const stale=await service.getNews();assert.equal(stale.stale,true);assert.equal(service.filterForDisplay(stale).items.length,0);
});
test('already aborted article request performs neither DNS lookup nor socket I/O',async()=>{
 let lookups=0;const controller=new AbortController();controller.abort();
 const transport=createNewsTransport({lookup:async()=>{lookups++;return [{address:'8.8.8.8',family:4}];}});
 await assert.rejects(transport(url,{signal:controller.signal}),/NEWS_REQUEST_ABORTED/);assert.equal(lookups,0);
});


test('one shared loader prevents AI/article paths from retrying a link-review source denial',async()=>{
 const {createNewsArticleLoader}=require('../lib/news-resolver');let calls=0;
 const transport=async()=>{calls++;return response('denied','text/html',403);};
 const articleLoader=createNewsArticleLoader({transport,allowGoogleRpc:false});
 const review=createNewsLinkReview({loadArticle:articleLoader});await review.review([item()]);
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-fixture'},articleLoader,articleFetch:transport,fetchImpl:async()=>{throw Error('No new AI/provider request after source denial');}});
 await service.analyse([item()]);assert.equal(calls,1);
});


test('coalesced public source facts do not share owner associations, stored AI or first-seen fields',async()=>{
 let calls=0;const review=reviewer(async()=>{calls++;await Promise.resolve();return response(html(item(),{about:[{'@type':'Corporation',tickerSymbol:'PTT'}]}));});
 const a=item({matchedSymbols:['PTT'],analysisSummary:'Owner A stored AI',firstSeenAt:'2026-01-01T00:00:00Z'}),b=item({matchedSymbols:['OR'],analysisSummary:'Owner B stored AI',firstSeenAt:'2026-02-01T00:00:00Z'});
 const [[ra],[rb]]=await Promise.all([review.review([a]),review.review([b])]);assert.equal(calls,1);
 assert.deepEqual(ra.matchedSymbols,['PTT']);assert.deepEqual(rb.matchedSymbols,['OR']);assert.equal(ra.analysisSummary,a.analysisSummary);assert.equal(rb.analysisSummary,b.analysisSummary);
 assert.equal(ra.firstSeenAt,a.firstSeenAt);assert.equal(rb.firstSeenAt,b.firstSeenAt);assert.deepEqual(ra.securityIdentification.symbols,['PTT']);assert.deepEqual(rb.securityIdentification.symbols,['PTT']);
});
