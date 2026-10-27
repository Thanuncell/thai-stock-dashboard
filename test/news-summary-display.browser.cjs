'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const {withNewsRulesSummary}=require('../lib/news-summary');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
 const port=await freePort(),base='http://127.0.0.1:'+port;
 const server=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture',SUPABASE_SECRET_KEY:'',SUPABASE_SERVICE_ROLE_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let browser;
 try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [label,viewport]of [['desktop',{width:1366,height:900}],['mobile',{width:390,height:844}]]){
   const context=await browser.newContext({viewport}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false,live:false,ai:'429',calls:[]};
   const target=withNewsRulesSummary({title:'PTT กำไรเพิ่มจากผลประกอบการ',url:'https://www.kaohoon.com/news/display-target',source:'kaohoon',sourceName:'ข่าวหุ้น',snippet:'บริษัทเปิดเผยตัวเลขกำไรและรายละเอียดผลประกอบการล่าสุด',pubDate:new Date().toISOString(),verification:{status:'VERIFIED'}});
   const other=withNewsRulesSummary({...target,title:'บริษัทแจ้งความคืบหน้าโครงการ',url:'https://www.kaohoon.com/news/project',snippet:'บริษัทแจ้งรายละเอียดโครงการลงทุนและแผนดำเนินงานล่าสุด',analysisMode:'',analysisSummary:''});
   const sparse={...target,title:'PTT กำไรเพิ่มแต่ข้อมูลย่อไม่ครบ',url:'https://www.kaohoon.com/news/sparse',snippet:'',analysisMode:'',analysisSummary:''};
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/news')return json({items:state.live?[target]:[],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-archive')return json({configured:true,dataState:'fresh',items:[{...target,fingerprint:'archive-target'},other,sparse],featured:[],total:3});
    if(url.origin===base&&url.pathname==='/api/watchlist-news')return json({items:[],dataState:'fresh'});
    if(url.origin===base&&url.pathname==='/api/news-analysis'){
     const items=request.postDataJSON().items;state.calls.push(items);
     return state.ai==='429'?json({error:'Synthetic temporary limit'},429):json({items:items.map(()=>({summary:'ACTUAL_AI_UPGRADE',mode:'ai',basis:'snippet'}))});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();await seedPage(page,'token-a');await page.goto(base+'/#news',{waitUntil:'domcontentloaded'});
   await page.waitForSelector('body.authenticated');await page.waitForFunction(()=>document.querySelector('#news-list')?.textContent.includes('เกี่ยวกับผลประกอบการ'));
   const card=title=>page.locator('#news-section .news-item').filter({has:page.locator('.news-title-link',{hasText:title})});
   assert.equal(state.calls.length,0,'archive-only rows never trigger an AI batch');
   assert.equal(await card(target.title).locator('.news-ai-summary b').textContent(),'ประเมินจากคำสำคัญ');
   assert.match(await card(target.title).locator('.news-impact').textContent(),/บวก/);
   assert.doesNotMatch(await card(other.title).locator('.news-ai-summary').textContent(),/เกี่ยวกับผลประกอบการ/);
   assert.match(await card(sparse.title).locator('.news-ai-summary').textContent(),/สรุปไม่พร้อม/);
   assert.match(await card(sparse.title).locator('.news-impact').textContent(),/บวก/);
   state.live=true;await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);
   assert.equal(state.calls.length,1);assert.deepEqual(state.calls[0].map(item=>item.url),[target.url]);
   assert.match(await card(target.title).locator('.news-ai-summary').textContent(),/เกี่ยวกับผลประกอบการ/);
   for(let i=0;i<12;i++){await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);}
   assert.equal(state.calls.length,1,'manual refresh cannot storm or drain archive AI requests');
   await page.evaluate(()=>{const original=Date.now;Date.now=()=>original()+61000;});state.ai='success';
   await page.locator('#refresh-news').click();await page.waitForFunction(()=>document.querySelector('#featured-news')?.textContent.includes('ACTUAL_AI_UPGRADE'));
   assert.equal(state.calls.length,2);assert.match(await card(target.title).locator('.news-ai-summary b').textContent(),/โดย AI/);
   await page.locator('.source-chip[data-source="kaohoon"]').click();await page.locator('.source-chip[data-source="all"]').click();
   await page.locator('#refresh-news').click();await page.waitForFunction(()=>!document.querySelector('#refresh-news').disabled);
   assert.equal(state.calls.length,2);assert.match(await card(target.title).locator('.news-ai-summary').textContent(),/ACTUAL_AI_UPGRADE/);
   await pause(100);assert.equal(state.calls.length,2);
   console.log(JSON.stringify({viewport:label,archiveRulesWithoutAi:'PASS',insufficientSnippet:'PASS',independentSentiment:'PASS',temporary429RecoveryAndAiPriority:'PASS',noRequestStormOrBulk:'PASS'}));
   await context.close();
  }
 }finally{await browser?.close().catch(()=>{});server.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
