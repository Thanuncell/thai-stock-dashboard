'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createNewsSourceReliability}=require('../server/news-source-reliability');
const {createNewsService}=require('./fixtures/news-service.cjs');
const {createNewsWorker}=require('../server/news-work');
const {createNewsWorkStore}=require('../server/news-work-store');
const A='https://thunhoon.com/article-ws5',B='https://kaohoon.com/news/123';
const xml='<rss><channel><item><title>PTT รายงานผลประกอบการและการลงทุนล่าสุด</title><link>https://news.google.com/rss/articles/ws5</link><source>Thunhoon</source><pubDate>'+new Date(Date.now()-60000).toISOString()+'</pubDate><description>PTT เปิดเผยข้อมูลการลงทุนและผลประกอบการตามต้นทาง</description></item></channel></rss>';
test('WS5: discovery checkpoint outage cannot erase healthy RSS coverage',async()=>{
 const service=createNewsService({env:{},fetchImpl:async()=>new Response(xml),onDiscovered:async()=>{throw Error('synthetic DB failure');}});
 assert.equal((await service.getNews()).items.length,1);
});
test('WS5: worker cancellation interrupts pending handler and retains retry checkpoint',async()=>{
 let release;const controller=new AbortController(),calls=[];
 const job={id:1,stage:'extraction',payload:{original:true},attempts:1};
 const store={enabled:true,claim:async()=>[job],finish:async(_j,action,options)=>{calls.push({action,...options});return true;}};
 const run=createNewsWorker({store,timeoutMs:1000,extract:()=>new Promise(r=>{release=r;})}).runOnce({signal:controller.signal});
 await new Promise(r=>setImmediate(r));controller.abort();
 const result=await Promise.race([run,new Promise(r=>setTimeout(()=>r(null),50))]);
 release({late:true});assert.ok(result,'abort must not wait for worker timeout');assert.equal(calls[0].action,'retry');assert.deepEqual(job.payload,{original:true});
});
test('WS5: worker honors HTTP Retry-After and keeps DB-failure work inspectable',async()=>{
 let transition;const store={enabled:true,claim:async()=>[{id:1,stage:'persistence',payload:{original:true},attempts:1}],finish:async(_j,_a,x)=>{transition=x;return true;}};
 await createNewsWorker({store,persist:async()=>{throw Object.assign(Error('synthetic'),{status:429,retryAfterMs:180000});}}).runOnce();
 assert.ok(transition.delay>=180);
 const broken={...store,finish:async()=>{throw Error('synthetic DB unavailable');}};
 const result=await createNewsWorker({store:broken,persist:async()=>{throw Error('DB unavailable');}}).runOnce();assert.equal(result.outcomes[0].outcome,'acknowledgement-unavailable');
});
test('WS5: store preserves bounded Retry-After metadata without provider content',async()=>{
 const store=createNewsWorkStore({env:{SETSCOPE_NEWS_WORK_QUEUE:'on',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SECRET_KEY:'synthetic'},fetchImpl:async()=>new Response('sensitive',{status:429,headers:{'retry-after':'180'}})});
 await assert.rejects(store.claim({scope:'synthetic'}),e=>e.status===429&&e.retryAfterMs>=180000&&!e.message.includes('sensitive'));
});
test('WS5: shared retry budget, publisher isolation and half-open recovery',async()=>{
 let now=0,a=0,b=0,fail=true;const sleeps=[];
 const health=createNewsSourceReliability({now:()=>now,random:()=>0.5,sleep:async ms=>{sleeps.push(ms);}});
 const request=health.wrap(async u=>{if(String(u)===B){b++;return new Response('healthy');}a++;return new Response(fail?'failed':'recovered',{status:fail?503:200});});
 const budget={httpRemaining:1};assert.equal((await request(A,{newsBudget:budget})).status,503);assert.equal(a,2);assert.equal(budget.httpRemaining,0);assert.deepEqual(sleeps,[100]);
 await assert.rejects(request(A),/COOLDOWN/);assert.equal(await(await request(B)).text(),'healthy');assert.equal(b,1);
 now=30001;fail=false;assert.equal(await(await request(A)).text(),'recovered');assert.equal(a,3);
 assert.equal(health.snapshot().sources.find(x=>x.source==='thunhoon.com').cooldownMs,0);
});
test('WS5: 403 manual pause, 429 Retry-After and 404/410 non-transient',async()=>{
 let now=0,calls=0,status=403;const health=createNewsSourceReliability({now:()=>now,sleep:async()=>{}});
 const request=health.wrap(async()=>{calls++;return new Response('synthetic',{status,headers:{'retry-after':'900'}});});
 await request(A);now=1000000;await assert.rejects(request(A),/DENIED/);assert.equal(calls,1);
 health.resume(A);status=429;await request(A);now+=899999;await assert.rejects(request(A),/COOLDOWN/);now+=2;status=200;await request(A);
 for(status of [404,410]){const before=calls;assert.equal((await request(A)).status,status);assert.equal(calls-before,1);}
});
test('WS5: concurrent callers coalesce safely; cancelling one cannot cancel another',async()=>{
 let calls=0,release;const health=createNewsSourceReliability(),controller=new AbortController();
 const request=health.wrap(async()=>{calls++;await new Promise(r=>{release=r;});return new Response('shared');});
 const one=request(A,{signal:controller.signal}),two=request(A);
 await new Promise(r=>setImmediate(r));controller.abort();await assert.rejects(one);release();
 assert.equal(await(await two).text(),'shared');assert.equal(calls,1);assert.equal(health.snapshot().active,0);
});
test('WS5: source budgets span stages and backpressure bounds pending work',async()=>{
 const health=createNewsSourceReliability({maxRequests:2,maxActive:2}),request=health.wrap(async()=>new Response('ok'));
 await request(A,{newsStage:'discovery'});await request(A+'2',{newsStage:'extraction'});
 await assert.rejects(request(A+'3'),/BUDGET/);assert.equal(await(await request(B)).text(),'ok');
 let release;const limit=createNewsSourceReliability({maxActive:1}),slow=limit.wrap(async()=>{await new Promise(r=>{release=r;});return new Response('ok');});
 const first=slow(A);await new Promise(r=>setImmediate(r));await assert.rejects(slow(B),/BACKPRESSURE/);release();await first;assert.equal(limit.snapshot().pending,0);
});
test('WS5: timeout retry recovery and metrics expose no query, title or secret',async()=>{
 let calls=0;const events=[],health=createNewsSourceReliability({sleep:async()=>{},onEvent:e=>events.push(e)});
 const request=health.wrap(async()=>{if(++calls===1)throw Object.assign(Error('synthetic secret'),{name:'TimeoutError'});return new Response('recovered');});
 assert.equal(await(await request(A+'?private-query=hidden')).text(),'recovered');assert.equal(calls,2);
 assert.doesNotMatch(JSON.stringify([health.snapshot(),events]),/private-query|hidden|secret|article-ws5/);
});

