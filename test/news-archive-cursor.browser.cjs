'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const createWindowFixture=require('./fixtures/news-archive-window.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=path.join(__dirname,'..'),port=await freePort(),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['test/fixtures/news-archive-cursor-app.cjs'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port)}});
 let browser;
 try{
  await waitForServer(base+'/healthz');
  browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[]},calls={archive:[],news:0,watch:0,remote:0};
   const make=(i,live=false)=>({title:`PTT ผลประกอบการ ${live?'LIVE':i===90?'DEEPNEEDLE':'ARCHIVE'} ${i}`,
    url:`https://news.google.com/rss/articles/cursor-${live?'live':'archive'}-${i}`,source:i%2?'other':'infoquest',sourceName:i%2?'กรุงเทพธุรกิจ':'InfoQuest',
    snippet:'บริษัทเปิดเผยข้อมูลผลประกอบการและแผนการลงทุนตามแหล่งข่าวต้นทาง',pubDate:new Date(Date.now()-(live?60000:8*86400000)-i*1000).toISOString(),
    matchedSymbols:['PTT'],verification:{status:'VERIFIED',basis:'metadata'}});
   const rows=Array.from({length:83},(_,i)=>make(i)),live=Array.from({length:8},(_,i)=>make(i,true));rows.push(make(90));
   let archiveFixture=await createWindowFixture({rows}),hold=null,rejectRefresh=false,invalidate=false;
   await context.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url()),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com')return route.fulfill({status:200,contentType:'text/css',body:''});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co'){calls.remote++;return route.abort();}
    if(u.origin===base&&u.pathname==='/api/news'){calls.news++;return json({items:live,dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/watchlist-news'){calls.watch++;return json({items:rows.slice(0,25),dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-analysis')return json({items:(req.postDataJSON()?.items||[]).map(()=>({summary:'',mode:'unavailable'}))});
    if(u.origin===base&&u.pathname==='/api/news-archive'){
     const query=u.searchParams.get('query')||'',source=u.searchParams.get('source')||'all',cursor=u.searchParams.get('cursor');
     const owner=String(req.headers().authorization).includes('token-b')?'OWNER-B':'OWNER-A';
     const lookahead=u.searchParams.has('windowStart')?{startPage:Number(u.searchParams.get('windowStart')),pageCount:Number(u.searchParams.get('windowPages')),cursor:u.searchParams.get('windowAfter')}:null;
     const call={query,source,cursor,lookahead,refresh:u.searchParams.get('refresh')};calls.archive.push(call);
     if(hold&&hold.query===query){const pending=hold;hold=null;await pending.promise;}
     if(rejectRefresh&&u.searchParams.has('refresh'))return json({error:'fixture unavailable',dataState:'unavailable'},502);
     if(invalidate&&cursor){invalidate=false;archiveFixture.setRevision('2');}
     let response;
     try{response=archiveFixture.read({query,source,cursor,revision:u.searchParams.get('revision'),excludeUrls:u.searchParams.getAll('exclude'),featuredCount:Number(u.searchParams.get('featuredCount')||0),lookahead});}
     catch(error){return json({code:error.message,dataState:'unavailable'},409);}
     call.start=rows.findIndex(x=>x.url===response.items[0]?.url);
     if(response.window)assert.doesNotMatch(JSON.stringify(response.window),/title|snippet|articleBody/);
     return json({...response,items:response.items.map(x=>({...x,title:owner+' '+x.title}))});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   const ready=async()=>{try{await page.waitForFunction(()=>document.querySelector('#news-list')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled&&document.querySelector('#news-list .news-title-link'));}catch(e){console.error(JSON.stringify({errors,calls,dom:await page.evaluate(()=>({auth:document.body.classList.contains('authenticated'),news:document.querySelector('#news-section')?.textContent,busy:document.querySelector('#news-list')?.getAttribute('aria-busy'),button:document.querySelector('#refresh-news')?.disabled}))}));throw e;}};
   const active=()=>page.locator('#news-pager [aria-current="page"]').textContent();
   const pick=async n=>{await page.locator('#news-pager').getByRole('button',{name:String(n),exact:true}).click();await page.waitForFunction(n=>document.querySelector('#news-pager [aria-current="page"]')?.textContent===String(n),n);await ready();};
   const numbers=()=>page.locator('#news-pager button').allTextContents().then(x=>x.filter(s=>/^\d+$/.test(s)));
   await seedPage(page,'token-a');await page.goto(base+'/?newsPage=7#news',{waitUntil:'domcontentloaded'});await ready();
   assert.equal(await active(),'1');assert.equal(new URL(page.url()).searchParams.has('newsPage'),false);
   assert.equal(calls.archive.length,1);assert.equal(calls.archive[0].start,0);assert.equal(await page.locator('#news-list .news-title-link').count(),10);
   assert.deepEqual(await numbers(),['1','2','3','4','5']);
   assert.equal(archiveFixture.metrics.articleRows,10,'no unseen article payload prefetched');
   assert.equal(archiveFixture.metrics.metadataRows,5);assert.equal(archiveFixture.metrics.selectedOrderingKeys,51);
   for(const n of [1,2,3,4,5])assert.equal(await page.locator('#news-pager').getByRole('button',{name:String(n),exact:true}).isDisabled(),false);
   assert.equal(await page.locator('#news-pager span').count(),1);assert.equal(await page.locator('#news-pager').getByRole('button',{name:'…',exact:true}).count(),0);
   const firstFeatured=await page.locator('#featured-news .news-title-link').allTextContents(),newsBefore=calls.news;
   assert.equal(firstFeatured.length,5);assert.equal(await page.locator('#news-count').isVisible(),false);
   if(process.env.SETSCOPE_CURSOR_EVIDENCE){await page.locator('#news-pager').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.SETSCOPE_CURSOR_EVIDENCE,label+'-initial.png')});}
   await pick(5);assert.deepEqual(await numbers(),['3','4','5','6','7']);const jumpRequests=calls.archive.length;
   await page.goBack();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='1');await ready();
   assert.equal(calls.archive.length,jumpRequests,'Owner option 1: Back restores the initial window from cache');
   for(const n of [2,4])await pick(n);
   assert.deepEqual(calls.archive.map(x=>x.start),[0,40,10,30],'1 -> 5 -> 2 -> 4 requests chosen articles only');
   assert.equal(calls.archive[1].lookahead.startPage,6);assert.equal(calls.archive[1].lookahead.pageCount,2);
   for(const n of [3,4,5,6,7]){await pick(n);if(n===3)assert.deepEqual(await numbers(),['1','2','3','4','5']);if(n===4)assert.deepEqual(await numbers(),['2','3','4','5','6']);}
   assert.deepEqual(await numbers(),['5','6','7','8','9']);assert.equal(calls.archive.length,7);assert.equal(calls.news,newsBefore);
   if(process.env.SETSCOPE_CURSOR_EVIDENCE){await page.locator('#news-pager').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.SETSCOPE_CURSOR_EVIDENCE,label+'-expanded.png')});}
   assert.deepEqual(await page.locator('#featured-news .news-title-link').allTextContents(),firstFeatured);
   const beforeBack=calls.archive.length;await page.goBack();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='6');await ready();
   await page.goForward();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='7');await ready();assert.equal(calls.archive.length,beforeBack);
   const refreshBefore=calls.archive.length;await page.locator('#refresh-news').click();await ready();
   assert.equal(calls.archive.length,refreshBefore+1);assert.equal(calls.archive.at(-1).start,60);assert.equal(calls.archive.at(-1).refresh,'1');assert.equal(await active(),'7');assert.equal(calls.news,newsBefore);
   rejectRefresh=true;const retained=await page.locator('#news-list .news-title-link').allTextContents();await page.locator('#refresh-news').click();await ready();
   assert.deepEqual(await page.locator('#news-list .news-title-link').allTextContents(),retained);assert.equal(await active(),'7');assert.match(await page.locator('#news-count').textContent(),/ไม่พร้อม/);rejectRefresh=false;
   await pick(8);await pick(9);assert.equal(await page.locator('#news-list .news-title-link').count(),4);
   assert.equal(await page.locator('#news-pager').getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);
   assert.deepEqual(await numbers(),['7','8','9'],'no unavailable future numbered buttons');
   const endCalls=calls.archive.length;await pause(100);assert.equal(calls.archive.length,endCalls);
   await page.locator('#news-search').fill('DEEPNEEDLE');await page.waitForFunction(()=>document.querySelectorAll('#news-list .news-title-link').length===1&&document.querySelector('#news-list')?.getAttribute('aria-busy')==='false');
   assert.equal(await active(),'1');assert.match(await page.locator('#news-list').textContent(),/DEEPNEEDLE/);
   // A late response must lose authority at input time, before debounce expires.
   let release;hold={query:'ARCHIVE',promise:new Promise(r=>{release=r;})};await page.locator('#news-search').fill('ARCHIVE');
   await page.waitForRequest(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')==='ARCHIVE');
   await page.locator('#news-search').fill('DEEPNEEDLE');release();await pause(100);
   assert.doesNotMatch(await page.locator('#news-list').textContent(),/ARCHIVE 0/);await pause(350);await ready();
   await page.locator('#news-sources [data-source="infoquest"]').click();await ready();assert.equal(await active(),'1');assert.equal(calls.archive.at(-1).source,'infoquest');
   await page.locator('#news-search').fill('');await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&!new URL(r.url()).searchParams.get('query'));await ready();
   await pick(2);invalidate=true;await page.locator('#refresh-news').click();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='1');await ready();
   assert.equal(calls.archive.at(-1).cursor,null,'invalid revision recovers with a single first-page request');
   await page.locator('#news-pager').getByRole('button',{name:'2',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='2');
   archiveFixture=await createWindowFixture({rows:rows.slice(0,37)});await page.goto(base+'/#news');await ready();
   assert.deepEqual(await numbers(),['1','2','3','4']);for(const n of [1,2,3,4])assert.equal(await page.locator('#news-pager').getByRole('button',{name:String(n),exact:true}).isDisabled(),false);
   await pick(4);assert.equal(await page.locator('#news-list .news-title-link').count(),7);assert.equal(await page.locator('#news-pager').getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list .news-title-link'));
   await page.locator('#watchlist-news-pager').getByRole('button',{name:'2',exact:true}).click();assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),10);
   await page.locator('.nav-item[data-workspace-route="news"]').click();await ready();
   let releaseOld;hold={query:'',promise:new Promise(r=>{releaseOld=r;})};
   const oldStarted=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.has('refresh'));
   await page.locator('#refresh-news').click();await oldStarted;
   await page.locator('.nav-item[data-workspace-route="profile"]').click();await page.locator('#profile-logout-button').click();
   await page.waitForSelector('#login-form:not([hidden])');
   await page.locator('#login-form input[name="email"]').fill('b@example.test');await page.locator('#login-form input[name="password"]').fill('fixture-password');
   await page.locator('#login-form button[type="submit"]').click();await page.waitForSelector('body.authenticated');
   await page.locator('.nav-item[data-workspace-route="news"]').click();await ready();
   assert.equal(await active(),'1');assert.match(await page.locator('#news-list').textContent(),/OWNER-B/);
   releaseOld();await pause(100);assert.doesNotMatch(await page.locator('#news-list').textContent(),/OWNER-A/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   assert.deepEqual(errors,[]);assert.equal(calls.remote,0);
   console.log(JSON.stringify({viewport:label,frontendCursorContract:'PASS',cursorOnlyLookahead:'PASS',initialNoArticlePrefetch:'PASS',preparedWindowJumps:'PASS',shortWindow:'PASS',race:'PASS',scopedRefresh:'PASS',end:'PASS',deepLink:'PASS',keyboard:'PASS',watchlist:'PASS',accountIsolation:'PASS',backendCursorIntegration:'NOT RUN',productionRequests:0,calls:{archive:calls.archive.length,news:calls.news,watch:calls.watch}}));
   if(process.env.SETSCOPE_CURSOR_EVIDENCE){await page.locator('#news-pager').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.SETSCOPE_CURSOR_EVIDENCE,label+'.png')});}
   await context.close();
  }
 }finally{await browser?.close();child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
