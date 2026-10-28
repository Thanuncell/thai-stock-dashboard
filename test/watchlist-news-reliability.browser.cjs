'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const {createNewsService}=require('./fixtures/news-service.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false,time:Date.now(),calls:[],rows:1,failure:false,holdStock:'',releaseStock:null,holdA:false,releaseA:null,puts:[]};
   const saved={a:{watchlists:[{id:'list-1',name:'A PRIVATE MAIN',items:[{symbol:'PTT',name:'PTT'}]},{id:'list-2',name:'A PRIVATE SECOND',items:[{symbol:'SCB',name:'SCB'}]}],active_watchlist_id:'list-1'},b:{watchlists:[{id:'list-1',name:'B PRIVATE MAIN',items:[{symbol:'PTT',name:'PTT'},{symbol:'KKP',name:'KKP'}]}],active_watchlist_id:'list-1'}};
   const engine=createNewsService({now:()=>state.time,fetchImpl:async(value)=>{
    const query=new URL(value).searchParams.get('q'),symbol=query.match(/^\("([^"]+)"/)[1];state.calls.push(symbol);
    if(state.holdStock===symbol){state.holdStock='';await new Promise(resolve=>{state.releaseStock=resolve;});}
    if(state.failure)return new Response('',{status:503});
    return new Response('<rss><channel>'+Array.from({length:state.rows},(_,i)=>`<item><title>${symbol} รายงานผลประกอบการ ข่าวสาธารณะ ${i}</title><link>https://www.kaohoon.com/news/public-${symbol}${i?'-'+i:''}</link><pubDate>${new Date(state.time-i*1000).toUTCString()}</pubDate><description>บริษัทเปิดเผยตัวเลขกำไรและรายละเอียดผลประกอบการล่าสุด</description><source>ข่าวหุ้น</source></item>`).join('')+'</channel></rss>');
   }});
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url()),owner=/token-b/.test(request.headers().authorization||'')?'b':'a';
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/watchlists'){
     if(request.method()==='PUT'){const body=request.postDataJSON();state.puts.push({owner,body});saved[owner]={watchlists:body.watchlists,active_watchlist_id:body.activeWatchlistId};return json({ok:true,syncedAt:new Date().toISOString()});}
     return json({record:saved[owner]});
    }
    if(url.origin===base&&url.pathname==='/api/search'){const symbol=url.searchParams.get('q').toUpperCase();return json({items:[{symbol,name:symbol,exchange:'SET'}]});}
    if(url.origin===base&&url.pathname==='/api/news')return json({items:[],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-archive')return json({configured:false,items:[],featured:[],total:0});
    if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:request.postDataJSON().items.map(()=>({summary:'Fixture keyword assessment',mode:'rules'}))});
    if(url.origin===base&&url.pathname==='/api/watchlist-news'){
     const result=await engine.getWatchlistNews(JSON.parse(url.searchParams.get('stocks')),{ownerId:owner,refresh:url.searchParams.get('refresh')==='1'});
     if(owner==='a'&&state.holdA){state.holdA=false;await new Promise(resolve=>{state.releaseA=resolve;});}
     return json(result);
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#watchlist',{waitUntil:'domcontentloaded'});
   const news=page.locator('#watchlist-news-list');await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('PTT รายงาน'));
   const add=async symbol=>{
    await page.locator('.nav-item[data-workspace-route="chart"]').click();await page.locator('#stock-search').fill(symbol);
    await page.locator('.suggestion-item[data-symbol="'+symbol+'"]').click();await page.locator('#watchlist-add-active').click();
    await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
   };
   state.holdStock='OR';await add('OR');
   for(let i=0;i<100&&!state.releaseStock;i++)await pause(20);assert.ok(state.releaseStock);
   assert.match(await news.textContent(),/PTT รายงาน/,'adding a stock cannot clear existing verified news while loading');state.releaseStock();
   await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('OR รายงาน'));
   for(const symbol of ['KBANK','BBL']){await add(symbol);await page.waitForFunction(symbol=>document.querySelector('#watchlist-news-list')?.textContent.includes(symbol+' รายงาน'),symbol);}
   for(const symbol of ['PTT','OR','KBANK','BBL'])assert.match(await news.textContent(),new RegExp(symbol+' รายงาน'));
   assert.equal(state.calls.filter(s=>s==='PTT').length,1);assert.equal(await news.locator('.news-item').count(),4);
   await page.locator((label==='mobile'?'#watchlist-mobile':'#watchlist')+' [data-remove="OR"]').click();
   await page.waitForFunction(()=>!document.querySelector('#watchlist-news-list')?.textContent.includes('OR รายงาน'));assert.match(await news.textContent(),/PTT รายงาน/);
   const picker=page.locator(label==='mobile'?'#watchlist-select-mobile':'#watchlist-select');await picker.selectOption('list-2');
   await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('SCB รายงาน'));assert.doesNotMatch(await news.textContent(),/PTT รายงาน|KBANK รายงาน/);
   await picker.selectOption('list-1');await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('PTT รายงาน'));
   state.failure=true;await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.dataset.state==='stale');assert.match(await news.textContent(),/PTT รายงาน/);
   state.failure=false;state.time+=31000;state.holdA=true;await page.locator('#refresh-watchlist-news').click();
   for(let i=0;i<100&&!state.releaseA;i++)await pause(20);assert.ok(state.releaseA);
   await page.locator('#logout-button').click();await page.waitForSelector('#login-form:not([hidden])');
   await page.locator('#login-form input[name="email"]').fill('b@example.test');await page.locator('#login-form input[name="password"]').fill('fixture-password');await page.locator('#login-form button[type="submit"]').click();await page.waitForSelector('body.authenticated');
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('KKP รายงาน'));
   state.releaseA();await pause(150);
   assert.doesNotMatch(await page.locator('body').textContent(),/A PRIVATE MAIN|A PRIVATE SECOND/);assert.match(await page.locator('body').textContent(),/B PRIVATE MAIN/);
   assert.doesNotMatch(await news.textContent(),/OR รายงาน|KBANK รายงาน|BBL รายงาน|SCB รายงาน/);assert.match(await news.textContent(),/PTT รายงาน/,'public PTT news may legitimately appear in both accounts');
   assert.ok(await news.locator('a[href="https://www.kaohoon.com/news/public-PTT"]').count()>0);
   for(const put of state.puts.filter(put=>put.owner==='b'))assert.doesNotMatch(JSON.stringify(put.body),/A PRIVATE/);
   state.rows=20;state.time+=61000;await page.locator('#refresh-watchlist-news').click();
   await page.waitForFunction(()=>[...document.querySelectorAll('#watchlist-news-pager button')].some(button=>button.textContent==='4'));
   const calls=state.calls.length,urls=new Set();
   for(let i=0;i<4;i++){for(const url of await news.locator('.news-title-link').evaluateAll(nodes=>nodes.map(node=>node.href)))urls.add(url);if(i<3)await page.locator('#watchlist-news-pager').getByRole('button',{name:'ถัดไป',exact:true}).click();}
   assert.equal(urls.size,40);assert.equal([...urls].filter(url=>url.includes('public-PTT')).length,20);assert.equal([...urls].filter(url=>url.includes('public-KKP')).length,20);assert.equal(state.calls.length,calls,'pagination never fetches more RSS');
   console.log(JSON.stringify({viewport:label,automatedAccountAB:'PASS',addRemoveMergeSwitch:'PASS',retainedDuringLoadingAndFailure:'PASS',privateCacheAndDelayedResponseIsolation:'PASS',sharedPublicNewsAllowed:'PASS',pagination40AcrossStocks:'PASS',productionAccountIsolation:'NOT RUN'}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
