'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
module.exports=async function checkBrowser({http,pool}){
 const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright'),port=await freePort(),base='http://127.0.0.1:'+port,rows=(await pool.query('select * from news_archive order by published_at desc,id desc limit 60')).rows;
 const items=rows.map(r=>({title:r.title,url:r.url,source:r.source,sourceName:r.source_name,snippet:r.snippet,pubDate:r.published_at.toISOString(),matchedSymbols:r.matched_symbols,verification:{status:'VERIFIED',basis:'metadata'}}));
 const totalRows=(await pool.query('select count(*)::int n from news_archive')).rows[0].n,formatted=n=>new Intl.NumberFormat('th-TH').format(n)+' ข่าว';
 const sourceCounts=(await pool.query("select source_name,count(*)::int n from news_archive group by source_name")).rows;
 const countFor=names=>sourceCounts.filter(r=>names.includes(r.source_name)).reduce((sum,r)=>sum+r.n,0);
 const server=spawn(process.execPath,[path.join(__dirname,'fixtures/news-archive-query-app.cjs')],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),SETSCOPE_WS7_HTTP_BASE:http.base,SETSCOPE_WS7_HTTP_TOKEN:http.token},windowsHide:true,stdio:'ignore'});let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false},calls={news:0,archive:0};
   await context.route('**/*',route=>{const request=route.request(),u=new URL(request.url()),json=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(u.origin===base&&u.pathname==='/api/news'){calls.news++;return json({items,dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/news-archive'){calls.archive++;return route.continue();}
    if(u.origin===base&&u.pathname==='/api/watchlist-news')return json({items:items.filter(x=>x.matchedSymbols.includes('PTT')).slice(0,25),dataState:'fresh'});
    if(u.origin===base&&u.pathname==='/api/news-analysis')return json({items:request.postDataJSON().items.map(()=>({summary:'',mode:'unavailable'}))});
    return mockRequest(route,base,state);
   });
   const page=await context.newPage(),diagnostics=[];page.on('pageerror',error=>diagnostics.push({pageError:error.message}));page.on('response',async response=>{if(new URL(response.url()).pathname==='/api/news-archive'){try{const data=await response.json();diagnostics.push({status:response.status(),total:data.total,mode:data.queryMode,error:data.error,detail:data.detail});}catch{}}});await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});try{await page.waitForFunction(expected=>document.querySelector('#news-count').textContent===expected&&!document.querySelector('#refresh-news').disabled,formatted(totalRows));}catch(error){console.error('WS7_BROWSER_DIAG '+JSON.stringify({diagnostics,state:await page.evaluate(()=>({authenticated:document.body.classList.contains('authenticated'),count:document.querySelector('#news-count')?.textContent,items:document.querySelectorAll('#news-list .news-title-link').length}))}));throw error;}
   const pager=page.locator('#news-pager'),newsBefore=calls.news;
   for(const n of [2,3,Math.ceil((totalRows-5)/10)]){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');await pager.getByRole('button',{name:String(n),exact:true}).click();const result=await (await response).json();assert.equal(result.queryMode,'database');assert.equal(result.total,totalRows-5);await page.waitForFunction(expected=>document.querySelector('#news-pager .active')?.textContent===String(expected),n);assert.deepEqual(await page.locator('#news-list .news-title-link').allTextContents(),result.items.map(x=>x.title));await page.waitForFunction(()=>scrollY===0);}
   assert.equal(calls.news,newsBefore);assert.equal(await pager.getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);
   for(const [source,count]of [['bangkokbiznews',formatted(countFor(['กรุงเทพธุรกิจ']))],['thansettakij',formatted(countFor(['กรุงเทพธุรกิจ','ฐานเศรษฐกิจ']))]]){const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive');await page.locator('#news-sources [data-source="'+source+'"]').click();await response;await page.waitForFunction(expected=>document.querySelector('#news-count').textContent===expected,count);}
   assert.equal(calls.news,newsBefore);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list .news-title-link'));
   assert.equal(await page.locator('#watchlist-news-sources,#watchlist-news-count').count(),0);await page.locator('#watchlist-news-pager').getByRole('button',{name:'2',exact:true}).click();assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),10);
   console.log('WS7_BROWSER '+JSON.stringify({viewport:label,actualNodeArchiveApi:true,actualPostgrest:true,rows:totalRows,frozenPagination:'PASS',deepPage:Math.ceil((totalRows-5)/10),orCounts:'PASS',watchlist:'PASS',upstreamOnPage:0,productionRequests:0}));await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
};
