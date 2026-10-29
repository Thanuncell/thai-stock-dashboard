'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspectNewsArticle}=require('../lib/news-article');
const {reviewNewsItem,classifyNewsItem}=require('../lib/news-quality');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {createNewsArchiveService,planNewsArchiveCleanup}=require('../server/news-archive-service');
const {withNewsRulesSummary,fallbackNewsSummary}=require('../lib/news-summary');
const url='https://www.kaohoon.com/news/123',title='Company earnings announcement';
const text='This company announced its operating results, investment plan and disclosed the reporting period. This is synthetic fixture content, not actual market news.';
const ld=record=>'<script type="application/ld+json">'+JSON.stringify(record)+'</script>';
const article=(changes={})=>({'@type':'NewsArticle',url,headline:title,articleBody:text,...changes});
const input=(changes={})=>({title,url:'https://news.google.com/articles/item',source:'infoquest',sourceName:'InfoQuest',snippet:text,...changes});
const success=items=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({items})}]}]});
const rss=items=>'<rss><channel>'+items.map(item=>`<item><title>${item.title}</title><link>${item.url}</link><pubDate>${item.pubDate||new Date().toISOString()}</pubDate><description>${item.snippet||''}</description><source>${item.sourceName||'Thunhoon'}</source></item>`).join('')+'</channel></rss>';

test('rules require verified sufficient snippets, use earnings wording selectively and preserve actual AI',()=>{
 const earnings=input({title:'PTT รายงานผลประกอบการ',snippet:'บริษัทเปิดเผยตัวเลขกำไรและรายละเอียดผลประกอบการล่าสุด'});
 const summary='ข้อความข่าวมีคำสำคัญเกี่ยวกับผลประกอบการ ควรตรวจสอบตัวเลขและรายละเอียดจากข่าวต้นฉบับ';
 assert.equal(withNewsRulesSummary(earnings).analysisSummary,summary);
 assert.equal(withNewsRulesSummary({...earnings,snippet:'สั้น',url}).analysisSummary,'');
 assert.equal(withNewsRulesSummary({...earnings,snippet:'สั้น',url,analysisMode:'rules',analysisSummary:'Old unsupported rules'}).analysisSummary,'');
 assert.equal(withNewsRulesSummary({...earnings,analysisMode:'rules',analysisSummary:'Old positive wording'}).analysisSummary,summary);
 assert.equal(withNewsRulesSummary({...earnings,snippet:' '.repeat(100),url}).analysisMode,'');
 for(const status of ['UNVERIFIED','REJECTED'])assert.equal(withNewsRulesSummary({...earnings,verification:{status},analysisMode:'ai',analysisSummary:'must not pass'}),null);
 assert.equal(withNewsRulesSummary({...earnings,snippet:'',url:'https://news.google.com/articles/no-proof'}),null);
 assert.notEqual(withNewsRulesSummary(input({title:'โครงการลงทุนใหม่',snippet:'บริษัทแจ้งรายละเอียดโครงการลงทุนและแผนดำเนินงานล่าสุด'})).analysisSummary,summary);
 assert.equal(fallbackNewsSummary('x'),'');
 const actual={...earnings,analysisMode:'ai',analysisSummary:'Actual fixture AI result'};
 assert.deepEqual(withNewsRulesSummary(actual),actual);
});