test('WS5: conditional RSS 304 reuses bounded snapshots without promoting metadata',async()=>{
 let conditional=0,calls=0;const service=createNewsService({env:{},fetchImpl:async(_u,init)=>{
  calls++;if(init.headers['if-none-match']==='"ws5"'){conditional++;return new Response(null,{status:304});}
  return new Response(xml,{headers:{etag:'"ws5"'}});
 }});
 const first=await service.getNews(),second=await service.getNews();
 assert.equal(first.items.length,1);assert.equal(second.items.length,1);assert.ok(conditional>0);assert.equal(second.items[0].verification.basis,'metadata');assert.ok(calls<=24);
});
test('WS5: CAPTCHA pauses only its publisher until explicit manual recovery',async()=>{
 let challenge=true,calls=0;const health=createNewsSourceReliability(),request=health.wrap(async()=>{calls++;return new Response(challenge?'<title>Just a moment</title><div class="cf-chl-container">':'healthy');});
 await assert.rejects(request(A),/DENIED/);await assert.rejects(request(A),/DENIED/);assert.equal(calls,1);
 challenge=false;assert.equal(await(await request(B)).text(),'healthy');await assert.rejects(request(A),/DENIED/);health.resume(A);assert.equal(await(await request(A)).text(),'healthy');
});
test('WS5: half-open source admits one probe; HTTP date Retry-After is not shortened',async()=>{
 let now=Date.parse('2026-10-29T00:00:00Z'),mode='fail',release,calls=0;
 const health=createNewsSourceReliability({now:()=>now,sleep:async()=>{}}),request=health.wrap(async()=>{
  calls++;if(mode==='fail')return new Response('',{status:503});
  if(mode==='probe')await new Promise(r=>{release=r;});return new Response('healthy');
 });
 await request(A);mode='probe';now+=30001;const probe=request(A);
 await new Promise(r=>setImmediate(r));await assert.rejects(request(A+'other'),/BACKPRESSURE/);release();await probe;assert.equal(calls,3);
 const until=new Date(now+7200000).toUTCString(),rate=health.wrap(async()=>new Response('',{status:429,headers:{'retry-after':until}}));
 await rate(B);now+=3600000;await assert.rejects(rate(B),/COOLDOWN/);
});
test('WS5: loader honors article Retry-After without negative article evidence',async()=>{
 let now=0,calls=0;const load=require('../lib/news-resolver').createNewsArticleLoader({now:()=>now,transport:async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'900'}});}});
 assert.equal((await load(A)).status,'UNVERIFIED');now=300001;assert.equal((await load(A)).status,'UNVERIFIED');assert.equal(calls,1);
 now=900001;await load(A);assert.equal(calls,2);
});
test('WS5: publisher LKG survives transient extraction failure, expires without timestamp renewal',async()=>{
 for(const name of ['bangkokbiznews','thansettakij']){
  let now=Date.now(),fail=false,calls=0;
  const mod=require('../server/news-'+name),factory=mod.createBangkokBizNewsSource||mod.createThansettakijSource;
  const title='PTT เปิดเผยผลประกอบการและแผนลงทุน',date=new Date(now-60000).toISOString(),url='https://www.'+name+'.com/finance/stock/1234567';
  const sitemap='<urlset><url><loc>'+url+'</loc><news:title>'+title+'</news:title><news:publication_date>'+date+'</news:publication_date><news:name>'+(name==='bangkokbiznews'?'Bangkokbiznews':'Thansettakij')+'</news:name></url></urlset>';
  const html='<link rel="canonical" href="'+url+'"><script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',mainEntityOfPage:{'@id':url},headline:title,datePublished:date})+'</script><h1>'+title+'</h1><div id="paragraph-1" data-news-content="company" class="content-detail"><p>'+('บริษัท PTT เผยรายละเอียดและหลักฐานจากต้นทาง '.repeat(10))+'</p></div>';
  const source=factory({enabled:true,now:()=>now,transport:async u=>{calls++;return String(u)===mod.SITEMAP?new Response(sitemap,{headers:{'content-type':'text/xml'}}):new Response(fail?'failed':html,{status:fail?503:200,headers:{'content-type':'text/html'}});}});
  const first=await source.getNews();assert.equal(first.items.length,1);const before=JSON.stringify(first.items[0]);
  now+=300001;fail=true;assert.equal((await source.getNews()).items.length,1);assert.equal(JSON.stringify(first.items[0]),before);
  now+=1800001;assert.equal((await source.getNews()).items.length,0);assert.ok(calls<=10);
 }
});
test('WS5: Retry-After beyond existing SQL delay range stays terminal for manual review',async()=>{
 let action,detail;const store={enabled:true,claim:async()=>[{id:1,stage:'extraction',attempts:1,payload:{original:true}}],finish:async(_j,a,x)=>{action=a;detail=x;return true;}};
 await createNewsWorker({store,extract:async()=>{throw Object.assign(Error('limited'),{status:429,retryAfterMs:7200000});}}).runOnce();
 assert.equal(action,'terminal');assert.match(detail.error,/MANUAL_REVIEW/);
});

