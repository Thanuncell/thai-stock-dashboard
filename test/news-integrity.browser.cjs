'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',
  SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,
    holdNextAGet:false,holdNextAMarket:false,version:1,holdA:false,release:null,analysisCalls:[]};
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),owner=/token-b/.test(request.headers().authorization||'')?'B':'A';
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/news')return json({items:[{title:'PTT กำไรเพิ่มตามรายงานรอบ '+state.version,
     url:'https://www.kaohoon.com/news/fixture-'+state.version,source:'infoquest',sourceName:'InfoQuest',snippet:'บริษัทเปิดเผยรายละเอียดผลประกอบการและระยะเวลาดำเนินงาน',pubDate:new Date().toISOString(),analysisMode:'ai',analysisSummary:'LEGACY_SUMMARY_MUST_NOT_OVERRIDE_UNAVAILABLE'}],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-archive')return json({configured:false,items:[],featured:[],total:0});
    if(url.origin===base&&url.pathname==='/api/watchlist-news')return json({items:[],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-analysis'){
     state.analysisCalls.push(owner);const items=request.postDataJSON().items;
     if(owner==='A'&&state.holdA){await new Promise(resolve=>{state.release=resolve;});return json({items:items.map(()=>({summary:'OWNER_A_ONLY_OLD_RESPONSE',mode:'ai',basis:'article'}))});}
     return json({items:items.map(()=>({summary:'',mode:'unavailable',basis:'headline'})),mode:'unavailable'});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/?symbol=PTT#news',{waitUntil:'domcontentloaded'});
   await page.waitForSelector('body.authenticated');await page.waitForFunction(()=>document.querySelector('#news-section')?.textContent.includes('สรุปไม่พร้อม'));
   const calls=state.analysisCalls.length;await pause(500);assert.equal(state.analysisCalls.length,calls,'unavailable cannot trigger a repeat loop');
   assert.ok(calls>0);assert.match(await page.locator('#news-section .news-impact').first().textContent(),/บวก/);assert.doesNotMatch(await page.locator('#news-section').textContent(),/โดย AI|LEGACY_SUMMARY_MUST_NOT_OVERRIDE_UNAVAILABLE/);
   await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+11000;});
   state.version=2;state.holdA=true;await page.locator('#refresh-news').click();for(let attempt=0;attempt<100&&!state.release;attempt++)await pause(20);assert.ok(state.release);
   await page.locator('#logout-button').click();await page.waitForSelector('#login-form:not([hidden])');
   await page.locator('#login-form input[name="email"]').fill('b@example.test');await page.locator('#login-form input[name="password"]').fill('fixture-password');
   await page.locator('#login-form button[type="submit"]').click();await page.waitForSelector('body.authenticated');
   state.holdA=false;state.release();
   await page.waitForFunction(()=>document.querySelector('#news-section')?.textContent.includes('สรุปไม่พร้อม'));await pause(300);
   assert.ok(state.analysisCalls.includes('B'));assert.doesNotMatch(await page.locator('body').textContent(),/OWNER_A_ONLY_OLD_RESPONSE/);
   console.log(JSON.stringify({viewport:label,unavailableTruth:'PASS',noAnalysisReplay:'PASS',independentHeadlineSentiment:'PASS',accountAnalysisFence:'PASS'}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