test('archive-only verified rows get read-time rules without AI, writes or changing source rows',async()=>{
 const rows=[
  {fingerprint:'earnings',title:'PTT รายงานผลประกอบการ',url:'https://www.kaohoon.com/news/101',source:'kaohoon',source_name:'ข่าวหุ้น',snippet:'บริษัทเปิดเผยตัวเลขกำไรและรายละเอียดผลประกอบการล่าสุด',published_at:new Date().toISOString()},
  {fingerprint:'sparse',title:'PTT company announcement',url:'https://www.kaohoon.com/news/102',source:'kaohoon',snippet:'',published_at:new Date().toISOString()},
  {fingerprint:'uncertain',title:'PTT company announcement',url:'https://news.google.com/articles/no-proof',source:'infoquest',snippet:'',published_at:new Date().toISOString()},
  {fingerprint:'rejected',title:'Login',url:'https://www.kaohoon.com/login',source:'kaohoon',snippet:text,published_at:new Date().toISOString()}
 ];
 const before=structuredClone(rows);let calls=0;
 const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_synthetic'},fetchImpl:async(u,init)=>{
  assert.ok(!init.method||init.method==='GET');assert.ok(!String(u).includes('openai'));calls++;
  return Response.json(rows,{headers:{'content-range':'0-3/4'}});
 }});
 const result=await archive.list({featuredCount:0});assert.equal(calls,1);assert.equal(result.items.length,2);
 const earnings=result.items.find(row=>row.fingerprint==='earnings');assert.equal(earnings.analysisMode,'rules');assert.match(earnings.analysisSummary,/เกี่ยวกับผลประกอบการ/);
 const sparse=result.items.find(row=>row.fingerprint==='sparse');assert.equal(sparse.analysisSummary,'');assert.equal(sparse.analysisMode,'');
 assert.equal(result.quarantined,1);assert.equal(result.rejected,1);assert.deepEqual(rows,before);
});

for(const code of ['rate_limit_exceeded','insufficient_quota'])test('news and standalone rules remain usable when AI returns '+code,async()=>{
 let aiCalls=0;
 const news=input({title:'PTT รายงานผลประกอบการ',snippet:'บริษัทเปิดเผยตัวเลขกำไรและรายละเอียดผลประกอบการล่าสุด'});
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async value=>{
  if(String(value).includes('/rss/search?'))return new Response(rss([news]));
  if(String(value).includes('api.openai.com')){aiCalls++;return Response.json({error:{code}},{status:429});}
  return new Response('',{status:404});
 }});
 const feed=await service.getNews();assert.equal(feed.items[0].analysisMode,'rules');assert.equal(aiCalls,0);
 const analysis=await service.analyse([news]);assert.equal(analysis.mode,'rules');assert.equal(aiCalls,1);
 assert.equal((await service.getWatchlistNews([{symbol:'PTT'}])).items[0].analysisSummary,feed.items[0].analysisSummary);assert.equal(aiCalls,1);
});

// AI-provider failure fixtures use temporary article unavailability, not proven 404/410.
// Confirmed missing/document targets are covered by news-ws4-quality.test.js.
test('the same news can upgrade from cached upstream-429 Rules to real AI after bounded expiry',async()=>{
 let current=Date.now(),calls=0;
 const service=createNewsService({now:()=>current,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async value=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;
  return calls===1?Response.json({error:{code:'rate_limit_exceeded'}},{status:429})
   :Response.json(success([{id:0,summary:'Real result after temporary limit'}]));
 }});
 const news=input();assert.equal((await service.analyse([news])).mode,'rules');
 assert.equal((await service.analyse([news])).mode,'rules');assert.equal(calls,1);
 current+=5*60000+1;
 const recovered=await service.analyse([news]);assert.equal(recovered.mode,'ai');assert.equal(calls,2);
 assert.equal((await service.analyse([news])).items[0].summary,recovered.items[0].summary);assert.equal(calls,2);
});

