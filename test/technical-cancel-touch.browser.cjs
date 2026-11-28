'use strict';
// No live providers: native Chromium input over a loopback fixture server.
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage}=require('./account-isolation.browser.cjs');
let phase='setup',checks=0;const results=[];
const check=(got,want,note)=>{checks++;assert.deepEqual(got,want,note);};
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
(async()=>{
 const root=path.resolve(__dirname,'..'),server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname,file=path.resolve(root,['/','/login','/register'].includes(name)?'index.html':name.slice(1));if(!file.startsWith(root+path.sep))return res.writeHead(403).end();fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});res.end(data);});});
 let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const width of (process.env.SETSCOPE_TECHNICAL_WIDTHS||'320,360,390,430,1366').split(',').map(Number))for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:900},isMobile:width<790,hasTouch:true}),state={getOwners:[],putOwners:[]},api=[],errors=[];
   await context.route('**/*',route=>{
    const url=new URL(route.request().url());if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname.startsWith('/api/'))api.push(url.pathname);
    if(url.pathname==='/api/search')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{symbol:'CPALL',name:'Fixture',type:'EQUITY',exchange:'SET'}]})});
    if(url.origin===base&&url.pathname==='/api/market'){
     const range=url.searchParams.get('range')||'1D',symbol=url.searchParams.get('symbol')||'PTT',interval=range==='1D'?'1m':range==='1W'?'15m':range==='1M'?'30m':range==='3M'?'60m':'1d',step=interval==='1m'?60000:interval==='15m'?900000:interval==='30m'?1800000:interval==='60m'?3600000:86400000;
     const rows=Array.from({length:260},(_,i)=>({time:Date.UTC(2026,9,20,3)+i*step,open:100+Math.sin(i*.3)*4,close:100.4+Math.sin(i*.3)*4,high:103+Math.sin(i*.3)*4,low:98+Math.sin(i*.3)*4,volume:1000+i}));
     const end=rows.at(-1).time+(interval==='1d'?24000000:step),meta={interval,receivedAt:new Date(end).toISOString(),regularEnd:interval==='1d'?end:null};
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({stocks:[{symbol,last:rows.at(-1).close,prior:rows.at(-2).close,time:end,history:rows,guardStatus:'accepted',dataState:'delayed'}],history:rows,indicatorHistory:rows,levelsHistory:rows,technicalMeta:{history:meta,indicator:meta,levels:meta},fetchedAt:meta.receivedAt,dataState:'delayed',indices:[],errors:[]})});
    }return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await seedPage(page,'token-a');
   await page.addInitScript(theme=>{localStorage.setItem('setscope-theme',theme);window.__gestureAudit={captured:[],active:[],ended:[],pointer:null};const ended=e=>{window.__gestureAudit.active=window.__gestureAudit.active.filter(id=>id!==e.pointerId);window.__gestureAudit.ended.push({id:e.pointerId,type:e.type,connected:e.target.isConnected,target:e.target.tagName});};document.addEventListener('gotpointercapture',e=>{window.__gestureAudit.captured.push(e.pointerId);});document.addEventListener('lostpointercapture',e=>{window.__gestureAudit.captured=window.__gestureAudit.captured.filter(id=>id!==e.pointerId);});document.addEventListener('pointerdown',e=>{window.__gestureAudit.active.push(e.pointerId);if(e.target.closest('#stock-price-chart'))window.__gestureAudit.pointer=e.pointerId;
    // Reset can detach the original SVG target; its terminal event may not bubble.
    const target=e.target,terminal=event=>{ended(event);for(const type of ['pointerup','pointercancel'])target.removeEventListener(type,terminal);};for(const type of ['pointerup','pointercancel'])target.addEventListener(type,terminal);},true);for(const type of ['pointerup','pointercancel'])document.addEventListener(type,ended,true);},theme);
   await page.goto(base+'/?symbol=PTT&range=1D#chart');await page.waitForSelector('.price-candle');
   const cdp=await context.newCDPSession(page),key='setscope-drawings:PTT:1D:user-a';
   const saved=()=>page.evaluate(key=>localStorage.getItem(key),key);
   const items=()=>page.locator('.drawing-layer .drawing').count();
   const captureClear=async()=>{await frames(page);check(await page.evaluate(()=>window.__gestureAudit.captured.length),0,'no captured pointer remains');const active=await page.evaluate(()=>window.__gestureAudit.active.length);if(active)console.error(JSON.stringify({phase,audit:await page.evaluate(()=>window.__gestureAudit)}));check(active,0,'native pointers have all ended');};
   const parity=async()=>{check(await page.locator('#stock-price-chart').getAttribute('data-snapshot-id'),await page.locator('.analysis-panel').getAttribute('data-snapshot-id'),'chart/signal/explanation snapshot parity');};
   const mode=async name=>{await page.locator(`[data-draw-tool=${name}]`).evaluate(el=>el.click());await frames(page);};
   const canvas=async()=>{
    await page.locator('#stock-price-chart').scrollIntoViewIfNeeded();
    // Native scrollIntoView does not account for the existing sticky header.
    // Keep the real input target visible rather than sending touch to that header.
    await page.evaluate(()=>{
     const top=document.querySelector('#stock-price-chart').getBoundingClientRect().top;
     const headerBottom=document.querySelector('.topbar').getBoundingClientRect().bottom;
     if(top<headerBottom+8)window.scrollBy(0,top-headerBottom-8);
    });
    await frames(page);return page.locator('.price-chart-svg').boundingBox();
   };
   const swipe=async(from,to)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});for(let i=1;i<=10;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/10,y:from.y+(to.y-from.y)*i/10}]});await frames(page);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await frames(page);};
   const mouseStart=async()=>{const b=await canvas();const a={x:b.x+b.width*.35,y:b.y+80},z={x:b.x+b.width*.65,y:b.y+150};await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(z.x,z.y,{steps:3});await frames(page);return {a,z};};
   const commit=async()=>{await mode('trend');await mouseStart();await page.mouse.up();await frames(page);await mode('select');await page.locator('[data-draw-list] button').first().evaluate(el=>el.click());await frames(page);};
   const clear=async()=>{await mode('pan');await page.mouse.up();await page.locator('[data-draw-reset]').evaluate(el=>el.click());await frames(page);};
   const apiBefore=api.length;
   phase=`${width}-${theme}-vertical-off`;await mode('pan');let b=await canvas(),scroll=await page.evaluate(()=>scrollY);
   await swipe({x:b.x+b.width*.5,y:b.y+220},{x:b.x+b.width*.5,y:b.y+65});check(await page.evaluate(before=>scrollY>before+20,scroll),true,'vertical swipe scrolls page in drawing OFF');await captureClear();
   phase=`${width}-${theme}-pan-off`;b=await canvas();let first=await page.locator('.price-candle title').first().textContent();await swipe({x:b.x+b.width*.7,y:b.y+120},{x:b.x+b.width*.35,y:b.y+120});
   // Pan away from the latest boundary, so the expected direction has room to move.
   if((await page.locator('.price-candle title').first().textContent())===first){b=await canvas();await swipe({x:b.x+b.width*.35,y:b.y+120},{x:b.x+b.width*.7,y:b.y+120});}
   check((await page.locator('.price-candle title').first().textContent())!==first,true,'native touch horizontal pan changes cached candles');await captureClear();
   phase=`${width}-${theme}-pinch-off`;const pinch=async()=>{const p=await canvas(),x=p.x+p.width*.55,y=p.y+130,n=await page.locator('.price-candle').count();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-30,y},{x:x+30,y}]});for(let gap=35;gap<=65;gap+=10){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-gap,y},{x:x+gap,y}]});await frames(page);}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await frames(page);check(await page.locator('.price-candle').count()<n,true,'native two-pointer pinch zooms');await captureClear();};await pinch();
   await page.locator('#chart-reset').evaluate(el=>el.click());await frames(page);
   // A redraw must not orphan the implicit capture on a replaced SVG node.
   // Native release outside the host must finish the pan before the next finger.
   const resetView=async()=>{await page.locator('#chart-reset').evaluate(el=>el.click());await frames(page);};
   const span=()=>page.locator('.price-candle').count();
   const send=(type,touchPoints)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints});
   const horizontalStart=async()=>{const p=await canvas(),a={x:p.x+p.width*.37,y:p.y+120,id:1};await send('touchStart',[a]);await send('touchMove',[{...a,x:a.x+16}]);await frames(page);await send('touchMove',[{...a,x:a.x+32}]);await frames(page);check(await page.locator('#stock-price-chart').evaluate(el=>el.hasPointerCapture(window.__gestureAudit.pointer)),true,'confirmed touch pan captures on stable host before SVG redraw');return {...a,x:a.x+32};};
   for(const edge of ['right','left','top','bottom']){
    phase=`${width}-${theme}-outside-${edge}`;await resetView();await pinch();const n=await span(),a=await horizontalStart(),h=await page.locator('#stock-price-chart').boundingBox();
    const z={x:edge==='left'?h.x-8:edge==='right'?h.x+h.width+8:a.x,y:edge==='top'?h.y-8:edge==='bottom'?h.y+h.height+8:a.y,id:1};
    check(z.x<0||z.x>width||z.y<0||z.y>900,false,'outside-host release remains inside browser viewport');
    for(let i=1;i<=6;i++){await send('touchMove',[{x:a.x+(z.x-a.x)*i/6,y:a.y+(z.y-a.y)*i/6,id:1}]);await frames(page);}await send('touchEnd',[]);await captureClear();
    check(await span(),n,'releasing outside '+edge+' cannot change pan span');
    b=await canvas();await swipe({x:b.x+b.width*.37,y:b.y+120},{x:b.x+b.width*.67,y:b.y+120});check(await span(),n,'next single finger pans rather than pinches after '+edge);await captureClear();
    await resetView();const initial=await span();b=await canvas();await swipe({x:b.x+b.width*.37,y:b.y+120},{x:b.x+b.width*.67,y:b.y+120});check(await span(),initial,'Reset then pan retains default span after '+edge);await captureClear();check(errors,[],'no inactive-pointer capture errors');
   }
   // Release real browser capture while native touch remains down. Losing capture
   // must cancel that pointer, not wait for an outside pointerup the host cannot see.
   const loseCapture=async(points)=>{
    const id=await page.evaluate(()=>window.__gestureAudit.pointer);
    await page.locator('#stock-price-chart').evaluate((host,id)=>{
     window.__activeLoss=null;
     host.addEventListener('lostpointercapture',function observe(event){
      if(event.target!==host||event.pointerId!==id)return;
      window.__activeLoss={id,active:window.__gestureAudit.active.includes(id)};
      host.removeEventListener('lostpointercapture',observe);
     });
     host.releasePointerCapture(id);
    },id);
    await send('touchMove',points);await frames(page);
    check(await page.evaluate(()=>window.__activeLoss?.active),true,'capture loss occurs while native pointer is still active');
    check(await page.locator('#stock-price-chart').evaluate((host,id)=>host.hasPointerCapture(id),id),false,'lost pointer is no longer captured');
    return id;
   };
   for(const edge of ['right','left','top','bottom']){
    phase=`${width}-${theme}-active-capture-loss-${edge}`;await resetView();await pinch();const n=await span(),a=await horizontalStart();
    await loseCapture([{...a,x:a.x+5}]);const h=await page.locator('#stock-price-chart').boundingBox();
    await send('touchMove',[{x:edge==='left'?h.x-8:edge==='right'?h.x+h.width+8:a.x,y:edge==='top'?h.y-8:edge==='bottom'?h.y+h.height+8:a.y,id:1}]);await frames(page);await send('touchEnd',[]);await captureClear();
    b=await canvas();await swipe({x:b.x+b.width*.37,y:b.y+120},{x:b.x+b.width*.67,y:b.y+120});check(await span(),n,'single finger after active capture loss and outside '+edge+' remains a pan');await captureClear();check(errors,[],'active capture loss leaves no inactive-pointer capture errors');
   }
   phase=`${width}-${theme}-pinch-capture-loss`;await resetView();b=await canvas();const lx=b.x+b.width*.55,ly=b.y+130;
   await send('touchStart',[{x:lx-30,y:ly,id:1},{x:lx+30,y:ly,id:2}]);await send('touchMove',[{x:lx-60,y:ly,id:1},{x:lx+60,y:ly,id:2}]);await frames(page);const lossPinchSpan=await span();
   await loseCapture([{x:lx-59,y:ly,id:1},{x:lx+61,y:ly,id:2}]);check(await page.evaluate(()=>window.__gestureAudit.active.length),2,'capture loss does not fake a native finger lift');
   await send('touchEnd',[{x:lx+60,y:ly,id:2}]);await send('touchMove',[{x:lx-40,y:ly,id:1}]);await frames(page);await send('touchMove',[{x:lx-20,y:ly,id:1}]);await frames(page);await send('touchEnd',[]);await captureClear();check(await span(),lossPinchSpan,'remaining captured pinch finger rebases to pan after peer capture loss');
   phase=`${width}-${theme}-capture-loss-drawing`;await clear();await mode('trend');b=await canvas();const lossDraft={x:b.x+b.width*.4,y:b.y+80,id:1},lossSaved=await saved();
   await send('touchStart',[lossDraft]);await send('touchMove',[{...lossDraft,x:lossDraft.x+30,y:lossDraft.y+30}]);await frames(page);await loseCapture([{...lossDraft,x:lossDraft.x+35,y:lossDraft.y+35}]);
   check(await items(),0,'capture loss cancels uncommitted drawing');check(await saved(),lossSaved,'capture loss does not persist a draft');await send('touchEnd',[]);await captureClear();await clear();
   phase=`${width}-${theme}-reset-during-pan`;await resetView();const initialSpan=await span();await pinch();let held=await horizontalStart();await resetView();check(await span(),initialSpan,'Reset restores default span while touch is active');
   await send('touchMove',[{...held,x:held.x+20}]);await send('touchEnd',[]);await frames(page);check(await span(),initialSpan,'old pan baseline cannot return after Reset');await captureClear();
   phase=`${width}-${theme}-pinch-to-one`;await resetView();b=await canvas();const cx=b.x+b.width*.55,cy=b.y+130;
   await send('touchStart',[{x:cx-30,y:cy,id:1},{x:cx+30,y:cy,id:2}]);await send('touchMove',[{x:cx-60,y:cy,id:1},{x:cx+60,y:cy,id:2}]);await frames(page);const pinchSpan=await span();
   await send('touchEnd',[{x:cx+60,y:cy,id:2}]);await frames(page);check(await page.evaluate(()=>window.__gestureAudit.active.length),1,'one native pointer remains after staggered lift');
   await send('touchMove',[{x:cx-40,y:cy,id:1}]);await frames(page);await send('touchMove',[{x:cx-20,y:cy,id:1}]);await frames(page);await send('touchEnd',[]);await captureClear();check(await span(),pinchSpan,'remaining finger transitions to pan without changing zoom');
   phase=`${width}-${theme}-cancel-pan`;await resetView();held=await horizontalStart();await send('touchCancel',[]);await captureClear();const cancelSpan=await span();b=await canvas();await swipe({x:b.x+b.width*.37,y:b.y+120},{x:b.x+b.width*.67,y:b.y+120});check(await span(),cancelSpan,'cancelled native pan leaves no stale pointer');await captureClear();
   phase=`${width}-${theme}-reset-drawing`;await clear();await mode('trend');b=await canvas();let draft={x:b.x+b.width*.4,y:b.y+80,id:1};await send('touchStart',[draft]);await send('touchMove',[{...draft,x:draft.x+30,y:draft.y+30}]);await frames(page);await resetView();const outside=await page.locator('#stock-price-chart').boundingBox();await send('touchMove',[{...draft,x:outside.x+outside.width+8}]);await send('touchEnd',[]);await captureClear();check(await items(),JSON.parse(await saved()||'[]').length,'Reset followed by outside release leaves no uncommitted drawing');await clear();
   await resetView();
   phase=`${width}-${theme}-escape-new`;await clear();await mode('trend');let original=await saved();await mouseStart();check(await saved(),original,'draft not persisted while pointer is down');await page.keyboard.press('Escape');await page.mouse.up();await frames(page);check(await items(),0,'Escape removes an uncommitted drawing');check(await saved(),original,'Escape does not persist draft');await captureClear();
   phase=`${width}-${theme}-escape-move`;await commit();original=await saved();let beforeHandles=await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')]));
   await canvas();let line=await page.locator('.drawing.selected .drawing-hit').boundingBox();await page.mouse.move(line.x+line.width*.5,line.y+line.height*.5);await page.mouse.down();await page.mouse.move(line.x+line.width*.5+15,line.y+line.height*.5+12,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();await frames(page);check(await saved(),original,'cancel whole move retains both committed anchors');check(await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),beforeHandles,'visual state agrees with committed storage after Escape');await captureClear();
   phase=`${width}-${theme}-reset-anchor`;await mode('select');await canvas();let resetHandle=await page.locator('.drawing-handle').first().boundingBox();await send('touchStart',[{x:resetHandle.x+7,y:resetHandle.y+7,id:1}]);await send('touchMove',[{x:resetHandle.x+18,y:resetHandle.y+18,id:1}]);await frames(page);await resetView();const anchorOutside=await page.locator('#stock-price-chart').boundingBox();await send('touchMove',[{x:anchorOutside.x+anchorOutside.width+8,y:anchorOutside.y+100,id:1}]);await send('touchEnd',[]);await captureClear();check(await saved(),original,'Reset during anchor edit preserves committed drawing');check(await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),beforeHandles,'Reset restores committed anchors without a ghost edit');
   phase=`${width}-${theme}-capture-loss-anchor`;await mode('select');await canvas();let lossHandle=await page.locator('.drawing-handle').first().boundingBox();
   await send('touchStart',[{x:lossHandle.x+7,y:lossHandle.y+7,id:1}]);await send('touchMove',[{x:lossHandle.x+18,y:lossHandle.y+18,id:1}]);await frames(page);await loseCapture([{x:lossHandle.x+20,y:lossHandle.y+20,id:1}]);await send('touchEnd',[]);await captureClear();
   check(await saved(),original,'capture loss during anchor edit retains committed storage');check(await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),beforeHandles,'capture loss restores committed anchor positions');
   phase=`${width}-${theme}-cancel-anchor`;await mode('select');await canvas();let handle=await page.locator('.drawing-handle').first().boundingBox();await page.mouse.move(handle.x+7,handle.y+7);await page.mouse.down();await page.mouse.move(handle.x+18,handle.y+18,{steps:3});const pointer=await page.evaluate(()=>window.__gestureAudit.pointer);await page.locator('#stock-price-chart').dispatchEvent('pointercancel',{pointerId:pointer,pointerType:'mouse'});await page.mouse.up();await frames(page);check(await saved(),original,'pointercancel restores edited anchor');check(await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),beforeHandles);await captureClear();
   phase=`${width}-${theme}-touch-edit`;await canvas();line=await page.locator('.drawing.selected .drawing-hit').boundingBox();let mid={x:line.x+line.width*.5,y:line.y+line.height*.5};await page.touchscreen.tap(mid.x,mid.y);await frames(page);check(await page.locator('.drawing.selected').count(),1,'touch selects a drawing');
   const beforeTouchMove=JSON.parse(await saved())[0];await swipe(mid,{x:mid.x+10,y:mid.y+12});const afterTouchMove=JSON.parse(await saved())[0];check(afterTouchMove.a.price!==beforeTouchMove.a.price,true,'touch moves the selected drawing');check(Math.abs((afterTouchMove.a.price-beforeTouchMove.a.price)-(afterTouchMove.b.price-beforeTouchMove.b.price))<1e-10,true,'touch move preserves both-anchor relationship');await captureClear();
   original=await saved();beforeHandles=await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')]));await canvas();handle=await page.locator('.drawing-handle').first().boundingBox();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:handle.x+7,y:handle.y+7}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:handle.x+18,y:handle.y+18}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await frames(page);check(await saved(),original,'native touchCancel restores edited anchor');check(await page.locator('.drawing-handle').evaluateAll(nodes=>nodes.map(n=>[n.getAttribute('cx'),n.getAttribute('cy')])),beforeHandles);await captureClear();
   phase=`${width}-${theme}-mode-midgesture`;await clear();await mode('trend');original=await saved();await mouseStart();await mode('horizontal');await page.mouse.up();await frames(page);check(await items(),0,'switching drawing mode leaves no ghost');check(await saved(),original);await captureClear();
   await mode('trend');await mouseStart();await mode('pan');await page.mouse.up();await frames(page);check(await items(),0,'drawing ON to OFF cancels draft');check(await saved(),original);await captureClear();
   b=await canvas();await page.mouse.move(b.x+b.width*.5,b.y+100);await page.mouse.down();await page.mouse.move(b.x+b.width*.65,b.y+100,{steps:3});await mode('trend');await page.mouse.move(b.x+b.width*.7,b.y+120);await page.mouse.up();await frames(page);check(await items(),0,'drawing OFF to ON cannot reuse the pan pointer as a drawing');check(await saved(),original);await captureClear();
   phase=`${width}-${theme}-touch-cancel`;await clear();await mode('trend');b=await canvas();original=await saved();await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:b.x+b.width*.4,y:b.y+80}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:b.x+b.width*.6,y:b.y+150}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await frames(page);check(await items(),0,'native touchCancel removes draft');check(await saved(),original);await captureClear();
   phase=`${width}-${theme}-pinch-on`;await mode('trend');original=await saved();await pinch();check(await items(),0,'two fingers in drawing mode cannot leave a partial drawing');check(await saved(),original);
   phase=`${width}-${theme}-vertical-outside-drawing`;await page.locator('.macd-panel').scrollIntoViewIfNeeded();b=await page.locator('.macd-panel').boundingBox();scroll=await page.evaluate(()=>scrollY);await swipe({x:b.x+b.width*.5,y:b.y+Math.min(70,b.height*.7)},{x:b.x+b.width*.5,y:b.y-70});check(await page.evaluate(before=>scrollY>before+20,scroll),true,'drawing ON outside price plot still allows page scroll');await captureClear();
   phase=`${width}-${theme}-edge-draw`;await page.locator('#chart-reset').evaluate(el=>el.click());await frames(page);await mode('trend');b=await canvas();const plot=await page.locator('.chart-volume-separator').boundingBox(),left=await page.locator('.chart-grid').first().getAttribute('x1'),right=await page.locator('.chart-grid').first().getAttribute('x2'),svgWidth=Number((await page.locator('.price-chart-svg').getAttribute('viewBox')).split(' ')[2]),scale=b.width/svgWidth;
   const edgeStart={x:b.x+(Number(left)+2)*scale,y:b.y+25*scale};
   check(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('#stock-price-chart')),edgeStart),true,'near-edge touch starts on the chart');
   await swipe(edgeStart,{x:b.x+(Number(right)-2)*scale,y:plot.y-8*scale});check(await items(),1,'near-edge touch drawing commits');check((await saved()).includes('null'),false,'no invalid edge anchor');await captureClear();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal layout overflow');await parity();
   check(await page.locator('.side-nav .nav-item').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return node.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})),Array(5).fill(true),'all navigation tabs remain reachable above chart/drawing layers');
   check(api.length,apiBefore,'gestures/cancel/mode/viewport create no API calls');
   phase=`${width}-${theme}-context-change`;await clear();await mode('trend');original=await saved();await mouseStart();await page.locator('[data-range="1W"]').evaluate(el=>el.click());await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1W'));await page.mouse.up();await frames(page);check(await saved(),original,'timeframe switch cannot commit old-context draft');check(await items(),0);await captureClear();await parity();
   await mode('trend');await mouseStart();await page.locator('#stock-search').fill('CPALL');await page.locator('.suggestion-item[data-symbol=CPALL]').waitFor();await page.locator('.suggestion-item[data-symbol=CPALL]').evaluate(el=>el.click());await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').includes('CPALL'));await page.mouse.up();await frames(page);check(await items(),0,'symbol switch cancels draft');check(await page.evaluate(()=>localStorage.getItem('setscope-drawings:PTT:1W:user-a')),null);await captureClear();
   // The visible login form alone does not establish logout reload completion.
   phase=`${width}-${theme}-account-change`;await mode('trend');await mouseStart();await page.locator('#user-avatar').evaluate(el=>el.click());await Promise.all([page.waitForEvent('load'),page.locator('#profile-logout-button').evaluate(el=>el.click())]);await page.waitForSelector('#login-form');await page.mouse.up();check(await page.evaluate(()=>localStorage.getItem('setscope-drawings:CPALL:1W:user-a')),null,'logout cannot persist an unfinished drawing');
   await page.locator('#login-form input[name=email]').fill('b@example.test');await page.locator('#login-form input[name=password]').fill('synthetic-cancel-fixture');await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('body.authenticated');await page.locator('[data-workspace-route=chart]:visible').first().click();await page.waitForSelector('.price-candle');check(await items(),0,'account B has no A draft');check(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('setscope-drawings:')&&k.endsWith('user-b')).length),0);check(errors,[]);await parity();
   results.push({width,theme,status:'PASS',checks,physicalDevices:'NOT RUN'});console.log(JSON.stringify(results.at(-1)));await cdp.detach();await context.close();
  }
  console.log(JSON.stringify({cancelTouchBrowser:'PASS',checks,results,liveProviderRequests:0,physicalDevices:'NOT RUN'}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(JSON.stringify({cancelTouchBrowser:'FAIL',phase,checks,name:error.name,message:error.message}));process.exitCode=1;});
