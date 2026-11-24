'use strict';
// Real Node API -> localhost PostgREST -> disposable PostgreSQL. Only auth/live
// provider shells are mocked. Archive requests are never fulfilled by Playwright.
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
module.exports=async function nativeBrowser({http,pool,oracle,evidence}){
 const port=await freePort(),base='http://127.0.0.1:'+port,root=path.join(__dirname,'..');
 const child=spawn(process.execPath,['test/fixtures/news-archive-query-app.cjs'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),SETSCOPE_WS7_HTTP_BASE:http.base,SETSCOPE_WS7_HTTP_TOKEN:http.token}});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
  const watch=(await oracle.list({symbol:'PTT',pageSize:50})).items.slice(0,25);
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[]},calls={archive:0,news:0},responses=[],responseReads=[],errors=[];let hold=null;
   await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url()),json=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
    if(u.hostname==='fonts.googleapis.com'||u.hostname==='fonts.gstatic.com')return route.fulfill({status:200,body:''});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(u.origin===base&&u.pathname==='/api/news-archive'){
     calls.archive++;if(hold){const pending=hold;hold=null;pending.started();await pending.wait;}
     return route.continue();
    }
    if(u.origin===base&&u.pathname==='/api/news'){calls.news++;return json({items:[],dataState:'fresh'});}
    if(u.origin===base&&u.pathname==='/api/watchlist-news')return json({items:watch,dataState:'fresh'});
    if(u.origin===base&&u.pathname==='/api/news-analysis')return json({items:(request.postDataJSON()?.items||[]).map(()=>({mode:'unavailable',summary:''}))});
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   const collectResponse=r=>{if(new URL(r.url()).pathname==='/api/news-archive')responseReads.push(r.json().then(body=>responses.push({status:r.status(),body})).catch(error=>errors.push(error.message)));};
   page.on('response',collectResponse);
   const ready=async()=>{await page.waitForFunction(()=>document.body.classList.contains('authenticated')&&document.querySelector('#news-list')?.getAttribute('aria-busy')==='false'&&!document.querySelector('#refresh-news').disabled&&document.querySelector('#news-pager [aria-current="page"]'));await Promise.all(responseReads);};
   const pick=async n=>{await page.locator('#news-pager').getByRole('button',{name:String(n),exact:true}).click();await page.waitForFunction(n=>document.querySelector('#news-pager [aria-current="page"]')?.textContent===String(n),n);await ready();};
   const nums=()=>page.locator('#news-pager button').allTextContents().then(x=>x.filter(v=>/^\d+$/.test(v)));
   await seedPage(page,'token-a');await page.goto(base+'/?newsPage=7#news');await ready();
   assert.equal(calls.archive,1);assert.equal(responses.at(-1).body.queryMode,'database-cursor');assert.equal('total' in responses.at(-1).body,false);
   assert.deepEqual(await nums(),['1','2','3','4','5']);for(const n of [1,2,3,4,5])assert.equal(await page.locator('#news-pager').getByRole('button',{name:String(n),exact:true}).isDisabled(),false);
   assert.equal(await page.locator('#news-list .news-title-link').count(),10);assert.equal(await page.locator('#featured-news .news-title-link').count(),5);assert.equal(await page.locator('#news-count').isVisible(),false);
   const featured=await page.locator('#featured-news .news-title-link').allTextContents(),newsBefore=calls.news;
   await pick(5);assert.equal(calls.archive,2);assert.deepEqual(await nums(),['3','4','5','6','7']);
   const expected=(await oracle.list({page:5,featuredCount:5})).items;assert.deepEqual(await page.locator('#news-list .news-title-link').allTextContents(),expected.map(x=>x.title));
   const beforeBack=calls.archive;await page.goBack();await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='1');await ready();assert.equal(calls.archive,beforeBack);
   await pick(2);await pick(4);assert.deepEqual(await nums(),['2','3','4','5','6']);assert.equal(calls.news,newsBefore);
   assert.deepEqual(await page.locator('#featured-news .news-title-link').allTextContents(),featured);
   const beforeRefresh=calls.archive;await page.locator('#refresh-news').click();await ready();assert.equal(calls.archive,beforeRefresh+1);assert.equal(calls.news,newsBefore);
   // Revision changes while the browser holds an outbound request; actual RPC
   // must reject the old context, then client recovers with one first-page read.
   let release,started;const wait=new Promise(r=>{release=r;}),didStart=new Promise(r=>{started=r;});hold={wait,started};
   await page.locator('#refresh-news').click();await didStart;await pool.query('update news_archive_query_state set index_revision=index_revision+1 where singleton=true');release();
   await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='1');await ready();assert.ok(responses.some(x=>x.status===409));
   await page.locator('#news-search').fill('DEEP_NATIVE');await page.waitForFunction(()=>document.querySelectorAll('#news-list .news-title-link').length===1&&document.querySelector('#news-list').getAttribute('aria-busy')==='false');
   assert.match(await page.locator('#news-list').textContent(),/DEEP_NATIVE/);assert.deepEqual(await nums(),['1']);assert.equal(await page.locator('#news-pager').getByRole('button',{name:'ถัดไป',exact:true}).isDisabled(),true);
   await page.locator('#news-search').fill('');await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&!new URL(r.url()).searchParams.get('query'));await ready();
   await page.locator('#news-sources [data-source="infoquest"]').click();await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/news-archive'&&new URL(r.url()).searchParams.get('source')==='infoquest');await ready();
   assert.ok(responses.at(-1).body.items.every(x=>x.source==='infoquest'));
   await page.locator('#news-pager').getByRole('button',{name:'2',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.querySelector('#news-pager [aria-current="page"]')?.textContent==='2');
   await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list .news-title-link'));
   await page.locator('#watchlist-news-pager').getByRole('button',{name:'2',exact:true}).click();assert.equal(await page.locator('#watchlist-news-list .news-title-link').count(),10);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   // Drain evidence reads while the context still exists; async event listeners
   // otherwise outlive desktop teardown and fail the following mobile run.
   page.off('response',collectResponse);await Promise.all(responseReads);assert.deepEqual(errors,[]);
   evidence.push({nativeBrowser:label,viewport,actualNodeApi:true,actualPostgrest:true,actualPostgres:true,archiveRequests:calls.archive,providerRequests:0,status:'PASS'});
   console.log('G2B_NATIVE_BROWSER '+JSON.stringify(evidence.at(-1)));await context.close();
  }
  assert.equal((await fetch(base+'/api/news-archive?pagination=cursor')).status,401);
 }finally{await browser?.close();child.kill();}
};
