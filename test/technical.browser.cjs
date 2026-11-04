'use strict';
// Offline browser acceptance: all prices/accounts are synthetic; external traffic is blocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage}=require('./account-isolation.browser.cjs');
let checks=0,phase='setup';
const check=(got,want,note)=>{assert.deepEqual(got,want,note);checks++;};
const pause=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
(async()=>{
 const root=path.resolve(__dirname,'..'),server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,['/','/login','/register'].includes(pathname)?'index.html':pathname.slice(1));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});res.end(data);});
 });let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const width of (process.env.SETSCOPE_TECHNICAL_WIDTHS||'320,360,390,430,1366').split(',').map(Number))for(const theme of ['light','dark']){
   phase=`${width}-${theme}-setup`;
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<790,hasTouch:width<790});
   const state={getOwners:[],putOwners:[]},errors=[],marketCalls=[];let short=false,pending=null;
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/search'){const q=url.searchParams.get('q');return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:['PTT','CPALL'].includes(q)?[{symbol:q,name:'Fixture '+q,type:'EQUITY',exchange:'SET'}]:[]})});}
    if(url.origin===base&&url.pathname==='/api/market'){
     const range=url.searchParams.get('range')||'1D',symbol=url.searchParams.get('symbol')||'PTT';marketCalls.push({range,symbol});
     if(pending&&pending.range===range){const held=pending;pending=null;held.started();await held.wait;}
     const interval=range==='1D'?'1m':range==='1W'?'15m':'1d',step=interval==='1m'?60000:interval==='15m'?900000:86400000;
     const start=Date.UTC(2025,0,1,3,0,17,123),rows=Array.from({length:short?12:260},(_,i)=>({time:start+i*step,open:100+Math.sin(i*.31)*4+i*.03,close:100.4+Math.sin(i*.31)*4+i*.03,high:103+Math.sin(i*.31)*4+i*.03,low:98+Math.sin(i*.31)*4+i*.03,volume:i===40?0:1000+i%11*100}));
     const end=rows.at(-1).time+(interval==='1d'?24000000:step),meta={interval,receivedAt:new Date(end).toISOString(),regularEnd:interval==='1d'?end:null,priceBasis:'provider-quote-ohlc',adjustment:'fixture-unadjusted'};
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({stocks:[{symbol,last:rows.at(-1).close,prior:rows.at(-2).close,time:end,history:rows,guardStatus:'accepted',dataState:'delayed'}],indices:[],history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:meta.receivedAt,technicalMeta:{history:meta,indicator:meta,levels:meta},dataState:'delayed',errors:[]})});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await seedPage(page,'token-a');
   await page.addInitScript(theme=>localStorage.setItem('setscope-theme',theme),theme);
   await page.goto(base+'/?symbol=PTT&range=1D#chart');await page.waitForSelector('.price-candle');
   const parity=async()=>{await page.waitForFunction(()=>{const a=document.querySelector('#stock-price-chart').dataset.snapshotId,b=document.querySelector('.analysis-panel').dataset.snapshotId;return a&&a===b;});check(await page.locator('.compact-reasons li').count(),3);};
   await parity();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal page overflow');
   const id=await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),count=marketCalls.length;
   phase=`${width}-${theme}-indicators`;await page.locator('.indicator-workspace summary').click();
   for(const key of ['rsi','atr','bb'])await page.locator(`[data-indicator="${key}"]`).click();
   await page.waitForSelector('.rsi-panel');await page.waitForSelector('.atr-panel');check(await page.locator('.bb-chart-line').count(),3);
   const panelBounds=await page.locator('.atr-panel').boundingBox(),wrapBounds=await page.locator('.own-chart-wrap').boundingBox();check(panelBounds.y+panelBounds.height<=wrapBounds.y+wrapBounds.height+1,true,'optional panels remain inside the responsive canvas');
   check(await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),id,'display toggles cannot change analysis');check(marketCalls.length,count,'local controls make no provider requests');await parity();
   const rsiPath=await page.locator('.rsi-chart-line').getAttribute('d');check(Boolean(rsiPath)&&!rsiPath.includes('NaN'),true);
   await page.locator('#indicator-settings input[name=rsi]').fill('7');await page.locator('#indicator-settings button[type=submit]').click();await parity();
   check((await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'))!==id,true,'parameters genuinely recompute snapshot');
   check(await page.locator('[data-indicator=rsi] span').textContent(),'RSI 7');
   await page.locator('#indicator-settings input[name=macdFast]').fill('30');await page.locator('#indicator-settings button[type=submit]').click();check(await page.locator('#indicator-settings-error').textContent(),'MACD Fast ต้องน้อยกว่า Slow');
   await page.locator('#indicator-defaults').click();check(await page.locator('#indicator-settings input[name=rsi]').inputValue(),'14');
   for(const preset of ['trend','momentum','volatility','basic']){await page.selectOption('#indicator-preset',preset);await pause(page);await parity();}
   check(marketCalls.length,count,'presets and settings are local');
   phase=`${width}-${theme}-drawings`;
   const draw=async(type,touch=false)=>{
    await page.locator(`[data-draw-tool=${type}]`).click();await page.locator('#stock-price-chart').scrollIntoViewIfNeeded();
    const box=await page.locator('.price-chart-svg').boundingBox(),from={x:box.x+box.width*.35,y:box.y+70},to={x:box.x+box.width*.65,y:box.y+140};
    if(touch){const cdp=await context.newCDPSession(page);for(const [type,p]of [['touchStart',from],['touchMove',to],['touchEnd',null]])await cdp.send('Input.dispatchTouchEvent',{type,touchPoints:p?[{x:p.x,y:p.y}]:[]});await cdp.detach();}
    else{await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:4});await page.mouse.up();}
    await pause(page);
   };
   for(const type of ['trend','horizontal','measure'])await draw(type,width<790);
   check(await page.locator('[data-draw-list] button').count(),3);check(await page.locator('.drawing-label').count(),1);
   check((await page.locator('.drawing-label').textContent()).includes('%'),true);
   await page.locator('[data-draw-list] button').first().click();
   const key='setscope-drawings:PTT:1D:user-a',before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
   const aPrice=before[0].a.price+.1,bPrice=before[0].b.price+.2;
   await page.locator('[name=aPrice]').fill(String(aPrice));await page.locator('[name=bPrice]').fill(String(bPrice));await page.locator('#drawing-workspace form button').click();await pause(page);
   const edited=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);check(edited[0].a.price,aPrice);check(edited[0].b.price,bPrice);check(edited[0].a.time,before[0].a.time,'numeric editing preserves time');
   // Endpoint dragging and moving the entire shape use actual pointer capture on the stable host.
   await page.locator('#stock-price-chart').scrollIntoViewIfNeeded();
   const handle=await page.locator('.drawing-handle').first().boundingBox();
   await page.mouse.move(handle.x+7,handle.y+7);await page.mouse.down();await page.mouse.move(handle.x+17,handle.y+17,{steps:3});await page.mouse.up();await pause(page);
   check((await page.evaluate(key=>JSON.parse(localStorage.getItem(key))[0].a.price,key))!==aPrice,true,'endpoint drag changes the saved price');
   const movingBefore=await page.evaluate(key=>JSON.parse(localStorage.getItem(key))[0],key),line=await page.locator('.drawing.selected .drawing-hit').boundingBox();
   await page.mouse.move(line.x+line.width*.5,line.y+line.height*.5);await page.mouse.down();await page.mouse.move(line.x+line.width*.5+8,line.y+line.height*.5+8,{steps:3});await page.mouse.up();await pause(page);
   const movingAfter=await page.evaluate(key=>JSON.parse(localStorage.getItem(key))[0],key);check(movingAfter.a.price!==movingBefore.a.price,true,'move entire drawing');check(Math.abs((movingAfter.a.price-movingBefore.a.price)-(movingAfter.b.price-movingBefore.b.price))<1e-10,true,'move preserves the slope');
   const anchored=await page.evaluate(key=>localStorage.getItem(key),key);await page.locator('[data-draw-tool=pan]').click();await page.locator('#chart-zoom-in').click();await pause(page);check(await page.evaluate(key=>localStorage.getItem(key),key),anchored,'zoom cannot change time/price anchors');
   await page.locator('#chart-reset').click();await pause(page);check(await page.locator('[data-draw-list] button').count(),3);
   await page.locator('#stock-price-chart').scrollIntoViewIfNeeded();const panBox=await page.locator('.price-chart-svg').boundingBox(),firstTitle=await page.locator('.price-candle title').first().textContent(),callsBeforePan=marketCalls.length;
   await page.mouse.move(panBox.x+panBox.width*.5,panBox.y+110);await page.mouse.down();await page.mouse.move(panBox.x+panBox.width*.8,panBox.y+110,{steps:4});await page.mouse.up();await pause(page);
   check((await page.locator('.price-candle title').first().textContent())!==firstTitle,true,'pan still changes cached viewport');check(marketCalls.length,callsBeforePan,'pan makes no API call');
   if(width<790){const cdp=await context.newCDPSession(page),cy=panBox.y+130,cx=panBox.x+panBox.width*.5,beforePinch=await page.locator('.price-candle').count();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:cx-35,y:cy},{x:cx+35,y:cy}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:cx-65,y:cy},{x:cx+65,y:cy}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await pause(page);check(await page.locator('.price-candle').count()<beforePinch,true,'two-finger pinch still zooms cached bars');await cdp.detach();}
   await page.reload();await page.waitForSelector('.price-candle');check(await page.locator('[data-draw-list] button').count(),3,'same account reload restores drawings');await parity();
   await page.locator('[data-draw-list] button').first().click();await page.locator('#stock-price-chart').focus();await page.keyboard.press('Delete');await pause(page);check(await page.locator('[data-draw-list] button').count(),2,'keyboard delete');
   await page.locator('[data-draw-reset]').click();await pause(page);check(await page.locator('[data-draw-list] button').count(),0);
   phase=`${width}-${theme}-range-short`;
   for(const range of ['1W','1M','3M','1Y','1D']){await page.locator(`[data-range="${range}"]`).click();await page.waitForFunction(range=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(range),range);await parity();check((await page.locator('#analysis-note').textContent()).includes('ยืนยันแล้ว'),true);}
   phase=`${width}-${theme}-race`;
   let release,started;const began=new Promise(resolve=>{started=resolve;});pending={range:'1W',started,wait:new Promise(resolve=>{release=resolve;})};
   await page.locator('[data-range="1W"]').click();await began;await page.locator('[data-range="1M"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1M'));
   const completed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market'&&new URL(r.url()).searchParams.get('range')==='1W');release();await completed;await pause(page);
   check((await page.locator('.price-chart-svg').getAttribute('aria-label')).endsWith('1M'),true,'late timeframe response cannot replace newer data');await parity();
   for(const symbol of ['CPALL','PTT']){await page.locator('#stock-search').fill(symbol);await page.locator(`.suggestion-item[data-symbol=${symbol}]`).waitFor();await page.locator(`.suggestion-item[data-symbol=${symbol}]`).click();await page.waitForFunction(symbol=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').includes(symbol),symbol);await parity();}
   await page.locator('[data-range="1D"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1D'));await parity();
   short=true;await page.locator('#refresh-chart').click();await page.waitForFunction(()=>document.querySelector('#overall-signal').textContent==='รอข้อมูล');
   check(await page.locator('.price-candle').count(),12,'insufficient history keeps real candles visible');check(await page.locator('#rsi-value').textContent(),'—');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);check(errors,[],'no browser errors');
   if(process.env.SETSCOPE_TECHNICAL_SCREENSHOT_DIR){short=false;await page.locator('#refresh-chart').click();await page.waitForSelector('.compact-reasons');await page.locator('.indicator-workspace summary').click();await page.selectOption('#indicator-preset','momentum');await page.locator('.rsi-panel').waitFor();await page.locator('#chart-section').screenshot({path:path.join(process.env.SETSCOPE_TECHNICAL_SCREENSHOT_DIR,`technical-${width}-${theme}.png`)});}
   phase=`${width}-${theme}-account-switch`;
   short=false;await page.locator('#refresh-chart').click();await page.waitForSelector('.compact-reasons');
   await draw('trend',width<790);check(await page.locator('[data-draw-list] button').count(),1);
   if(!await page.locator('#indicator-settings').isVisible())await page.locator('.indicator-workspace summary').click();
   await page.locator('#indicator-settings input[name=rsi]').fill('7');await page.locator('#indicator-settings button[type=submit]').click();
   // Logout shows the form before its asynchronous reload; wait for the new document.
   await page.locator('#user-avatar').click();await Promise.all([page.waitForEvent('load'),page.locator('#profile-logout-button').click()]);await page.waitForSelector('#login-form');
   await page.locator('#login-form input[name=email]').fill('b@example.test');await page.locator('#login-form input[name=password]').fill('synthetic-chart-fixture');await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('body.authenticated');
   await page.locator('[data-workspace-route=chart]:visible').first().click();await page.waitForSelector('.price-candle');await parity();
   check(await page.locator('[data-draw-list] button').count(),0,'account B never sees account A drawings');check(await page.locator('#indicator-settings input[name=rsi]').inputValue(),'14','account B never inherits account A parameters');
   check(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('setscope-drawings:')&&!/user-[ab]$/.test(key))),false,'no unscoped drawing storage');check(errors,[]);
   console.log(JSON.stringify({width,theme,result:'PASS',checks}));await context.close();
  }
  console.log(JSON.stringify({technicalBrowser:'PASS',checks,liveProviderRequests:0}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(JSON.stringify({technicalBrowser:'FAIL',phase,name:error.name,message:error.message}));process.exitCode=1;});