test('JSON-LD article identity binds URL/type before articleBody and ignores a longer related article',()=>{
 assert.equal(inspectNewsArticle(ld(article()),{url,title}).text,text);
 assert.equal(inspectNewsArticle(ld(article({url:url+'9'})),{url,title}).status,'REJECTED');
 assert.equal(inspectNewsArticle(ld(article({'mainEntityOfPage':{'@id':url+'9'}})),{url,title}).status,'REJECTED');
 assert.equal(inspectNewsArticle(ld(article({'@type':'Organization'})),{url,title}).status,'UNVERIFIED');
 const result=inspectNewsArticle(ld({'@graph':[article({url:url+'9',articleBody:'UNRELATED '.repeat(100)}),article()]}),{url,title});
 assert.equal(result.text,text);assert.ok(!result.text.includes('UNRELATED'));
 assert.equal(inspectNewsArticle('<link rel="canonical" href="'+url+'9">'+ld(article()),{url,title}).status,'REJECTED');
});
test('genuine HTML, canonical/relative identity and existing title changes have safe fallbacks',()=>{
 const html='<article><h1>'+title+'</h1><p>'+text+'</p></article>';
 assert.equal(inspectNewsArticle(html,{url,title}).status,'VERIFIED');
 assert.equal(inspectNewsArticle(ld(article({url:'/news/123?utm_source=rss'})),{url,title}).status,'VERIFIED');
 assert.equal(inspectNewsArticle(ld(article({url:'https://kaohoon.com/news/123#article'})),{url,title}).status,'VERIFIED');
 assert.equal(inspectNewsArticle(ld(article({headline:'Updated headline for the same verified URL'})),{url,title}).status,'VERIFIED');
 assert.equal(inspectNewsArticle(ld(article({url:undefined}))+'<link rel="canonical" href="'+url+'">',{url,title}).status,'VERIFIED');
 assert.equal(inspectNewsArticle('<link rel="canonical">'+'<article>'+text+'</article>',{url,title}).status,'REJECTED');
 assert.equal(inspectNewsArticle('<article>'+text+'</article>',{url,title}).status,'UNVERIFIED');
 assert.equal(inspectNewsArticle('<html>Access denied</html>',{url,title}).status,'UNVERIFIED');
 assert.equal(inspectNewsArticle(ld(article({url:url+'9'}))+html,{url,title}).text, title+' '+text);
});
test('metadata ambiguity and explicit failed verification cannot claim verification',()=>{
 assert.equal(classifyNewsItem(input({snippet:''})).accepted,false);
 assert.equal(reviewNewsItem(input({snippet:''})).status,'UNVERIFIED');
 assert.equal(reviewNewsItem(input()).status,'VERIFIED');
 assert.equal(reviewNewsItem(input({verification:{status:'UNVERIFIED',accepted:true}})).status,'UNVERIFIED');
 assert.equal(reviewNewsItem(input({verification:{status:'REJECTED',accepted:true}})).status,'REJECTED');
 assert.equal(reviewNewsItem(input({title:'Login',url:'https://www.kaohoon.com/login'}),{status:'VERIFIED'}).status,'REJECTED');
});
test('risky probe budget never lets remaining unverified items escape quarantine',async()=>{
 const items=Array.from({length:5},(_,i)=>input({title:'PTT '+title+' '+i,url:'https://news.google.com/articles/risky-'+i,sourceName:'Thunhoon',snippet:''}));
 let targetCalls=0;
 const service=createNewsService({fetchImpl:async value=>{
  const u=String(value);if(u.includes('/rss/search?'))return new Response(rss(items));
  if(u.includes('news.google.com/articles/'))return new Response('',{status:302,headers:{location:'https://thunhoon.com/article/'+u.split('-').at(-1)}});
  targetCalls++;const i=u.split('/').at(-1);
  return new Response('<article><h1>PTT '+title+' '+i+'</h1>'+text+'</article>',{headers:{'content-type':'text/html'}});
 }});
 const result=await service.getNews();assert.equal(result.items.length,3);assert.equal(targetCalls,3);
 assert.ok(result.items.every(item=>item.verification.status==='VERIFIED'));assert.equal(service.quarantineReport().length,2);
 const watch=await service.getWatchlistNews([{symbol:'PTT',name:'Company earnings announcement'}]);
 assert.equal(watch.items.length,5);assert.equal(targetCalls,5,'a later Watchlist request verifies the other two; it never accepts them without evidence');
});
test('403/429/timeout uncertainty stays quarantined in News and Watchlist; genuine metadata remains usable',async()=>{
 for(const status of [403,429,'timeout']){
  let calls=0;const item=input({title:'PTT company announcement',snippet:'',sourceName:'Thunhoon'});
  const service=createNewsService({fetchImpl:async value=>{
   if(String(value).includes('/rss/search?'))return new Response(rss([item]));calls++;
   if(status==='timeout')throw Error('timeout');return new Response('',{status});
  }});
  assert.equal((await service.getNews()).items.length,0);
  assert.equal((await service.getWatchlistNews([{symbol:'PTT',name:'PTT company'}])).items.length,0);
  assert.equal(service.quarantineReport()[0].status,'UNVERIFIED');assert.equal(calls,status==='timeout'?2:1,'only transient timeout gets one bounded retry');
 }
 const service=createNewsService({fetchImpl:async()=>new Response(rss([input({title:'PTT company earnings announcement'})]))});
 assert.equal((await service.getNews()).items.length,1);
 assert.equal((await service.getWatchlistNews([{symbol:'PTT',name:'PTT company'}])).items.length,1);
});
test('archive hides and reports uncertain rows before featured/pagination/dedup without writes',async()=>{
 const good=Array.from({length:14},(_,i)=>({fingerprint:'g'+i,title:title+i,url:'https://news.google.com/articles/g'+i,
  source:'infoquest',source_name:'InfoQuest',snippet:text,published_at:new Date(Date.now()-i*60000).toISOString(),matched_symbols:['PTT']}));
 const rows=[...good,{...good[0],fingerprint:'duplicate',url:good[0].url+'?utm_source=copy'},
  {...good[0],fingerprint:'unknown',url:'https://news.google.com/articles/unknown',snippet:''},
  {...good[0],fingerprint:'bad',title:'Login',url:'https://www.kaohoon.com/login'}];
 const before=structuredClone(rows);let calls=0;
 const archive=createNewsArchiveService({env:{SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_synthetic'},fetchImpl:async(u,init)=>{
  assert.ok(!init.method||init.method==='GET');assert.equal(init.headers.Authorization,undefined);calls++;
  return Response.json(rows,{headers:{'content-range':'0-16/17'}});
 }});
 const a=await archive.list({page:1,pageSize:5,featuredCount:3}),b=await archive.list({page:2,pageSize:5,featuredCount:3});
 assert.equal(a.total,11);assert.equal(a.quarantined,1);assert.equal(a.rejected,1);assert.equal(a.deduplicated,1);assert.equal(calls,1);
 assert.equal(new Set([...a.featured,...a.items,...b.items].map(x=>x.url)).size,13);
 assert.equal((await archive.list({query:'no match',featuredCount:3})).total,0);
 assert.equal(planNewsArchiveCleanup(rows).writes,0);assert.deepEqual(rows,before);
 assert.equal((await archive.ingest([input({pubDate:new Date().toISOString(),verification:{status:'UNVERIFIED'}})])).ingested,0);assert.equal(calls,1);
});
for(const failure of [400,429,'timeout','malformed','incomplete','wrong-id','duplicate','refusal'])test('AI '+failure+' is bounded and never labelled AI',async()=>{
 let request,signal,aiCalls=0;const logs=[];
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-secret'},analysisTimeoutMs:15,logger:{warn:(...x)=>logs.push(x)},fetchImpl:async(value,init)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});aiCalls++;request=JSON.parse(init.body);signal=init.signal;
  if(failure==='timeout')return new Promise(()=>{});
  if(typeof failure==='number')return Response.json({error:{code:'unsupported_value',param:'text.format.type',message:'synthetic-secret '+text}},{status:failure});
  if(failure==='malformed')return new Response('not JSON');
  if(failure==='incomplete')return Response.json({...success([{id:0,summary:'partial'}]),status:'incomplete'});
  if(failure==='refusal')return Response.json({status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]});
  return Response.json(success(failure==='duplicate'?[{id:0,summary:'one'},{id:0,summary:'two'}]:[{id:99,summary:'wrong'}]));
 }});
 const result=await service.analyse([input()]);assert.equal(result.items[0].mode,'rules');assert.equal(aiCalls,1);
 assert.equal(request.text.format.type,'json_schema');assert.equal(request.store,false);assert.match(request.input,/JSON/);
 if(failure==='timeout')assert.equal(signal.aborted,true);
 assert.ok(!JSON.stringify(logs).includes('synthetic-secret'));assert.ok(!JSON.stringify(logs).includes(text));
 assert.equal((await service.analyse([input()])).items[0].mode,'rules');assert.equal(aiCalls,1);
});
test('AI id binding, cache identity and expiry preserve true analysis outcomes',async()=>{
 let now=Date.now(),calls=0;const service=createNewsService({now:()=>now,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value,init)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;
  const material=JSON.parse(JSON.parse(init.body).input.split('\n').slice(1).join('\n'));
  return Response.json(success(material.map(item=>({id:item.id,summary:'summary '+item.id+' call '+calls})).reverse()));
 }});
 const first=await service.analyse([input(),input({url:'https://news.google.com/articles/second'})]);
 assert.equal(first.mode,'ai');assert.match(first.items[0].summary,/summary 0/);assert.match(first.items[1].summary,/summary 1/);
 assert.equal((await service.analyse([input()])).items[0].summary,first.items[0].summary);assert.equal(calls,1);
 await service.analyse([input({url:'https://news.google.com/articles/third'})]);assert.equal(calls,2);
 now+=7*60*60*1000;await service.analyse([input()]);assert.equal(calls,3);
 const absent=await service.analyse([input({snippet:'',url:'https://news.google.com/articles/empty'})]);assert.equal(absent.mode,'unavailable');assert.equal(absent.items[0].summary,'');
});
test('mismatched articleBody is never sent to AI; RSS snippet fallback is labelled as snippet',async()=>{
 let seen;
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value,init)=>{
  if(String(value).includes('api.openai.com')){seen=JSON.parse(init.body).input;return Response.json(success([{id:0,summary:'Fixture summary'}]));}
  return new Response(ld(article({url:url+'9',articleBody:'WRONG ARTICLE SECRET '.repeat(20)})),{headers:{'content-type':'text/html'}});
 }});
 const result=await service.analyse([input({url})]);assert.equal(result.items[0].mode,'ai');assert.equal(result.items[0].basis,'snippet');
 assert.ok(!seen.includes('WRONG ARTICLE SECRET'));assert.ok(seen.includes(text));
});

