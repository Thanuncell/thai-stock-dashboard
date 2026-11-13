'use strict';
// Native browser input over the existing OHLCV/auth fixtures; no live provider access.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage}=require('./account-isolation.browser.cjs');
const {createMarketService}=require('../server/market-service');
const {responder,received}=require('./fixtures/chart-candle-density.cjs');
const root=path.resolve(__dirname,'..'),evidence=process.env.SETSCOPE_INTERACTION_EVIDENCE;
const baseline=process.env.SETSCOPE_INTERACTION_BASELINE==='1';
let phase='setup',checks=0;
const check=(got,want,note)=>{assert.deepEqual(got,want,note);checks++;};
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const styles=page=>page.evaluate(()=>Object.fromEntries([
 '.chart-panel h2','.analysis-panel h2','#chart-reset','#chart-zoom-in','[data-draw-tool="trend"]',
 '.chart-source-note','.compact-reasons','.technical-reason-title','.indicator-toggle'
].map(selector=>{const node=document.querySelector(selector);if(!node)return[selector,null];const s=getComputedStyle(node);
 return[selector,Object.fromEntries(['fontFamily','fontSize','fontWeight','color','backgroundColor','borderColor'].map(key=>[key,s[key]]))];})));
(async()=>{
 const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname,relative=['/','/login','/register'].includes(name)?'index.html':name.slice(1),file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  try{const data=baseline?execFileSync('git',['show',`acc16d026cc8a3ddf1dcf27bb4b1d43eaf1d640d:${relative}`],{cwd:root,stdio:['ignore','pipe','ignore']}):fs.readFileSync(file);
   res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});res.end(data);
  }catch{res.writeHead(404).end();}
 });let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const width of(process.env.SETSCOPE_TECHNICAL_WIDTHS||'320,375,390,768,1024,1440').split(',').map(Number))for(const theme of['light','dark']){
   phase=`${width}-${theme}`;
   const context=await browser.newContext({viewport:{width,height:950},isMobile:width<790,hasTouch:true});
   const state={getOwners:[],putOwners:[]},requests=[],errors=[],providerCalls=[];
   const service=createMarketService({env:{},now:()=>received,fetchImpl:responder(providerCalls)});
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/market'){
     requests.push(url.search);
     const symbol=url.searchParams.get('symbol')||'PTT';const data=await service.getMarket([symbol],symbol,url.searchParams.get('range')||'1D');
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await seedPage(page,'token-a');
   const key='setscope-drawings:PTT:1D:user-a';
   const legacy=[{id:'legacy-line',type:'horizontal',a:{time:Date.UTC(2026,10,6,3),price:99},b:{time:Date.UTC(2026,10,6,3,1),price:99}}];
   await page.addInitScript(({theme,key,legacy})=>{localStorage.setItem('setscope-theme',theme);if(localStorage.getItem(key)===null)localStorage.setItem(key,JSON.stringify(legacy));},{theme,key,legacy});
   await page.goto(base+'/?symbol=PTT&range=1D#chart');await page.waitForSelector('.price-candle');
   const filename=`${width}-${theme}`,host=page.locator('#stock-price-chart'),tip=page.locator('.chart-crosshair-tooltip');
   const capture=async suffix=>{if(evidence){const dir=path.join(evidence,baseline?'before':'after');fs.mkdirSync(dir,{recursive:true});await page.locator('.chart-panel').screenshot({path:path.join(dir,filename+suffix+'.png'),style:'.sidebar,.side-nav,.topbar{opacity:0!important}'});}};
   if(baseline){if(evidence){fs.mkdirSync(path.join(evidence,'before'),{recursive:true});fs.writeFileSync(path.join(evidence,'before',filename+'.json'),JSON.stringify(await styles(page),null,2));}await capture('');await context.close();continue;}
   if(evidence)check(await styles(page),JSON.parse(fs.readFileSync(path.join(evidence,'before',filename+'.json'))),'existing typography, colors and headings match B1');
   const saved=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
   const canvas=async()=>{await host.scrollIntoViewIfNeeded();await page.evaluate(()=>{const top=document.querySelector('#stock-price-chart').getBoundingClientRect().top,header=document.querySelector('.topbar').getBoundingClientRect().bottom;if(top<header+8)scrollBy(0,top-header-8);});await frames(page);};
   const inspect=async touch=>{
    await canvas();const candle=page.locator('.price-candle').last(),body=await candle.locator('rect').first().boundingBox();
    const x=body.x+body.width/2,y=body.y+body.height/2;
    if(touch)await page.touchscreen.tap(x,y);else await page.mouse.move(x,y);
    await tip.waitFor({state:'visible'});
    const title=await candle.locator('title').textContent(),values=title.slice(title.indexOf(' · O '));
    check((await tip.textContent()).endsWith(values),true,'tooltip OHLCV belongs to the actual nearest loaded candle');
    check(await page.locator('.chart-crosshair').getAttribute('visibility'),'visible');
    check(await page.locator('.chart-crosshair line').count(),2);
    check(await host.getAttribute('aria-describedby'),await tip.getAttribute('id'),'keyboard inspection has an accessible tooltip reference');
    const bounds=await tip.boundingBox(),hostBounds=await host.boundingBox();
    check(bounds.x>=hostBounds.x&&bounds.x+bounds.width<=hostBounds.x+hostBounds.width+1,true,'tooltip stays within mobile/desktop width');
   };
   check(await saved(),legacy,'legacy drawing is loaded intact');
   check(await page.locator('[data-draw-undo]').isDisabled(),true,'pre-session legacy drawings are not undo history');
   const calls=requests.length,storage=JSON.stringify(await saved()),snapshot=await host.getAttribute('data-snapshot-id');
   await inspect(false);await page.mouse.move(1,1);check(await tip.isHidden(),true,'leaving the chart clears hover');
   await inspect(true);await host.focus();await page.keyboard.press('ArrowLeft');
   const latest=await tip.getAttribute('data-time');await page.keyboard.press('ArrowLeft');
   check(Number(await tip.getAttribute('data-time'))<Number(latest),true,'keyboard inspection follows real candles');
   await page.keyboard.press('Escape');check(await tip.isHidden(),true);
   check(await host.getAttribute('data-snapshot-id'),snapshot,'inspection does not alter signal evidence');
   check(JSON.stringify(await saved()),storage,'inspection never writes drawing state');
   const initial=await page.locator('.price-candle').count(),source=Number(await host.getAttribute('data-source-candles'));
   check(source>200,true,'fixture exercises more than 200 real loaded bars');
   await page.locator('#chart-fit').click();await page.waitForFunction(()=>document.querySelectorAll('.price-candle').length===Number(document.querySelector('#stock-price-chart').dataset.sourceCandles));
   check(await page.locator('.price-candle').count(),source,'Fit includes every loaded candle');
   await page.locator('#chart-zoom-in').click();await frames(page);check(await page.locator('.price-candle').count()<source,true);
   await page.locator('#chart-reset').click();await frames(page);check(await page.locator('.price-candle').count(),initial,'Reset preserves the existing recent-candle view');
   check(requests.length,calls,'Fit/zoom/reset/inspection make zero market requests');
   const draw=async()=>{await page.locator('[data-draw-tool="trend"]').click();await canvas();const b=await page.locator('.drawing-surface').boundingBox();await page.mouse.move(b.x+b.width*.3,b.y+b.height*.35);await page.mouse.down();await page.mouse.move(b.x+b.width*.7,b.y+b.height*.6,{steps:4});await page.mouse.up();await frames(page);};
   await draw();const drawn=await saved();check(drawn.length,2);check(drawn[0],legacy[0]);
   await page.locator('[data-draw-undo]').click();await frames(page);check(await saved(),legacy,'undo removes only the session addition');
   await page.locator('[data-draw-redo]').click();await frames(page);check(await saved(),drawn,'redo restores exact time/price anchors');
   await page.locator('[data-draw-list] button').first().click();await page.locator('[name=aPrice]').fill('99.25');await page.locator('#drawing-workspace form button').click();await frames(page);
   check((await saved())[0].a.price,99.25);await page.locator('[data-draw-undo]').click();await frames(page);check(await saved(),drawn,'numeric edit is reversible');
   await host.focus();await page.keyboard.press('Control+Shift+Z');await frames(page);check((await saved())[0].a.price,99.25,'keyboard redo is scoped to the drawing workspace');
   await page.keyboard.press('Control+Z');await frames(page);check(await saved(),drawn);
   await page.locator('[data-draw-reset]').click();await frames(page);check(await saved(),[]);
   await page.locator('[data-draw-undo]').click();await frames(page);check(await saved(),drawn,'undo clear restores session and legacy drawings');
   const beforeSwitch=await saved();await page.locator('[data-range="1W"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1W'));
   check(await page.locator('[data-draw-list] button').count(),0);check(await page.locator('[data-draw-undo]').isDisabled(),true,'another timeframe cannot undo these drawings');
   await page.locator('[data-range="1D"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1D'));check(await saved(),beforeSwitch);
   check(await page.locator('[data-draw-undo]').isDisabled(),false,'returning to the context retains session undo');
   await page.reload();await page.waitForSelector('.price-candle');check(await saved(),drawn,'existing persistence survives reload');
   check(await page.locator('[data-draw-undo]').isDisabled(),true,'undo history is not persisted');check(await page.locator('[data-draw-redo]').isDisabled(),true);
   for(const timeframe of['D','W','M']){
    await page.locator(`[data-timeframe="${timeframe}"]`).click();await page.waitForFunction(tf=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(tf+' · 1Y'),timeframe);
    check(await tip.isHidden(),true,'old inspection is cleared on timeframe change');await inspect(false);
    check((await tip.textContent()).startsWith('PTT · '+timeframe+' · '),true,'tooltip timeframe follows selected candles');
   }
   if(evidence){await canvas();await inspect(false);await host.screenshot({path:path.join(evidence,'after',filename+'-crosshair.png'),style:'.sidebar,.side-nav,.topbar{opacity:0!important}'});}
   await capture('-monthly');
   check(await page.evaluate(()=>Object.keys(localStorage).some(key=>/crosshair|undo|redo/.test(key))),false,'new interaction state never adds persistent storage');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   check(errors,[]);console.log(JSON.stringify({width,theme,status:'PASS',checks}));await context.close();
  }
  console.log(JSON.stringify({chartInteractionBrowser:'PASS',baseline,checks,liveProviderRequests:0,physicalDevices:'NOT RUN'}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(JSON.stringify({chartInteractionBrowser:'FAIL',phase,checks,message:error.message,stack:error.stack}));process.exitCode=1;});
