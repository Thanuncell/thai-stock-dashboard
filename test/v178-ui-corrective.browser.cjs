'use strict';
// Full SETscope app with existing auth/reader/provider fixtures. No live services.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const engine=process.env.SETSCOPE_UI_ENGINE||'chromium';
const { [engine]: browserType }=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage}=require('./account-isolation.browser.cjs');
process.env.SUPABASE_URL='https://isolation-test.supabase.co';
process.env.SUPABASE_ANON_KEY='public-browser-fixture';
process.env.SUPABASE_SECRET_KEY='';process.env.SUPABASE_SERVICE_ROLE_KEY='';
const {createRuntimeServer}=require('../offline-news-impact/runtime.cjs');
const {createFixtureAuth}=require('../offline-news-impact/fixtures/auth.cjs');
const {loadCatalog}=require('../offline-news-impact/fixtures/coverage.cjs');
const {createReader}=require('../offline-news-impact/reader.cjs');
const f=require('../offline-news-impact/fixtures/news.cjs');
const before=process.env.SETSCOPE_UI_PHASE==='before',dir=process.env.SETSCOPE_UI_EVIDENCE;
if(dir)fs.mkdirSync(dir,{recursive:true});
let checks=0,phase='setup';const results=[];
const check=(got,want,note)=>{assert.deepEqual(got,want,note);checks++;};
const frames=p=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const rgb=s=>{s=s.trim();if(s.startsWith('#')){let h=s.slice(1);if(h.length===3)h=h.split('').map(x=>x+x).join('');return h.match(/../g).map(x=>parseInt(x,16));}return s.match(/[\d.]+/g).slice(0,3).map(Number);};
const mix=(a,b,alpha)=>a.map((x,i)=>x*alpha+b[i]*(1-alpha));
const luminance=a=>a.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
(async()=>{
 const provider=f.mockProvider(),server=createRuntimeServer({entryModule:'production.mjs',loadCatalog,auth:createFixtureAuth(),reader:createReader({loadHtml:async()=>({status:200,html:f.html})}),provider});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await browserType.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [width,theme]of [[1366,'light'],[1366,'dark'],[390,'light'],[390,'dark'],[320,'light']]){
   const context=await browser.newContext({viewport:{width,height:900}}),state={getOwners:[],putOwners:[]},errors=[],api=[];
   const articles=Array.from({length:25},(_,i)=>({title:'PTT ข่าวจำลอง '+i,url:'https://www.kaohoon.com/news/ui-fix-'+i,pubDate:new Date(Date.now()-i*1000).toISOString(),source:'kaohoon',sourceName:'ข่าวหุ้น',matchedSymbols:['PTT'],verification:{status:'VERIFIED'}}));
   await context.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url()),json=x=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(x)});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(u.origin===base&&u.pathname.startsWith('/api/'))api.push(u.pathname);
    if(u.origin===base&&u.pathname==='/api/news-impact-phase1')return route.continue();
    if(u.pathname==='/api/market'){
     const rows=Array.from({length:260},(_,i)=>({time:Date.UTC(2026,9,20,3)+i*60000,open:100+Math.sin(i*.3)*4,close:100.4+Math.sin(i*.3)*4,high:103+Math.sin(i*.3)*4,low:98+Math.sin(i*.3)*4,volume:1000+i})),meta={interval:'1m',receivedAt:new Date(rows.at(-1).time+60000).toISOString()};
     return json({stocks:[{symbol:'PTT',last:100,prior:99,history:rows,guardStatus:'accepted',dataState:'delayed'}],history:rows,indicatorHistory:rows,levelsHistory:rows,technicalMeta:{history:meta,indicator:meta,levels:meta},fetchedAt:meta.receivedAt,indices:[],errors:[],dataState:'delayed'});
    }
    if(u.pathname==='/api/news')return json({items:articles.slice(0,5),dataState:'fresh'});
    if(u.pathname==='/api/news-archive'){const page=Number(u.searchParams.get('page')||1);return json({configured:true,items:articles.slice((page-1)*10,page*10),featured:[],page,pageSize:10,total:25,dataState:'fresh'});}
    if(u.pathname==='/api/watchlist-news')return json({items:articles,dataState:'fresh'});
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await seedPage(page,'token-a');await page.addInitScript(t=>localStorage.setItem('setscope-theme',t),theme);
   const shot=async(name,locator)=>{if(dir){await locator.scrollIntoViewIfNeeded();await locator.screenshot({path:path.join(dir,`${engine}-${width}-${theme}-${name}.png`)});}};
   phase=`${width}-${theme}-drawing`;await page.goto(base+'/?symbol=PTT&range=1D#chart');await page.waitForSelector('.price-candle');
   await page.locator('[data-draw-tool=measure]').click();await page.locator('#stock-price-chart').scrollIntoViewIfNeeded();const b=await page.locator('.price-chart-svg').boundingBox();
   await page.mouse.move(b.x+b.width*.32,b.y+80);await page.mouse.down();await page.mouse.move(b.x+b.width*.55,b.y+140,{steps:4});await page.mouse.up();await frames(page);await page.waitForSelector('.drawing-label');
   const drawing=await page.locator('.drawing-label').evaluate(el=>({fill:getComputedStyle(el).fill,ink:getComputedStyle(document.documentElement).getPropertyValue('--ink'),paper:getComputedStyle(document.documentElement).getPropertyValue('--paper'),label:el.textContent,stroke:getComputedStyle(document.querySelector('.drawing.selected .drawing-line')).stroke}));
   drawing.contrast=contrast(rgb(drawing.fill),rgb(drawing.paper.trim()));
   check(drawing.label.includes('%'),true,'measurement includes unchanged price/percentage output');check(drawing.stroke,'rgb(38, 116, 221)','selected drawing stroke preserved');if(!before)check(drawing.contrast>=4.5,true,'drawing label contrast');await shot('drawing',page.locator('#stock-price-chart'));await page.locator('#stock-search').focus();await shot('stock-search-reference',page.locator('.stock-search-wrap'));
   const pagerResults={};
   const inspectPager=async(id,name)=>{
    const pager=page.locator(id);await pager.waitFor({state:'visible'});
    const read=()=>pager.locator('.page-btn').evaluateAll(nodes=>nodes.map(el=>{const s=getComputedStyle(el);return{text:el.textContent,active:el.classList.contains('active'),disabled:el.disabled,color:s.color,background:s.backgroundColor,opacity:Number(s.opacity),paper:getComputedStyle(el.parentElement).backgroundColor};}));
    const initial=await read(),active=initial.find(x=>x.active),normal=initial.find(x=>!x.active&&!x.disabled),disabled=initial.find(x=>x.disabled);
    check(Boolean(active&&normal&&disabled),true,'real pager contains normal active and disabled states');
    const baseColor=await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--paper').trim()),paper=rgb(baseColor);
    for(const item of initial)item.contrast=contrast(mix(rgb(item.color),paper,item.opacity),mix(rgb(item.background),paper,item.opacity));
    await pager.locator('.page-btn:not(.active):not(:disabled)').first().hover();const hover=(await read()).find(x=>x.text===normal.text);hover.contrast=contrast(rgb(hover.color),rgb(hover.background));
    await pager.locator('.page-btn.active').hover();const activeHover=(await read()).find(x=>x.active);activeHover.contrast=contrast(rgb(activeHover.color),rgb(activeHover.background));
    pagerResults[name]={initial,hover,activeHover};
    if(!before){check(active.background!==normal.background,true,'active page has distinct background');check(initial.every(x=>x.contrast>=4.5),true,'normal active disabled text contrast');check(hover.contrast>=4.5,true,'normal hover text contrast');check(activeHover.contrast>=4.5,true,'active hover text contrast');check(activeHover.background,active.background,'active remains identifiable on hover');}
    await shot(name+'-pager',pager);await pager.getByRole('button',{name:'2',exact:true}).click();await page.waitForFunction(id=>document.querySelector(id+' .page-btn.active')?.textContent==='2',id);check(await pager.locator('.page-btn.active').textContent(),'2','same page selection behavior');
   };
   phase=`${width}-${theme}-main-pager`;await page.locator('.nav-item[data-workspace-route=news]').click();await page.waitForSelector('#news-pager .page-btn');await inspectPager('#news-pager','main');
   phase=`${width}-${theme}-watch-pager`;await page.locator('.nav-item[data-workspace-route=watchlist]').click();await page.waitForSelector('#watchlist-news-pager .page-btn');await inspectPager('#watchlist-news-pager','watchlist');
   phase=`${width}-${theme}-url`;await page.locator('.nav-item[data-workspace-route=news]').click();await page.locator('#news-impact-tab').click();const url=page.locator('#impact-url'),submit=page.locator('#impact-submit'),calls=api.filter(p=>p==='/api/news-impact-phase1').length,providerCalls=provider.calls;
   check(await submit.textContent(),'วิเคราะห์ผลกระทบ','analysis action label preserved');await url.fill('https://news.example.org/article');await shot('url',page.locator('#impact-form'));
   const urlType=await url.getAttribute('type'),allCalls=api.length;
   if(!before){check(urlType,'search','uses same native clear control as stock search');const u=await url.boundingBox();await page.mouse.click(u.x+u.width-21,u.y+u.height/2);await frames(page);check(api.length,allCalls,'native clear creates no API request');check(urlType,await page.locator('#stock-search').getAttribute('type'),'native clear mechanism matches stock search');check(await url.inputValue(),'','native clear empties all URL text');check(await url.evaluate(e=>e===document.activeElement),true,'clear retains input focus');check(await page.locator('#impact-form').evaluate(e=>e.checkValidity()),false,'empty URL retains required validation');check(api.filter(p=>p==='/api/news-impact-phase1').length,calls,'clear does not call analysis API');check(provider.calls,providerCalls,'clear does not call provider');await shot('url-cleared',page.locator('#impact-form'));
    await url.fill('https://news.example.org/article');await submit.click();await page.waitForFunction(()=>document.querySelector('#impact-status').textContent==='วิเคราะห์เสร็จแล้ว');check(api.filter(p=>p==='/api/news-impact-phase1').length,calls+1,'explicit submit still sends exactly one request');check(provider.calls,providerCalls+1,'fixture provider called only after submit');
   }
   check(errors,[],'no runtime exception');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow');
   results.push({engine,width,theme,drawing,pagers:pagerResults,urlType,analysisRequests:api.filter(p=>p==='/api/news-impact-phase1').length,pageErrors:errors,status:before?'BASELINE RECORDED':'PASS'});console.log(JSON.stringify({engine,width,theme,status:results.at(-1).status,checks}));await context.close();
  }
  if(dir)fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify({phase:before?'before':'after',engine,checks,results,liveProviderRequests:0,physicalDevices:'NOT RUN'},null,2));console.log(JSON.stringify({uiCorrective:before?'BASELINE RECORDED':'PASS',engine,checks,contexts:results.length,liveProviderRequests:0}));
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(JSON.stringify({uiCorrective:'FAIL',phase,message:e.message,stack:e.stack}));process.exitCode=1;});