test('uncertain article checks preserve verified LKG only for the same Watchlist owner and recover',async()=>{
 let time=Date.now(),uncertain=false;
 const service=createNewsService({now:()=>time,fetchImpl:async value=>{
  if(String(value).includes('/rss/search?'))return new Response(rss([input({title:'PTT company announcement',pubDate:new Date(time).toISOString(),snippet:uncertain?'':text,sourceName:uncertain?'Thunhoon':'InfoQuest'})]));
  return new Response('',{status:403});
 }});
 const stocks=[{symbol:'PTT',name:'PTT company'}];
 await service.getNews();await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});uncertain=true;time+=1000;
 assert.equal((await service.getNews()).dataState,'stale');
 const a=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});assert.equal(a.dataState,'stale');assert.equal(a.items.length,1);
 const b=await service.getWatchlistNews(stocks,{ownerId:'B'});assert.equal(b.dataState,'unavailable');assert.equal(b.items.length,0);
 uncertain=false;time+=1000;assert.equal((await service.getNews()).dataState,'fresh');
});

test('mixed Watchlist verification is partial while cache, owner isolation and bounded LKG remain intact',async()=>{
 let time=Date.now(),mode='fresh';
 const good=input({title:'PTT company earnings announcement',url:'https://news.google.com/articles/good'});
 const unknown=input({title:'PTT company announcement',url:'https://news.google.com/articles/unknown',snippet:'',sourceName:'Thunhoon'});
 const service=createNewsService({now:()=>time,fetchImpl:async value=>{
  if(String(value).includes('/rss/search?'))return new Response(rss((mode==='fresh'?[good]:mode==='mixed'?[good,unknown]:[unknown]).map(item=>({...item,pubDate:new Date(time).toISOString()}))));
  return new Response('',{status:403});
 }});
 const stocks=[{symbol:'PTT',name:'PTT company'}];
 const fresh=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});
 assert.equal(fresh.dataState,'fresh');assert.equal(fresh.partial,false);assert.equal(fresh.stale,false);
 mode='mixed';time+=1000;
 const mixed=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});
 assert.equal(mixed.dataState,'partial');assert.equal(mixed.partial,true);assert.equal(mixed.stale,false);
 assert.deepEqual(mixed.items.map(item=>item.url),[good.url]);assert.equal(service.quarantineReport()[0].status,'UNVERIFIED');
 mode='uncertain';time+=1000;
 const other=await service.getWatchlistNews(stocks,{ownerId:'B'});
 assert.equal(other.dataState,'unavailable');assert.equal(other.items.length,0);
 const retained=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});
 assert.equal(retained.dataState,'stale');assert.equal(retained.partial,true);assert.equal(retained.stale,true);
 assert.deepEqual(retained.items,mixed.items);assert.equal(retained.fetchedAt,mixed.fetchedAt);
 time+=31*60000;
 const expired=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});
 assert.equal(expired.dataState,'unavailable');assert.equal(expired.items.length,0);
 mode='fresh';time+=1000;
 const recovered=await service.getWatchlistNews(stocks,{ownerId:'A',refresh:true});
 assert.equal(recovered.dataState,'fresh');assert.equal(recovered.partial,false);assert.equal(recovered.stale,false);
});

