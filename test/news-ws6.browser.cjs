'use strict';
const strict=require('node:assert/strict');let checks=0;const assert=new Proxy(strict,{get:(target,key)=>typeof target[key]==='function'? (...args)=>{checks++;return target[key](...args);}:target[key]});const path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const d=await import('../client/domain.mjs'),port=await freePort(),base='http://127.0.0.1:'+port,baseline=Boolean(process.env.SETSCOPE_WS6_BASELINE_REPO);
 const server=spawn(process.execPath,['server.js'],{cwd:process.env.SETSCOPE_WS6_BASELINE_REPO||path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_WORK_QUEUE:'off'}});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   checks=0;const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false},calls={news:0,archive:0,watch:0},timings=[];
   const names=['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ','Investing.com','InfoQuest'];
   const items=Array.from({length:1205},(_,i)=>({title:'WS6 PTT รายงานข่าวลงทุน '+String(i).padStart(4,'0'),url:'https://news.google.com/rss/articles/ws6-browser-'+i,source:i%4===3?'infoquest':'other',sourceName:names[i%4],pubDate:new Date(Date.now()-60000-i*1000).toISOString(),snippet:'PTT รายงานผลประกอบการและการลงทุนตามข้อมูลต้นทาง',matchedSymbols:['PTT'],brokerCategory:i%5===0,verification:{status:'VERIFIED',basis:'metadata'}}));
   let mode='archive',hold=false,release;
   await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(u.origin===base&&u.pathname==='/api/news'){calls.news++;return json({items:mode==='unavailable'?[]:items.slice(0,60),dataState:mode==='unavailable'?'unavailable':'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-archive'){
     calls.archive++;const selected=d.selectNewsForDisplay(items,{source:u.searchParams.get('source'),query:u.searchParams.get('query')||'',featuredCount:0}).filtered;
     const excluded=new Set(u.searchParams.getAll('exclude').map(url=>d.newsKey({url}))),available=selected.filter(x=>!excluded.has(d.newsKey(x))),fc=Number(u.searchParams.get('featuredCount')||0),featured=available.slice(0,fc),rest=available.slice(featured.length),page=Math.max(1,Math.min(Math.ceil(rest.length/10)||1,Number(u.searchParams.get('page')||1)));
     if(hold){hold=false;await new Promise(r=>{release=r;});}
     await delay(20);if(mode==='error')return json({error:'synthetic unavailable'},502);
     if(['local','unavailable'].includes(mode))return json({configured:false,items:[],featured:[],total:0,dataState:'unavailable'});
     return json({configured:true,items:rest.slice((page-1)*10,page*10),featured,total:rest.length,page,countExact:mode!=='unknown',matchingTotal:available.length,dataState:'fresh'});
    }
    if(u.origin===base&&u.pathname==='/api/watchlist-news'){calls.watch++;return json({items:[...items.slice(0,25),{...items[0],title:'WS6_CROSS_ACCOUNT',url:items[0].url+'-private',matchedSymbols:['ADVANC']}],limited:true,dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-analysis')return json({items:request.postDataJSON().items.map(()=>({summary:'',mode:'unavailable'}))});
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.body.classList.contains('authenticated')&&document.querySelector('#news-list .news-title-link')&&!document.querySelector('#refresh-news').disabled);
   const measure=async locator=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'),start=performance.now();await locator.click();await response;await page.waitForFunction(()=>!document.querySelector('#news-count').textContent.includes('กำลัง'));await page.evaluate(()=>new Promise(requestAnimationFrame));return performance.now()-start;};
   const perfBefore={...calls},perf=[];for(let repeat=0;repeat<3;repeat++){perf.push(await measure(page.locator('.source-chip[data-source="infoquest"]')));perf.push(await measure(page.locator('.source-chip[data-source="all"]')));}
   assert.equal(calls.news-perfBefore.news,0);assert.equal(calls.archive-perfBefore.archive,6);
   const medianSameWorkflowMs=Math.round(perf.sort((a,b)=>a-b)[Math.floor(perf.length/2)]);
   if(baseline){console.log(JSON.stringify({mode:'baseline',viewport:label,medianSameWorkflowMs,samples:6,rssPerFilter:0,archivePerFilter:1}));await context.close();continue;}
   await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='1,205 ข่าว');
   if(process.env.SETSCOPE_WS6_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SETSCOPE_WS6_SCREENSHOTS,label+'-news.png'),fullPage:true});
   const chips=page.locator('#news-sources'),counter=page.locator('#news-count'),pager=page.locator('#news-pager');
   const select=async key=>{timings.push(await measure(chips.locator('[data-source="'+key+'"]')));};
   const pendingSearch=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')==='PTT',{timeout:5000});
   await page.locator('#news-search').fill('PTT');await page.evaluate(()=>{document.querySelector('.nav-item[data-workspace-route="watchlist"]').click();document.querySelector('#watchlist-news-sources [data-source="bangkokbiznews"]').click();document.querySelector('#watchlist-news-sources [data-source="all"]').click();document.querySelector('.nav-item[data-workspace-route="news"]').click();});
   await pendingSearch;await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='1,205 ข่าว');assert.equal(new URL(page.url()).searchParams.get('s'),'PTT');
   const clearedSearch=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')==='');await page.locator('#news-search').fill('');await clearedSearch;
   const before={...calls};await select('bangkokbiznews');assert.equal(await counter.textContent(),'302 ข่าว');
   await select('thansettakij');assert.equal(await counter.textContent(),'603 ข่าว');assert.equal(calls.news,before.news);assert.equal(calls.archive-before.archive,2);
   assert.equal(await chips.locator('[aria-pressed="true"]').count(),2);assert.match(page.url(),/source=bangkokbiznews%2Cthansettakij/);
   assert.ok((await page.locator('#featured-news .source-tag').allTextContents()).every(x=>names.slice(0,2).includes(x)));
   await page.goBack();await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='302 ข่าว');
   await page.goForward();await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='603 ข่าว');
   await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='603 ข่าว');
   await select('all');assert.equal(await counter.textContent(),'1,205 ข่าว');assert.ok((await pager.locator('button').allTextContents()).filter(x=>/^\d+$/.test(x)).length<=10);
   assert.equal(await pager.getByRole('button',{name:'ก่อนหน้า',exact:true}).isDisabled(),true);
   await pager.getByRole('button',{name:'หน้า 120',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='120');
   assert.equal(await pager.getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);assert.equal(await page.locator('#news-list .news-title-link').count(),10);assert.match(page.url(),/newsPage=120/);
   await page.goto(base+'/?newsPage=60#news',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='60');assert.equal(await pager.getByRole('button',{name:'ก่อนหน้า',exact:true}).isEnabled(),true);assert.equal(await pager.getByRole('button',{name:'ถัดไป',exact:true}).isEnabled(),true);
   const clampBefore=calls.archive;await page.goto(base+'/?newsPage=9999#news',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='120');assert.equal(calls.archive-clampBefore,1);assert.match(page.url(),/newsPage=120/);
   hold=true;await chips.locator('[data-source="bangkokbiznews"]').click();await page.waitForTimeout(30);await chips.locator('[data-source="investing"]').click();await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='603 ข่าว');release();await delay(30);assert.equal(await counter.textContent(),'603 ข่าว');
   await page.locator('#news-search').fill('ไม่มีคำค้นนี้');await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='0 ข่าว');assert.equal(await pager.isVisible(),false);
   const longSearch=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')?.length===80);await page.locator('#news-search').fill('x'.repeat(120));await longSearch;assert.equal((await page.locator('#news-search').inputValue()).length,80);assert.equal(new URL(page.url()).searchParams.get('s').length,80);
   await page.locator('#news-search').fill('');await page.waitForFunction(()=>document.querySelector('#news-count').textContent==='603 ข่าว');
   mode='error';await select('all');assert.match(await counter.textContent(),/คลังข่าวไม่พร้อม/);assert.doesNotMatch(await counter.textContent(),/^0 ข่าว/);
   mode='unknown';await select('infoquest');assert.equal(await counter.textContent(),'ยังนับข่าวทั้งหมดไม่ได้');await select('all');
   mode='local';await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);assert.match(await counter.textContent(),/60 ข่าว/);
   const titles1=await page.locator('#news-list .news-title-link').allTextContents();const localBefore=calls.news;await pager.getByRole('button',{name:'หน้า 2',exact:true}).click();assert.notDeepEqual(await page.locator('#news-list .news-title-link').allTextContents(),titles1);assert.equal(calls.news,localBefore);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list .news-title-link'));
   const watchBefore=calls.watch,watch=page.locator('#watchlist-news-sources');await watch.locator('[data-source="bangkokbiznews"]').click();assert.match(await page.locator('#watchlist-news-count').textContent(),/^7 ข่าว/);
   await watch.locator('[data-source="investing"]').press('Enter');assert.match(await page.locator('#watchlist-news-count').textContent(),/^13 ข่าว/);assert.equal(calls.watch,watchBefore);
   assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/WS6_CROSS_ACCOUNT/);
   await page.locator('#watchlist-news-pager').getByRole('button',{name:'หน้า 2',exact:true}).click();assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),3);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#watchlist-news-pager [aria-current="page"]')?.textContent==='2');assert.match(await page.locator('#watchlist-news-count').textContent(),/^13 ข่าว/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   if(process.env.SETSCOPE_WS6_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SETSCOPE_WS6_SCREENSHOTS,label+'-watch.png'),fullPage:true});
   mode='unavailable';await page.locator('.nav-item[data-workspace-route="news"]').click();await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);assert.equal(await counter.textContent(),'ยังนับข่าวไม่ได้');assert.match(await page.locator('#news-list').textContent(),/ยังไม่สามารถโหลดข่าวได้/);
   console.log(JSON.stringify({mode:'ws6',viewport:label,checks,rssPerFilter:0,watchRequestsPerFilter:0,archivePerSelection:1,clampRequests:1,medianSameWorkflowMs,samples:6,medianScenarioMs:Math.round(timings.sort((a,b)=>a-b)[Math.floor(timings.length/2)]),productionRequests:0}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
