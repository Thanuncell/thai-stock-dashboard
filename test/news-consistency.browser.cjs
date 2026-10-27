'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false,
    watch:'empty',holdAnalysis:true,releaseAnalysis:null,analysisCalls:0,archiveCalls:0,stored:false};
   const target={title:'PTT fixture company announcement',url:'https://www.kaohoon.com/news/shared?utm_source=rss',source:'kaohoon',sourceName:'ข่าวหุ้น',snippet:'Synthetic company earnings disclosure and operating period details',pubDate:new Date().toISOString()};
   const official=Array.from({length:5},(_,i)=>({...target,title:'Official fixture '+i,url:'https://www.bot.or.th/news/fixture-'+i,source:'official',sourceName:'BOT'}));
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/news')return json({items:[target,...official],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-archive'){
     state.archiveCalls++;
     return json({configured:true,dataState:'fresh',items:[{...target,url:'https://www.kaohoon.com/news/shared',fingerprint:'archive-sha-fixture',analysisMode:state.stored?'rules':'',analysisSummary:state.stored?'OLD_ARCHIVED_FALLBACK':''}],featured:[],total:1});
    }
    if(url.origin===base&&url.pathname==='/api/news-analysis'){
     state.analysisCalls++;
     if(state.holdAnalysis){state.holdAnalysis=false;await new Promise(resolve=>{state.releaseAnalysis=resolve;});}
     return json({items:request.postDataJSON().items.map(()=>({summary:'UNIFIED_NEWS_SUMMARY',mode:'ai',basis:'snippet'}))});
    }
    if(url.origin===base&&url.pathname==='/api/watchlist-news'){
     if(state.holdStoredWatch)await new Promise(resolve=>{state.releaseStoredWatch=resolve;});
     const count={matchedCandidates:state.watch==='empty'?0:1,qualityExcluded:['filtered','unavailable'].includes(state.watch)?1:0};
     if(state.watch==='error')return json({error:'Synthetic load failure'},503);
     return json({items:['partial','fresh'].includes(state.watch)?[target]:[],dataState:state.watch==='partial'?'partial':state.watch==='unavailable'?'unavailable':'fresh',fetchedAt:new Date().toISOString(),...count});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/?symbol=PTT#news',{waitUntil:'domcontentloaded'});
   await page.waitForSelector('body.authenticated');
   await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('กำลังตรวจสอบบทสรุป'));
   assert.doesNotMatch(await page.locator('#news-list').textContent(),/โดย AI/);
   state.releaseAnalysis();await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('UNIFIED_NEWS_SUMMARY'));
   const calls=state.analysisCalls;state.stored=true;
   await page.locator('.source-chip[data-source="kaohoon"]').click();
   await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('PTT fixture'));
   assert.match(await page.locator('#featured-news').textContent(),/UNIFIED_NEWS_SUMMARY/);
   assert.equal(await page.locator('#news-list .news-title-link').count(),0,'same URL cannot repeat in Latest with an archived fingerprint');
   await page.locator('.source-chip[data-source="all"]').click();
   await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('PTT fixture'));
   assert.match(await page.locator('#news-list').textContent(),/UNIFIED_NEWS_SUMMARY/);
   assert.doesNotMatch(await page.locator('#news-section').textContent(),/OLD_ARCHIVED_FALLBACK/);
   assert.equal(state.analysisCalls,calls,'filter changes reuse article analysis');assert.ok(state.archiveCalls>=3);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
   const refresh=async mode=>{state.watch=mode;await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-watchlist-news').disabled);};
   await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='empty');
   assert.match(await page.locator('#watchlist-news-list').textContent(),/ยังไม่พบข่าวที่ตรง/);
   await refresh('filtered');assert.match(await page.locator('#watchlist-news-list').textContent(),/พบข่าวที่เกี่ยวข้อง แต่ยังไม่มีข่าวที่ผ่าน/);
   await refresh('unavailable');assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'unavailable');
   await refresh('error');assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'error');
   await refresh('partial');assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'partial');
   assert.match(await page.locator('#watchlist-news-list').textContent(),/แสดงเฉพาะข่าวที่ตรวจสอบผ่าน/);
   assert.match(await page.locator('#watchlist-news-list').textContent(),/UNIFIED_NEWS_SUMMARY/);
   await refresh('error');assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'stale');
   await refresh('fresh');assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'fresh');
   await pause(100);assert.equal(state.analysisCalls,calls);
   state.watch='empty';
   state.holdStoredWatch=true;
   state.holdAnalysis=true;state.releaseAnalysis=null;
   await page.goto(base+'/?symbol=PTT&fixture=stored#news',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('OLD_ARCHIVED_FALLBACK'));
   state.holdStoredWatch=false;state.releaseStoredWatch?.();
   await page.locator('.source-chip[data-source="kaohoon"]').click();
   await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('OLD_ARCHIVED_FALLBACK'));
   assert.match(await page.locator('#featured-news').textContent(),/ประเมินจากคำสำคัญ/);
   assert.doesNotMatch(await page.locator('#featured-news').textContent(),/ไม่ใช่ AI/);
   assert.ok(state.releaseAnalysis);state.releaseAnalysis();
   await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('UNIFIED_NEWS_SUMMARY'));
   assert.match(await page.locator('#featured-news').textContent(),/โดย AI/);
   console.log(JSON.stringify({viewport:label,featuredLatestArchiveIdentity:'PASS',filterReuse:'PASS',analysisPending:'PASS',watchlistStatesAndFallback:'PASS',persistedSummaryReuse:'PASS'}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