test('article extraction stops a denied acquisition origin while retaining labelled RSS snippet analysis',async()=>{
 let articleCalls=0;
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(String(value).includes('api.openai.com'))return Response.json(success([{id:0,summary:'Snippet-only fixture summary'}]));
  articleCalls++;return new Response('',{status:403});
 }});
 const first=await service.analyse([input({url})]);assert.equal(first.items[0].basis,'snippet');
 const second=await service.analyse([input({url:url+'9'})]);assert.equal(second.items[0].basis,'snippet');
 assert.equal(articleCalls,1,'new items cannot retry a denied article origin');
});

test('analysis respects negative verification and cannot be authorized by a client-supplied VERIFIED flag',async()=>{
 let calls=0;const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async()=>{calls++;throw Error('Unexpected request');}});
 const result=await service.analyse([input({verification:{status:'UNVERIFIED'}}),input({verification:{status:'REJECTED'}}),
  input({snippet:'',verification:{status:'VERIFIED'}}),null]);
 assert.ok(result.items.every(item=>item.mode==='unavailable'));assert.equal(calls,0);
});
test('OpenAI 429 uses a bounded provider cooldown and preserves labelled fallback', async () => {
 let current=Date.parse('2026-10-27T04:00:00.000Z'), aiCalls=0;
 const service=createNewsService({now:()=>current,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});
  aiCalls++;
  if(aiCalls===1)return Response.json({error:{code:'rate_limit_exceeded'}},{status:429,headers:{'retry-after':'120'}});
  return Response.json(success([{id:0,summary:'AI answer after cooldown'}]));
 }});
 const first=await service.analyse([input({url:'https://news.google.com/articles/cooldown-1'})]);
 assert.equal(first.items[0].mode,'rules');assert.equal(aiCalls,1);
 const second=await service.analyse([input({url:'https://news.google.com/articles/cooldown-2'})]);
 assert.equal(second.items[0].mode,'rules');assert.equal(aiCalls,1,'other articles cannot bypass the cooldown');
 current+=121000;
 const recovered=await service.analyse([input({url:'https://news.google.com/articles/cooldown-3'})]);
 assert.equal(recovered.items[0].mode,'ai');assert.equal(aiCalls,2);
});

