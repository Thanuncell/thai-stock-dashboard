'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
(async()=>{const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:'',SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_P1_DISPLAY_GATE:'off',SETSCOPE_GOOGLE_NEWS_RPC:'off'}});let browser;
 try{await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE});
 for(const [label,viewport,hardGate] of [['desktop-off',{width:1366,height:900},false],['mobile-off',{width:390,height:844},false],['desktop-on',{width:1366,height:900},true],['mobile-on',{width:390,height:844},true]]){
  const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false};
  const proof={status:'VERIFIED',basis:'article',reason:'ARTICLE_IDENTITY_VERIFIED',displayPolicy:'news-display-1'},date=new Date(Date.now()-60000).toISOString();
  const make=(name,changes={})=>{const url='https://www.set.or.th/th/market/news-and-alert/newsdetails?id='+name;return {title:name+' แจ้งผลการดำเนินงาน',url,source:'settrade',sourceName:'SET',pubDate:date,verification:proof,analysisMode:'ai',analysisSummary:'G1_STORED_AI',matchedSymbols:['OR'],securityIdentification:{status:'IDENTIFIED',symbols:['PTT','PTTEP'],publisherUrl:url},linkVerification:{status:'VERIFIED',kind:'ARTICLE'},displayUrl:url,...changes};};
  const multi=make('SET_MULTI'),latest=make('SET_LATEST');
  const unknown=make('SET_UNKNOWN',{sourceName:'Settrade',securityIdentification:{status:'UNVERIFIED',symbols:[],reason:'ISSUER_NOT_IDENTIFIED'},matchedSymbols:['PTT']});
  const other=make('OTHER_PUBLISHER',{source:'infoquest',sourceName:'InfoQuest',url:'https://www.infoquest.co.th/2026/browser-other',displayUrl:'https://www.infoquest.co.th/2026/browser-other',matchedSymbols:['OR']});
  const pdfWord=make('PDF ข่าวจริงรายงานคู่มือสำหรับนักลงทุน',{source:'thunhoon',sourceName:'Thunhoon',url:'https://thunhoon.com/browser-article',displayUrl:'https://thunhoon.com/browser-article',matchedSymbols:['PTT']});
  const resolved=make('SET_RESOLVED',{url:'https://news.google.com/rss/articles/browser-resolved',verification:{status:'VERIFIED',basis:'metadata'}});
  const bangkok=make('BANGKOK_ARTICLE',{source:'other',sourceName:'กรุงเทพธุรกิจ',url:'https://bangkokbiznews.com/finance/stock/1234567',displayUrl:'https://bangkokbiznews.com/finance/stock/1234567',matchedSymbols:['PTT']});
  const than=make('THANSETTAKIJ_ARTICLE',{source:'other',sourceName:'ฐานเศรษฐกิจ',url:'https://thansettakij.com/finance/stock/1234567',displayUrl:'https://thansettakij.com/finance/stock/1234567',matchedSymbols:['PTT']});
  const bad=[make('BLOCKED_PDF',{linkVerification:{status:'UNVERIFIED',kind:'DOCUMENT',reason:'DOCUMENT_RESPONSE'}}),make('BLOCKED_LISTING',{linkVerification:{status:'UNVERIFIED',kind:'NON_ARTICLE',reason:'ARCHIVE_LISTING_PATH'}})];
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url()),json=o=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({p1DisplayGate:hardGate,...o})});
   if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
   if(url.origin===base&&url.pathname==='/api/news')return json({items:[multi,unknown,other,pdfWord,resolved,bangkok,than,...bad],dataState:'fresh'});
   if(url.origin===base&&url.pathname==='/api/news-archive'){
    const all=[latest,bangkok,than,...bad],query=(url.searchParams.get('query')||'').toUpperCase(),items=query?all.filter(x=>(x.securityIdentification?.symbols||[]).includes(query)||x.title.toUpperCase().includes(query)):all;
    return json({configured:true,items,featured:[],total:1,page:1,pageSize:10,dataState:'fresh'});
   }
   if(url.origin===base&&url.pathname==='/api/watchlist-news')return json({items:[multi,unknown,pdfWord,bangkok,than,...bad],total:3,dataState:'fresh'});
   if(url.origin===base&&url.pathname==='/api/news-analysis')return json({items:(req.postDataJSON().items||[]).map(()=>({summary:'',mode:'unavailable'}))});
   return mockRequest(route,base,state);
  });
  const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/?symbol=PTT#news',{waitUntil:'domcontentloaded'});await page.waitForSelector('body.authenticated');
  await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('SET_MULTI'));
  const card=page.locator('#featured-news .news-item').filter({hasText:'SET_MULTI'});
  assert.equal(await card.locator('.news-relevance').textContent(),'PTT, PTTEP');
  assert.match(await page.locator('#featured-news .news-item').filter({hasText:'SET_UNKNOWN'}).textContent(),/ยังไม่ระบุหลักทรัพย์/);
  assert.equal(await page.locator('#featured-news .news-item').filter({hasText:'OTHER_PUBLISHER'}).locator('.news-relevance').textContent(),'OR');
  assert.doesNotMatch(await page.locator('#news-section').textContent(),/BLOCKED_PDF|BLOCKED_LISTING/);
  assert.match(await page.locator('#news-section').textContent(),/PDF ข่าวจริง/);
  assert.match(await page.locator('#news-section').textContent(),/BANGKOK_ARTICLE/);
  assert.equal(await page.locator('#news-section .news-item').filter({hasText:'BANGKOK_ARTICLE'}).locator('.news-title').first().getAttribute('href'),bangkok.url);
  assert.match(await page.locator('#news-section').textContent(),/THANSETTAKIJ_ARTICLE/);
  assert.equal(await page.locator('#news-section .news-item').filter({hasText:'THANSETTAKIJ_ARTICLE'}).locator('.news-title').first().getAttribute('href'),than.url);
  if(hardGate)assert.doesNotMatch(await page.locator('#news-section').textContent(),/SET_RESOLVED/);
  else{const link=page.locator('#news-section .news-item').filter({hasText:'SET_RESOLVED'}).locator('.news-title');assert.equal(await link.getAttribute('href'),resolved.displayUrl);}
  assert.equal(await page.locator('#news-section .news-document-tag').count(),0);
  await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('SET_LATEST'));
  await page.locator('#news-search').fill('PTTEP');await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('SET_LATEST'));
  assert.equal(await page.locator('#news-list .news-item').filter({hasText:'SET_LATEST'}).locator('.news-relevance').textContent(),'PTT, PTTEP');
  await page.locator('.nav-item[data-workspace-route="watchlist"]').click();await page.locator('#refresh-watchlist-news').click();
  await page.waitForFunction(()=>document.querySelector('#watchlist-news-list')?.textContent.includes('SET_MULTI'));
  assert.equal(await page.locator('#watchlist-news-list .news-item').filter({hasText:'SET_MULTI'}).locator('.news-relevance').textContent(),'PTT, PTTEP');
  assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/BLOCKED_PDF|BLOCKED_LISTING/);
  await page.locator('#refresh-watchlist-news').click();assert.doesNotMatch(await page.locator('#watchlist-news-list').textContent(),/BLOCKED_PDF|BLOCKED_LISTING/);
  assert.match(await page.locator('#watchlist-news-list').textContent(),/BANGKOK_ARTICLE/);
  assert.match(await page.locator('#watchlist-news-list').textContent(),/THANSETTAKIJ_ARTICLE/);
  await page.screenshot({path:path.join(process.env.TEMP,'setscope-link-security-'+label+'.png'),fullPage:true});
  console.log(JSON.stringify({viewport:label,checks:18,status:'PASS',issuerScope:true,multiSymbol:true,unknownLabel:true,articlePdfWord:true,linkFilter:true,search:true,archive:true,watchlist:true,cachedResponses:true}));await context.close();
 }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