test('WS5: manual kill interrupts in-flight IO and disabled queue inspection performs no network',async()=>{
 let signal;const health=createNewsSourceReliability(),request=health.wrap((_u,init)=>{signal=init.signal;return new Promise(()=>{});});
 const pending=request(A);await new Promise(r=>setImmediate(r));health.pause(A);await assert.rejects(pending);assert.equal(signal.aborted,true);assert.equal(health.snapshot().pending,0);
 let calls=0;const store=createNewsWorkStore({env:{SETSCOPE_NEWS_WORK_QUEUE:'off'},fetchImpl:()=>{calls++;throw Error('hidden IO');}});
 assert.deepEqual(await store.inspect(),{enabled:false,depth:null,oldestAgeMs:null});assert.equal(calls,0);
});
test('WS5: cancelled consumers and repeated URLs release listeners and retained work',async t=>{
 const {getEventListeners}=require('node:events'),controller=new AbortController(),start=process.memoryUsage().heapUsed,begin=performance.now();
 const health=createNewsSourceReliability({maxRequests:1000}),request=health.wrap(async()=>new Response('Synthetic bounded response'));
 for(let i=0;i<300;i++){await request(A+'-'+i,{signal:controller.signal});assert.equal(getEventListeners(controller.signal,'abort').length,0);}
 const state=health.snapshot();assert.equal(state.pending,0);assert.equal(state.active,0);assert.equal(state.sources.length,1);assert.equal(state.sources[0].requests,300);
 t.diagnostic(JSON.stringify({syntheticRequests:300,elapsedMs:Math.round(performance.now()-begin),heapDeltaBytes:process.memoryUsage().heapUsed-start,pending:state.pending,listeners:0}));
});