test('concurrent identical analysis shares one provider result and deduplicates batch material',async()=>{
 let calls=0,release;
 const service=createNewsService({env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});
  calls++;await new Promise(resolve=>{release=resolve;});
  return Response.json(success([{id:0,summary:'Shared synthetic result'}]));
 }});
 const first=service.analyse([input(),input()]);
 while(!release)await new Promise(resolve=>setImmediate(resolve));
 const second=service.analyse([input()]);release();
 const [a,b]=await Promise.all([first,second]);
 assert.equal(calls,1);assert.deepEqual(a.items[0],b.items[0]);assert.deepEqual(a.items[0],a.items[1]);assert.equal(b.mode,'ai');
});

for(const retryAfter of ['600','Tue, 27 Oct 2026 04:10:00 GMT','invalid',''])test('429 respects cooldown header '+JSON.stringify(retryAfter),async()=>{
 let current=Date.parse('2026-10-27T04:00:00Z'),calls=0;
 const start=current,delay=retryAfter===''||retryAfter==='invalid'?300000:600000;
 const service=createNewsService({now:()=>current,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;
  return calls===1?new Response('not-json',{status:429,headers:{'retry-after':retryAfter}}):Response.json(success([{id:0,summary:'Recovered fixture'}]));
 }});
 assert.equal((await service.analyse([input({url:url+'/1'})])).mode,'rules');
 current=start+delay-1;assert.equal((await service.analyse([input({url:url+'/2'})])).mode,'rules');assert.equal(calls,1);
 current=start+delay+1;assert.equal((await service.analyse([input({url:url+'/3'})])).mode,'ai');assert.equal(calls,2);
});

