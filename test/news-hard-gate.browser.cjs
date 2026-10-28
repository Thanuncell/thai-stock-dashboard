'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
(async()=>{const port=await freePort(),base='http://127.0.0.1:'+port,server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_EVIDENCE:'write'},windowsHide:true,stdio:'ignore'});let browser;
try{await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
for(const [label,viewport] of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
 const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false},now=Date.now();
 const proof={status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'};
 const item=(name,changes={})=>({title:'PTT '+name,url:'https://thunhoon.com/article-'+name,source:'thunhoon',sourceName:'Thunhoon',pubDate:new Date(now-60000).toISOString(),matchedSymbols:['PTT'],verification:proof,analysisMode:'ai',analysisSummary:'P1_STORED_AI',...changes});
 const bad=[item('P1_METADATA',{verification:{status:'VERIFIED',basis:'metadata'}}),item('P1_UNKNOWN',{verification:undefined}),item('P1_REJECTED',{verification:{status:'REJECTED'}}),item('P1_FUTURE',{pubDate:'2099-01-01T00:00:00Z'}),item('P1_PDF',{title:'P1_BAD.pdf'}),item('P1_SLUG',{title:'ptt-profit-investment-update'})];let live=true,withholdA=false;
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());const json=o=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
 if(url.origin===base&&url.pathname==='/api/news')return json({items:live?[item('P1_LIVE'),...bad]:[],dataState:'fresh'});
 if(url.origin===base&&url.pathname==='/api/news-archive')return json({configured:true,items:[item('P1_ARCHIVE'),...bad],featured:[item('P1_FALLBACK'),...bad],total:1,page:1,pageSize:10,dataState:'fresh'});
 if(url.origin===base&&url.pathname==='/api/watchlist-news'){const owner=req.headers().authorization?.includes('token-b')?'B':'A',symbol=JSON.parse(url.searchParams.get('stocks')||'[]')[0]?.symbol||'PTT';
 const valid=item('P1_WATCH_'+owner,{title:symbol+' P1_WATCH_'+owner,matchedSymbols:[symbol]});
 if(owner==='A'&&withholdA)return json({items:[],withheldUrls:[valid.url],total:0,dataState:'unavailable'});
 return json({items:[valid,...bad,item('P1_WRONG_STOCK',{matchedSymbols:['NEVER']})],total:1,dataState:'fresh'});}
 if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:(req.postDataJSON().items||[]).map(()=>({summary:'',mode:'unavailable'})),mode:'unavailable'});
 return mockRequest(route,base,state);});
 const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/?symbol=PTT#news',{waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');
 await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('P1_LIVE'));await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('P1_ARCHIVE'));
 const assertHidden=async()=>assert.doesNotMatch(await page.locator('#news-section').textContent(),/P1_METADATA|P1_UNKNOWN|P1_REJECTED|P1_FUTURE|P1_BAD\.pdf|ptt-profit-investment-update/);
 await assertHidden();assert.match(await page.locator('#news-section').textContent(),/P1_STORED_AI/);live=false;await page.locator('#refresh-news').click();await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('P1_FALLBACK'));await assertHidden();
 await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('P1_WATCH_A'));
 assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/P1_METADATA|P1_UNKNOWN|P1_REJECTED|P1_FUTURE|P1_BAD\.pdf|P1_WRONG_STOCK/);
 withholdA=true;await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>!document.querySelector('#watchlist-news-list')?.textContent.includes('P1_WATCH_A'));
 await page.locator('#logout-button').click();await page.waitForSelector('#login-form:not([hidden])');await page.locator('#login-form input[name="email"]').fill('b@example.test');await page.locator('#login-form input[name="password"]').fill('fixture-password');await page.locator('#login-form button[type="submit"]').click();await page.waitForSelector('body.authenticated');
 await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.locator('#refresh-watchlist-news').click();await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('P1_WATCH_B'));assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/P1_WATCH_A/);
 await page.screenshot({path:path.join(process.env.TEMP||'.','setscope-p1-'+label+'.png'),fullPage:true});console.log(JSON.stringify({viewport:label,checks:8,status:'PASS',featured:true,latestArchive:true,fallback:true,watchlist:true,negativeCache:true,withdrawalFence:true,storedAiPreserved:true,accountIsolation:true}));await context.close();
}
}finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});