test('WS5: extraction denial cannot pause healthy Google RSS; coalesced waiters stay bounded',async()=>{
 const health=createNewsSourceReliability({maxPending:2}),url='https://news.google.com/rss/articles/synthetic';
 const denied=health.wrap(async()=>new Response('',{status:403}),'extraction');await denied(url);
 const rss=health.wrap(async()=>new Response('<rss>healthy</rss>'),'rss');assert.equal(await(await rss('https://news.google.com/rss/search?q=synthetic')).text(),'<rss>healthy</rss>');
 let release;const request=health.wrap(async()=>{await new Promise(r=>{release=r;});return new Response('shared');});
 const one=request(A),two=request(A);await assert.rejects(request(A),/BACKPRESSURE/);await new Promise(r=>setImmediate(r));release();await Promise.all([one,two]);
 assert.equal(health.snapshot().pending,0);
});

test('WS5: configured manual pause survives new instances and cannot be bypassed by recovery hooks',async()=>{
 let calls=0;for(let restart=0;restart<2;restart++){
  const health=createNewsSourceReliability({pausedSources:['thunhoon.com','google:extraction']}),request=health.wrap(async()=>{calls++;return new Response('healthy');});
  health.resume(A);await assert.rejects(request(A),/DENIED/);
  await assert.rejects(request('https://news.google.com/rss/articles/synthetic'),/DENIED/);
  assert.equal(await(await request('https://news.google.com/rss/search?q=synthetic',{newsStage:'rss'})).text(),'healthy');
 }
 assert.equal(calls,2);
});

test('WS5: manual publisher recovery clears its own origin aliases without releasing another publisher',async()=>{
 const load=require('../lib/news-resolver').createNewsArticleLoader({transport:async()=>new Response('healthy')});
 load.blockOrigin('https://www.thunhoon.com/article-one');load.blockOrigin('https://kaohoon.com/news/123');
 load.unblockOrigin('https://thunhoon.com/');
 assert.equal(load.isBlocked('https://www.thunhoon.com/article-one'),false);assert.equal(load.isBlocked(B),true);
});

test('WS5: article CAPTCHA widgets are not access-denial evidence and permanent HTTP errors are not retried',async()=>{
 let calls=0;const health=createNewsSourceReliability({sleep:async()=>{}}),request=health.wrap(async()=>{calls++;return new Response('<article>Real news content</article><div class="g-recaptcha"></div>');});
 assert.equal((await request(A)).status,200);assert.equal(health.snapshot().sources[0].paused,false);
 const unsupported=health.wrap(async()=>{calls++;return new Response('',{status:501});}),before=calls;assert.equal((await unsupported(B)).status,501);assert.equal(calls-before,1);
});
test('WS5: thrown access-denial errors pause the affected path without retry',async()=>{
 let calls=0;const health=createNewsSourceReliability({sleep:async()=>{}}),request=health.wrap(async()=>{calls++;throw Object.assign(Error('denied'),{status:403,retryable:true});});
 await assert.rejects(request(A));await assert.rejects(request(A));assert.equal(calls,1);
});