test('quota 429 stops further provider requests for this service instance without automatic retry',async()=>{
 let current=Date.now(),calls=0;
 const service=createNewsService({now:()=>current,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;
  return Response.json({error:{code:'insufficient_quota'}},{status:429});
 }});
 assert.equal((await service.analyse([input()])).mode,'rules');current+=24*60*60*1000;
 assert.equal((await service.analyse([input({url:url+'/other'})])).mode,'rules');assert.equal(calls,1);
});

test('a temporary 429 code is not permanently blocked by a broader quota error type',async()=>{
 let current=Date.now(),calls=0;
 const service=createNewsService({now:()=>current,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;
  return calls===1?Response.json({error:{code:'rate_limit_exceeded',type:'insufficient_quota'}},{status:429,headers:{'retry-after':'60'}})
   :Response.json(success([{id:0,summary:'Recovered temporary limit'}]));
 }});
 assert.equal((await service.analyse([input()])).mode,'rules');current+=61000;
 assert.equal((await service.analyse([input({url:url+'/after'})])).mode,'ai');assert.equal(calls,2);
});

test('ignored AI abort cannot cache late output or start an immediate repeated request',async()=>{
 let calls=0,release,signal;
 const service=createNewsService({analysisTimeoutMs:10,env:{OPENAI_API_KEY:'synthetic-key'},fetchImpl:async(value,init)=>{
  if(!String(value).includes('api.openai.com'))return new Response('',{status:503});calls++;signal=init.signal;
  await new Promise(resolve=>{release=resolve;});return Response.json(success([{id:0,summary:'Late output must not win'}]));
 }});
 assert.equal((await service.analyse([input()])).mode,'rules');assert.equal(signal.aborted,true);
 assert.equal((await service.analyse([input({url:url+'/other'})])).mode,'rules');assert.equal(calls,1);
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.equal((await service.analyse([input()])).mode,'rules');
});
