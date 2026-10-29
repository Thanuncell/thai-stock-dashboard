'use strict';
const strict=require('node:assert/strict');let checks=0;const assert=new Proxy(strict,{get:(target,key)=>typeof target[key]==='function'?(...args)=>{checks++;return target[key](...args);}:target[key]});
const path=require('node:path'),{spawn}=require('node:child_process'),{chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
(async()=>{
 const d=await import('../client/domain.mjs'),port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_WORK_QUEUE:'off'}});let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   checks=0;const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false};
   const names=['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ','Investing.com','InfoQuest'],items=Array.from({length:1205},(_,i)=>({title:'PTT ข่าวธุรกิจต้นทาง '+String(i).padStart(4,'0'),url:'https://news.google.com/rss/articles/original-pagination-'+i,source:i%4===3?'infoquest':'other',sourceName:names[i%4],pubDate:new Date(Date.now()-60000-i*1000).toISOString(),snippet:'บริษัทเปิดเผยข้อมูลการลงทุนและผลประกอบการตามต้นทาง',matchedSymbols:['PTT'],verification:{status:'VERIFIED',basis:'metadata'}}));
   const calls={news:0,archive:0,watch:0},responses=[];let partial=false,hold=false,release,heldReady,local=false;
   await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url()),json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(u.origin===base&&u.pathname==='/api/news'){calls.news++;return json({items:items.slice(0,60),dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-archive'){
     calls.archive++;assert.equal(u.searchParams.has('clamp'),false);
     const selected=d.selectNewsForDisplay(items,{source:u.searchParams.get('source'),query:u.searchParams.get('query')||'',featuredCount:0}).filtered,excluded=new Set(u.searchParams.getAll('exclude').map(url=>d.newsKey({url}))),available=selected.filter(x=>!excluded.has(d.newsKey(x))),fc=Number(u.searchParams.get('featuredCount')||0),featured=available.slice(0,fc),rest=available.slice(featured.length),page=Number(u.searchParams.get('page')||1);
     if(hold){hold=false;await new Promise(r=>{release=r;heldReady();});}
     if(local)return json({configured:false,items:[],featured:[],total:0,dataState:'unavailable'});
     const result={configured:true,items:rest.slice((page-1)*10,page*10),featured,total:rest.length,page,countExact:!partial,dataState:'fresh'};responses.push(result);return json(result);
    }
    if(u.origin===base&&u.pathname==='/api/watchlist-news'){calls.watch++;return json({items:[...items.slice(0,25),{...items[0],url:items[0].url+'-private',title:'CROSS_ACCOUNT',matchedSymbols:['ADVANC']}],dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-analysis')return json({items:request.postDataJSON().items.map(()=>({summary:'',mode:'unavailable'}))});
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.classList.contains('authenticated')&&!document.querySelector('#refresh-news').disabled&&document.querySelector('#news-list .news-title-link'));
   const pager=page.locator('#news-pager'),counter=page.locator('#news-count');
   const ready=async n=>{await page.waitForFunction(expected=>document.querySelector('#news-pager .active')?.textContent===String(expected)&&!document.querySelector('#news-count').textContent.includes('กำลัง'),n);assert.deepEqual(await page.locator('#news-list .news-title-link').allTextContents(),responses.at(-1).items.map(x=>x.title));assert.equal(responses.at(-1).page,n);};
   const pick=async n=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');await pager.getByRole('button',{name:String(n),exact:true}).click();await response;await ready(n);await page.waitForFunction(()=>scrollY===0);};
   assert.equal(await counter.textContent(),'1,205 ข่าว');assert.equal(await pager.locator('button').first().textContent(),'ก่อนหน้า');assert.equal(await pager.locator('button').last().textContent(),'ถัดไป');assert.equal(await pager.getByRole('button',{name:'ก่อนหน้า',exact:true}).isDisabled(),true);
   const networkBefore={...calls};await pick(2);await pick(3);await pick(120);assert.equal(calls.archive-networkBefore.archive,3);assert.equal(calls.news,networkBefore.news);assert.equal(await pager.getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);assert.match(page.url(),/newsPage=120/);
   const previous=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');await pager.getByRole('button',{name:'ก่อนหน้า',exact:true}).click();await previous;await ready(119);
   await page.goBack();await ready(120);await page.goForward();await ready(119);await pick(1);
   // Original behavior: wait for archive response, then scroll to the window top.
   hold=true;const held=new Promise(r=>{heldReady=r;});await pager.getByRole('button',{name:'2',exact:true}).click();await held;
   assert.ok(await page.evaluate(()=>scrollY>0));assert.equal(await pager.locator('.active').textContent(),'1');assert.equal(await page.locator('#news-list .news-title-link').count(),10);release();await ready(2);await page.waitForFunction(()=>scrollY===0);assert.equal(await page.evaluate(()=>scrollY),0);
   const select=async key=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');await page.locator('#news-sources [data-source="'+key+'"]').click();await response;await ready(1);};
   const filterBefore=calls.news;await select('bangkokbiznews');assert.equal(await counter.textContent(),'302 ข่าว');await select('thansettakij');assert.equal(await counter.textContent(),'603 ข่าว');assert.equal(calls.news,filterBefore);assert.equal(await page.locator('#news-sources [aria-pressed="true"]').count(),2);
   const search=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('query')==='PTT');await page.locator('#news-search').fill('PTT');await search;await ready(1);assert.equal(await counter.textContent(),'603 ข่าว');await pick(2);
   partial=true;await select('all');assert.equal(await counter.textContent(),'ยังนับข่าวทั้งหมดไม่ได้');await pick(2);await pick(3);assert.equal(await counter.textContent(),'ยังนับข่าวทั้งหมดไม่ได้');
   // Original overflow recovery returns an empty response, then fetches the last valid page.
   const overflowBefore=calls.archive;await page.goto(base+'/?newsPage=9999#news',{waitUntil:'domcontentloaded'});await ready(120);assert.equal(calls.archive-overflowBefore,2);assert.match(page.url(),/newsPage=120/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list .news-title-link'));
   const watch=page.locator('#watchlist-news-pager'),beforeWatch={...calls};assert.equal(await page.locator('#watchlist-news-sources,.watch-source-chip,#watchlist-news-count').count(),0);assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/CROSS_ACCOUNT/);
   await watch.getByRole('button',{name:'2',exact:true}).press('Enter');assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),10);assert.equal(await page.evaluate(()=>scrollY),0);
   await watch.getByRole('button',{name:'ถัดไป',exact:true}).click();assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),5);assert.equal(await watch.getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);assert.equal(calls.watch,beforeWatch.watch);assert.equal(calls.news,beforeWatch.news);
   // No replacement for legacy live-only behavior: it continues to render page one.
   local=true;await page.locator('.nav-item[data-workspace-route="news"]').click();await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);const liveTitles=await page.locator('#news-list .news-title-link').allTextContents();await pager.getByRole('button',{name:'2',exact:true}).click();assert.deepEqual(await page.locator('#news-list .news-title-link').allTextContents(),liveTitles);assert.equal(await pager.locator('.active').textContent(),'1');
   console.log(JSON.stringify({viewport:label,checks,originalPagination:'PASS',orFiltersAndCount:'PASS',watchlistAndIsolation:'PASS',upstreamPerPage:0,overflowArchiveRequests:2,productionRequests:0}));await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
