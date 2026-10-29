'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_WORK_QUEUE:'off'}});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  for(const [label,viewport,gate]of [['desktop-off',{width:1366,height:900},false],['mobile-off',{width:390,height:844},false],['desktop-on',{width:1366,height:900},true],['mobile-on',{width:390,height:844},true]]){
   let analysisRequests=0;
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false};
   const date=new Date(Date.now()-60000).toISOString(),proof={status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'};
   const make=(name,url,extra={})=>({title:name,url,pubDate:date,source:'thunhoon',sourceName:'Thunhoon',snippet:'บริษัทเปิดเผยรายละเอียดข่าวและผลประกอบการล่าสุด',matchedSymbols:['PTT'],verification:proof,...extra});
   const url='https://thunhoon.com/article-browser-ws4',first=make('WS4 ข่าวประชุมกรรมการและผู้ถือหุ้น',url+'?fbclid=one',{analysisMode:'ai',analysisSummary:'WS4_STORED_AI'});
   const duplicate=make(first.title,url+'?gclid=two'),different=make(first.title,url+'?event=second');
   const pdfWord=make('WS4 บริษัทเผยคู่มือ PDF สำหรับนักลงทุน','https://thunhoon.com/article-browser-pdf-word');
   const bad=[make('WS4_BAD_CAREERS','https://www.set.or.th/th/about/careers'),make('WS4_BAD_LOGIN','https://thunhoon.com/login'),make('WS4_BAD_DOCUMENT.pdf','https://www.set.or.th/file.pdf')];
   const items=[first,duplicate,different,pdfWord,...bad];
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({p1DisplayGate:gate,...body})});
    if(u.origin===base&&u.pathname==='/api/news')return json({items,dataState:'fresh'});
    if(u.origin===base&&u.pathname==='/api/news-archive')return json({configured:false,items:[],featured:[],total:0});
    if(u.origin===base&&u.pathname==='/api/watchlist-news')return json({items:[...items,make('WS4_CROSS_ACCOUNT',url+'-private',{matchedSymbols:['ADVANC']})],total:items.length+1,dataState:'fresh'});
    if(u.origin===base&&u.pathname==='/api/news-analysis'){
     const targets=route.request().postDataJSON().items;analysisRequests++;
     for(const target of targets){assert.equal(target.source,'thunhoon');assert.equal(target.sourceName,'Thunhoon');assert.equal(target.pubDate,date);}
     return json({items:targets.map(()=>({summary:'',mode:'unavailable'}))});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.body.classList.contains('authenticated')&&document.querySelector('#news-section')?.textContent.includes('WS4 ข่าว'));
   const news=page.locator('#news-section');
   assert.equal(await news.locator('.news-item a.news-title-link').count(),3);
   assert.doesNotMatch(await news.textContent(),/WS4_BAD_/);assert.match(await news.textContent(),/WS4_STORED_AI/);
   assert.match(await news.textContent(),/คู่มือ PDF/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);
   assert.equal(await news.locator('.news-item a.news-title-link').count(),3);
   await page.waitForFunction(()=>!document.querySelector('#news-section .news-analysis-pending'));assert.ok(analysisRequests>0);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
   await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('WS4 ข่าว'));
   const watch=page.locator('#watchlist-news-list');
   assert.equal(await watch.locator('a.news-title-link').count(),3);
   assert.doesNotMatch(await watch.textContent(),/WS4_BAD_|WS4_CROSS_ACCOUNT/);
   await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-watchlist-news').disabled);
   assert.equal(await watch.locator('a.news-title-link').count(),3);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   console.log(JSON.stringify({viewport:label,checks:11,status:'PASS',duplicatePrecision:true,falseMergePrevention:true,cachedReferenceGuard:true,storedAi:true,watchlistScope:true,productionRequests:0}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
