'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport});
   const state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false,
    searchHold:null,releaseSearch:null,newsHold:null,releaseNews:null,newsError:false,analysisHold:false,releaseAnalysis:null};
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),owner=/token-b/.test(request.headers().authorization||'')?'b':'a';
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(url.origin===base&&url.pathname==='/api/watchlists'&&request.method()==='GET'&&owner==='a')return json({record:{watchlists:[
     {id:'list-1',name:'Thai Airways',items:[{symbol:'THAI',name:'Thai Airways'}]},
     {id:'list-2',name:'Leasing',items:[{symbol:'THANI',name:'Ratchthani Leasing'}]}],active_watchlist_id:'list-1'}});
    if(url.origin===base&&url.pathname==='/api/search'){
     const q=url.searchParams.get('q').toLowerCase();
     if(state.searchHold===q){state.searchHold=null;await new Promise(resolve=>{state.releaseSearch=resolve;});}
     const items=(q==='tha'?['THAI','THANI']:q==='ptt'?['PTT']:q==='thani'?['THANI']:q==='thai'?['THAI']:[]).map(symbol=>({symbol,name:symbol,exchange:'SET'}));return json({items});
    }
    if(url.origin===base&&url.pathname==='/api/watchlist-news'){
     const stocks=JSON.parse(url.searchParams.get('stocks')),symbol=stocks[0]?.symbol||'NONE';
     if(state.newsHold===symbol){state.newsHold=null;await new Promise(resolve=>{state.releaseNews=resolve;});}
     if(state.newsError)return state.newsError==='unavailable'?json({items:[],dataState:'unavailable'}):json({error:'fixture unavailable'},503);
     return json({items:[{title:symbol+' ข่าวผลประกอบการของบัญชี '+owner,source:'thunhoon',sourceName:'ทันหุ้น',url:'https://thunhoon.com/article/'+symbol,
      pubDate:new Date().toISOString(),matchedSymbols:[symbol]}],fetchedAt:new Date().toISOString(),dataState:'fresh'});
    }
    if(url.origin===base&&url.pathname==='/api/news-analysis'){
     if(state.analysisHold){state.analysisHold=false;await new Promise(resolve=>{state.releaseAnalysis=resolve;});}
     return json({items:request.postDataJSON().items.map(()=>({summary:'สรุปข่าวทดสอบ',mode:'rules'}))});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',error=>console.error('Fixture page error:',error.message));
   await seedPage(page,'token-a');await page.goto(base+'/?symbol=PTT#chart',{waitUntil:'domcontentloaded'});
   await page.waitForSelector('body.authenticated');await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='fresh');
   const input=page.locator('#stock-search');await input.fill('tha');await page.waitForSelector('.suggestion-item[data-symbol="THANI"]');
   await input.press('Enter');await pause(100);assert.equal(new URL(page.url()).searchParams.get('symbol'),'PTT','ambiguous prefix must not open first result');
   await page.locator('.suggestion-item[data-symbol="THANI"]').click();await page.waitForFunction(()=>new URL(location.href).searchParams.get('symbol')==='THANI');
   state.searchHold='ptt';await input.fill('ptt');await page.waitForFunction(()=>document.querySelector('#symbol-suggestions')?.textContent.includes('กำลัง'));
   while(!state.releaseSearch)await pause(20);
   await input.fill('tha');state.releaseSearch();await page.waitForSelector('.suggestion-item[data-symbol="THANI"]');
   assert.equal(await page.locator('.suggestion-item[data-symbol="PTT"]').count(),0,'old response cannot restore old suggestions');
   await input.fill('THAI');await input.press('Enter');await page.waitForFunction(()=>new URL(location.href).searchParams.get('symbol')==='THAI');
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.body.dataset.workspacePage==='watchlist');
   const picker=page.locator(label==='mobile'?'#watchlist-select-mobile':'#watchlist-select');
   state.newsHold='THANI';state.analysisHold=true;await picker.selectOption('list-2');
   while(!state.releaseNews)await pause(20);
   assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'loading');assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/THAI ข่าว/);
   state.releaseNews();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='fresh');
   while(!state.releaseAnalysis)await pause(20);
   state.newsError=true;await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='stale');
   assert.match(await page.locator('#watchlist-news-list').textContent(),/THANI ข่าว/);
   state.releaseAnalysis();await pause(100);assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'stale');
   state.newsError='unavailable';await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-watchlist-news')?.disabled);
   assert.equal(await page.locator('#watchlist-news-list').getAttribute('data-state'),'stale');assert.match(await page.locator('#watchlist-news-list').textContent(),/THANI ข่าว/);
   state.newsError=false;await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='fresh');
   state.newsHold='THANI';state.releaseNews=null;await page.locator('#refresh-watchlist-news').click();while(!state.releaseNews)await pause(20);
   const releaseOldNews=state.releaseNews;
   await page.locator('#logout-button').click();await page.waitForSelector('#login-form:not([hidden])');
   await page.locator('#login-form input[name="email"]').fill('b@example.test');await page.locator('#login-form input[name="password"]').fill('fixture-password');
   await page.locator('#login-form button[type="submit"]').click();await page.waitForSelector('body.authenticated');
   await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('CPALL ข่าว'));
   releaseOldNews();await pause(100);assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/THANI ข่าว|THAI ข่าว/);
   console.log(JSON.stringify({viewport:label,prefixAndEnter:'PASS',staleSearchResponse:'PASS',newsScopeLoading:'PASS',retainedNewsAndAnalysisRace:'PASS',recovery:'PASS',accountAB:'PASS'}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
