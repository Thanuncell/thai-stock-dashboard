'use strict';
// Offline browser acceptance: all prices/accounts are synthetic; external traffic is blocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,seedPage}=require('./account-isolation.browser.cjs');
const {rankingRows,roleRankingRows,scarceRows}=require('./fixtures/technical-ranking.cjs');
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
   const state={getOwners:[],putOwners:[]},errors=[],marketCalls=[];let short=false,pending=null,dailyState='closed',qualityWarning=false,ranking=null,priceOffset=0;
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    if(url.origin===base&&url.pathname==='/api/search'){const q=url.searchParams.get('q');return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:['PTT','CPALL'].includes(q)?[{symbol:q,name:'Fixture '+q,type:'EQUITY',exchange:'SET'}]:[]})});}
    if(url.origin===base&&url.pathname==='/api/market'){
     const range=url.searchParams.get('range')||'1D',symbol=url.searchParams.get('symbol')||'PTT';marketCalls.push({range,symbol});
     if(pending&&pending.range===range){const held=pending;pending=null;held.started();await held.wait;}
     const interval=range==='1D'?'1m':range==='1W'?'15m':range==='1M'?'30m':range==='3M'?'60m':'1d',step=interval==='1m'?60000:interval==='15m'?900000:interval==='30m'?1800000:interval==='60m'?3600000:86400000;
     const start=Date.UTC(2025,0,1,3,0,17,123),rows=ranking==='nearest'?rankingRows(range):ranking==='role'?roleRankingRows():ranking==='reverse-role'?roleRankingRows().map(row=>({
      ...row,open:200-row.open,close:200-row.close,high:200-row.low,low:200-row.high
     })):ranking==='scarce'?scarceRows():Array.from({length:short?12:260},(_,i)=>({time:start+i*step,open:100+Math.sin(i*.31)*4+i*.03,close:100.4+Math.sin(i*.31)*4+i*.03,high:103+Math.sin(i*.31)*4+i*.03,low:98+Math.sin(i*.31)*4+i*.03,volume:i===40?0:1000+i%11*100}));
     if(priceOffset) for(const row of rows) for(const key of ['open','high','low','close']) row[key]+=priceOffset;
     const end=rows.at(-1).time+(interval==='1d'?24000000:step),observed=interval==='1d'&&['during','draft-spike'].includes(dailyState)?rows.at(-1).time+3600000:end;
     if(interval==='1d'&&dailyState==='draft-spike')Object.assign(rows.at(-1),{open:999,high:1001,low:998,close:1000,volume:999999});
     const meta={interval,receivedAt:dailyState==='unknown-receipt'?null:new Date(observed).toISOString(),regularStart:interval==='1d'?rows.at(-1).time:null,regularEnd:interval==='1d'?(dailyState==='missing'?null:dailyState==='mismatch'?end+86400000:end):null,timeZone:'Asia/Bangkok',priceBasis:'provider-quote-ohlc',adjustment:'fixture-unadjusted'};
     if(short&&range==='3M')meta.cadence={status:'INTERVAL_CADENCE_UNVERIFIED'};
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({stocks:[{symbol,last:rows.at(-1).close,prior:rows.at(-2).close,time:end,history:rows,guardStatus:'accepted',dataState:'delayed'}],indices:[],history:rows,indicatorHistory:rows,levelsHistory:rows,fetchedAt:meta.receivedAt,technicalMeta:{history:meta,indicator:meta,levels:meta},dataState:qualityWarning?'stale':'delayed',errors:[]})});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await seedPage(page,'token-a');
   const verifyEvidenceRefresh=[390,1366].includes(width);
   if(verifyEvidenceRefresh) await page.clock.install();
   await page.addInitScript(theme=>localStorage.setItem('setscope-theme',theme),theme);
   const nav = route => page.locator(`.side-nav [data-workspace-route=${route}]`);
   const svg = page.locator('.price-chart-svg');
   const assertFit = async label => {
    await pause(page);
    check(await svg.evaluate(node => {
     const host = node.closest('#stock-price-chart');
     const {width, height} = node.viewBox.baseVal;
     const matrix = node.getScreenCTM();
     return Math.abs(width * matrix.a - host.clientWidth) <= 1 &&
      Math.abs(height * matrix.d - host.clientHeight) <= 1 &&
      node.parentElement.scrollWidth <= host.clientWidth + 1;
    }), true, label);
    check(await svg.evaluate(node => {
     const {width, height} = node.viewBox.baseVal;
     const labels = [...node.querySelectorAll(`text.chart-axis-text[y="${height-10}"]`)];
     return labels.length > 0 && labels.every(label => {
      const bounds = label.getBBox();
      return bounds.x >= -1 && bounds.x + bounds.width <= width + 1;
     });
    }), true, 'time labels stay inside the SVG');
   };
   phase=`${width}-${theme}-first-fit`;
   await page.goto(base+'/#overview');
   await page.waitForSelector('.compact-reasons', {state:'attached'});
   const initialCalls=marketCalls.length;
   await nav('chart').click();
   await page.waitForSelector('.price-candle');
   await assertFit('first visible render fills the chart without Reset');
   const host=page.locator('#stock-price-chart');
   check(await page.locator('.price-candle').count(), await host.evaluate(node=>node.clientWidth<520?42:68), 'default viewport uses the visible width');
   check(marketCalls.length,initialCalls,'revealing the chart makes no market request');
   if ([390,1366].includes(width)) {
    phase=`${width}-${theme}-resize-fullscreen`;
    const viewport=page.viewportSize();
    if (process.env.SETSCOPE_FIT_SCREENSHOT_DIR) {
     await host.screenshot({path:path.join(process.env.SETSCOPE_FIT_SCREENSHOT_DIR,`fit-${width}-${theme}.png`),style:'.topbar,.topbar *,.sidebar,.sidebar *{visibility:hidden!important}'});
    }
    await page.locator('#chart-zoom-in').click();
    await pause(page);
    const bars=()=>page.locator('.price-candle title').allTextContents();
    const zoomed=await bars();
    const snapshot=await host.getAttribute('data-snapshot-id');
    await nav('overview').click();
    await page.setViewportSize({width:820,height:600});
    await nav('chart').click();
    await assertFit('re-entry after resizing a hidden chart fits at tablet width');
    check(await bars(),zoomed,'re-entry preserves the zoomed window');
    await page.setViewportSize({width:viewport.height,height:viewport.width});
    await assertFit('visible resize fits in the rotated viewport');
    check(await bars(),zoomed,'orientation change preserves the zoomed window');
    await page.setViewportSize(viewport);
    // Exercise the fallback on mobile and the native Fullscreen API on desktop.
    const chartPanel=page.locator('.chart-panel');
    if(width===390)await chartPanel.evaluate(node=>{node.requestFullscreen=undefined;});
    await page.locator('#chart-fullscreen').click();
    await page.waitForFunction(()=>document.body.classList.contains('chart-fullscreen-open'));
    check(await chartPanel.evaluate(node=>document.fullscreenElement===node),width!==390);
    await assertFit('fullscreen fills the chart area');
    await page.locator('#chart-fullscreen').click();
    await page.waitForFunction(()=>!document.body.classList.contains('chart-fullscreen-open'));
    await assertFit('fullscreen exit fits');
    check(await bars(),zoomed,'fullscreen round trip preserves the zoomed window');
    check(await host.getAttribute('data-snapshot-id'),snapshot,'layout keeps the same technical snapshot');
    check(marketCalls.length,initialCalls,'layout redraws use cached data');
    const rendered=await svg.elementHandle();
    await pause(page);
    check(await rendered.evaluate(node=>node.isConnected),true,'stable geometry does not trigger another redraw');
    await page.locator('#chart-reset').click();
    await assertFit('Reset restores the default viewport at the fitted size');
   }
   phase=`${width}-${theme}-setup`;
   const parity=async(expectedReasons=3)=>{await page.waitForFunction(count=>{const a=document.querySelector('#stock-price-chart').dataset.snapshotId,b=document.querySelector('.analysis-panel').dataset.snapshotId;return a&&a===b&&document.querySelectorAll('.technical-reason-card').length===count;},expectedReasons);check(await page.locator('.technical-reason-card').count(),expectedReasons);};
   await parity();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal page overflow');
   check(await page.locator('.indicator-workspace small').textContent(),'ซ่อน/แสดงไม่เปลี่ยนผลวิเคราะห์ · การเปลี่ยน Period จะคำนวณจากข้อมูลเดิม · บันทึกแยกตามบัญชีบนอุปกรณ์นี้');
   check(await page.locator('[data-draw-status]').textContent(),'เลื่อน/ซูมกราฟตามปกติ · ภาพวาดบันทึกแยกตามบัญชีบนอุปกรณ์นี้');
   check((await page.locator('#chart-section').textContent()).includes('ในเครื่อง'),false,'drawing wording has no obsolete storage description');
   const evidence=page.locator('#technical-reasons .technical-evidence');
   const evidenceSnapshot=await page.locator('.analysis-panel').getAttribute('data-snapshot-id');
   check(await page.locator('#technical-reasons pre').count(),0,'raw evidence JSON is absent from the render path');
   check(/"(?:ruleId|candleTime|priceBasis)"\s*:/.test(await page.locator('#technical-reasons').textContent()),false,'no serialized snapshot fields');
   check(await evidence.evaluate(el=>el.open),false,'indicator details start collapsed');
   const summary=evidence.locator('summary');
   check(await summary.textContent(),'ดูหลักฐานประกอบสัญญาณ');
   check(await page.locator('.analysis-panel .disclaimer').textContent(),
    'สัญญาณเป็นเพียงหลักฐานทางเทคนิคย้อนหลัง ไม่รับประกันผล และไม่รวมปัจจัยพื้นฐาน ข่าว ค่าธรรมเนียม หรือความเสี่ยงของแต่ละคน ใช้ประกอบการศึกษา ไม่ใช่คำแนะนำซื้อขาย',
    'analysis risk and educational wording stay visible without the repeated delay sentence');
   await summary.focus();
   await page.keyboard.press('Enter');
   check(await evidence.evaluate(el=>el.open),true,'indicator details expand');
   check(await evidence.locator(':scope > .evidence-grid, .evidence-status').count(),0,'indicator status cards are omitted');
   check(await evidence.locator('.reason-group li strong').count()>0,true,'readable individual indicator values remain');
   check(await page.locator('.technical-reason-number').allTextContents(),['01','02','03']);
   const typography=await page.locator('.analysis-panel').evaluate(panel=>{
    const style=selector=>getComputedStyle(panel.querySelector(selector));
    const grid=panel.querySelector('.reason-group .evidence-grid');
    const columns=getComputedStyle(grid).gridTemplateColumns.split(' ').filter(size=>parseFloat(size)>0).length;
    const expectedColumns=matchMedia('(max-width: 790px)').matches || grid.clientWidth<304 || grid.children.length<2 ? 1 : 2;
    return {
     heading:[style('h3').fontSize,style('h3').fontWeight],
     reason:[style('.technical-reason-text').fontSize,style('.technical-reason-text').fontWeight],
     individualValue:style('.reason-group li strong').fontSize,
     compactText:['#technical-plan','#levels-basis','.disclaimer','#analysis-note'].map(selector=>{
      const text=style(selector);
      return [text.fontSize,text.lineHeight];
     }),
     family:style('.technical-reason-text').fontFamily.includes('IBM Plex Sans Thai'),
     evidenceColumnsFit:columns===expectedColumns,
     hierarchy:parseFloat(style('#overall-signal').fontSize)>parseFloat(style('.technical-reason-text').fontSize)
    };
   });
   check(typography,{heading:['14px','600'],reason:['13px','400'],individualValue:'13px',
    compactText:[['10px','17px'],['9px','14.85px'],['9px','14.85px'],['11px','18.7px']],
    family:true,evidenceColumnsFit:true,hierarchy:true},'technical type and evidence grid at this width');
   check(await evidence.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true,'expanded evidence has no horizontal overflow');
   await page.keyboard.press('Space');
   check(await evidence.evaluate(el=>el.open),false,'indicator details collapse');
   check(await page.locator('.analysis-panel').getAttribute('data-snapshot-id'),evidenceSnapshot,'expansion cannot change the calculation snapshot');
   if(verifyEvidenceRefresh){
    phase=`${width}-${theme}-evidence-refresh`;
    const apiCalls=[];
    const recordApi=request=>{
     const url=new URL(request.url());
     if(url.origin===base&&url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
    };
    page.on('request',recordApi);
    const open=()=>evidence.evaluate(node=>node.open);
    const snapshot=()=>page.locator('.analysis-panel').getAttribute('data-snapshot-id');
    const refresh=()=>page.locator('#refresh-chart').click();
    const renderAfter=async action=>{
     const previous=await page.$('#technical-reasons > .technical-evidence');
     const calls=apiCalls.length;
     await action();
     if(previous) await page.waitForFunction(node=>!node.isConnected,previous);
     else await evidence.waitFor({state:'attached'});
     check(apiCalls.slice(calls),['/api/market'],'each refresh or context change makes only its existing market request');
    };
    const shoot=async label=>{
     const directory=process.env.SETSCOPE_EVIDENCE_REFRESH_DIR;
     if(directory&&theme==='light') await evidence.screenshot({path:path.join(directory,`evidence-${width}-${label}.png`),animations:'disabled'});
    };
    const switchRange=range=>renderAfter(()=>page.locator(`[data-range="${range}"]`).click());
    const noToggleCalls=apiCalls.length;
    if(width<790) await summary.tap(); else await summary.click();
    check(await open(),true,'native pointer opens evidence');
    check(await snapshot(),evidenceSnapshot,'native disclosure does not recalculate signals');
    check(apiCalls.length,noToggleCalls,'native disclosure makes zero API requests');
    await shoot('expanded');
    const oldValues=await evidence.locator('.reason-group').allTextContents();
    priceOffset=20;
    await renderAfter(refresh);
    await shoot('after-manual-refresh');
    check(await open(),true,'expanded evidence stays open after manual refresh');
    check((await snapshot())!==evidenceSnapshot,true,'refresh consumes new market data');
    check(JSON.stringify(await evidence.locator('.reason-group').allTextContents())!==JSON.stringify(oldValues),true,'open evidence shows new values');
    await renderAfter(()=>page.clock.fastForward(60000));
    await renderAfter(()=>page.clock.fastForward(60000));
    check(await open(),true,'expanded evidence stays open across automatic refreshes');

    for(const range of ['1W','1M','3M','1Y','1D','1M','1D']){
     await switchRange(range);
     check(await open(),true,`expanded evidence persists on ${range}`);
     await parity();
    }

    short=true;
    await switchRange('1W');
    check(await evidence.count(),0,'insufficient data on another timeframe clears previous evidence');
    check(await page.locator('#overall-signal').textContent(),'ข้อมูลไม่เพียงพอ');
    short=false;
    await renderAfter(refresh);
    check(await open(),true,'returning data restores the same disclosure');
    qualityWarning=true;
    await switchRange('1M');
    check(await evidence.count(),0,'guarded stale data clears previous evidence');
    check(await page.locator('#overall-signal').textContent(),'ข้อมูลต้องตรวจสอบ');
    qualityWarning=false;
    await renderAfter(refresh);
    check(await open(),true,'guard recovery restores the same disclosure');

    await switchRange('1D');
    check(await open(),true,'returning to the original timeframe keeps the last choice');
    for(const [symbol,expected] of [['CPALL',false],['PTT',true],['CPALL',true],['PTT',true]]){
     await page.locator('#stock-search').fill(symbol);
     const item=page.locator(`.suggestion-item[data-symbol=${symbol}]`);
     await item.waitFor();
     await renderAfter(()=>item.click());
     check(await open(),expected,'symbols have independent disclosure states');
     if(symbol==='CPALL'){
      const calls=apiCalls.length;
      await summary.click();
      check(await open(),!expected,'the latest choice applies only to this symbol');
      check(apiCalls.length,calls,'toggling another symbol also makes zero API requests');
     }
    }
    const stable=await snapshot(),beforeKeyboard=apiCalls.length;
    await summary.focus();await page.keyboard.press('Space');
    check(await open(),false,'keyboard closes evidence');
    check(await snapshot(),stable,'keyboard disclosure does not change the snapshot');
    check(apiCalls.length,beforeKeyboard,'keyboard disclosure makes zero API requests');
    for(const range of ['1W','1Y','1D']){
     await switchRange(range);
     check(await open(),false,`collapsed evidence persists on ${range}`);
    }
    priceOffset=0;
    await renderAfter(refresh);
    check(await open(),false,'collapsed evidence stays closed after manual refresh');
    await renderAfter(()=>page.clock.fastForward(60000));
    check(await open(),false,'collapsed evidence stays closed after auto refresh');
    page.off('request',recordApi);
   }
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
   for (const range of ['1W', '1M', '3M', '1Y', '1D']) {
    await page.locator('[data-range="'+range+'"]').click();
    await page.waitForFunction(range=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(range),range);
    await parity();
    check((await page.locator('#analysis-note').textContent()).includes('ยืนยันแล้ว'),true);
    if (!['1M', '3M'].includes(range)) continue;
    const candles = page.locator('.price-candle');
    check(Number(await host.getAttribute('data-source-candles')),260,'dense fixture includes 260 source candles');
    check((await page.locator('#chart-updated').textContent()).includes('แท่งจากแหล่งข้อมูล'),false,'dense update line hides source candle count');
    const fullReceipt = range==='1M' ? '06 ม.ค. 2568 20:00' : '12 ม.ค. 2568 06:00';
    check(await page.locator('#chart-updated').textContent(),'อัปเดตเมื่อ '+fullReceipt+' (เวลาไทย)','header shows the fixture receipt without a candle count');
    const initialCount = await host.evaluate(node=>node.clientWidth<520?42:68);
    check(await candles.count(),initialCount,'dense default remains readable');
    check(/\d\d:\d\d/.test(await candles.first().locator('title').textContent()),true,'intraday tooltip includes candle time');
    const widthOfCandle = async () => Number(await candles.first().locator('rect').first().getAttribute('width'));
    const firstTitle = () => candles.first().locator('title').textContent();
    const lastTitle = await candles.last().locator('title').textContent();
    const initialCandleWidth = await widthOfCandle();
    const initialSnapshot = await host.getAttribute('data-snapshot-id');
    const callsBeforeZoom = marketCalls.length;
    const verifyAnchors = width===390 && theme==='light' && range==='1M';
    const drawingKey = 'setscope-drawings:PTT:' + range + ':user-a';
    if (verifyAnchors) {
     await draw('trend',true);
     await page.locator('[data-draw-tool=pan]').click();
    }
    const anchorData = verifyAnchors ? await page.evaluate(key=>localStorage.getItem(key),drawingKey) : null;
    for (let i=0;i<12&&await candles.count()<260;i++) {
     const before = await candles.count();
     await page.locator('#chart-zoom-out').click();
     await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length>count,before);
    }
    check(await candles.count(),260,'zoom out reaches all cached rows');
    check(await candles.last().locator('title').textContent(),lastTitle,'full view reaches the same last candle');
    const fullyZoomed = await widthOfCandle();
    check(fullyZoomed<initialCandleWidth,true,'zoom out narrows the candle body');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'full view stays within the layout');
    await page.locator('#chart-zoom-in').click();
    await page.waitForFunction(()=>document.querySelectorAll('.price-candle').length<260);
    check(await widthOfCandle()>fullyZoomed,true,'zoom in widens the candle body');
    await host.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox(), beforePan = await firstTitle();
    const x = box.x + box.width * .42, y = box.y + 100;
    if (width<790) {
     const cdp=await context.newCDPSession(page);
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
     await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+60,y}]});
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
     await page.waitForFunction(title=>document.querySelector('.price-candle title')?.textContent!==title,beforePan);
     const beforePinch = await candles.count();
     await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-30,y},{x:x+30,y}]});
     await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-60,y},{x:x+60,y}]});
     await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
     await cdp.detach();
     await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length<count,beforePinch);
    } else {
     await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+60,y,{steps:4});await page.mouse.up();
     await page.waitForFunction(title=>document.querySelector('.price-candle title')?.textContent!==title,beforePan);
     const scrollY=await page.evaluate(()=>window.scrollY), beforeWheel=await candles.count();
     await page.mouse.move(x,y);
     await page.mouse.wheel(0,100);
     await page.waitForFunction(offset=>window.scrollY!==offset,scrollY);
     check(await candles.count(),beforeWheel,'unmodified wheel scrolls without changing chart zoom');
     await host.scrollIntoViewIfNeeded();
     const wheelBox=await svg.boundingBox();
     await page.mouse.move(wheelBox.x+wheelBox.width*.5,wheelBox.y+100);
     await page.keyboard.down('Control');
     try { await page.mouse.wheel(0,-120); } finally { await page.keyboard.up('Control'); }
     await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length<count,beforeWheel);
    }
    check(await host.getAttribute('data-snapshot-id'),initialSnapshot,'viewport changes keep the analysis snapshot');
    check(marketCalls.length,callsBeforeZoom,'zoom, pan and pointer gestures use cached rows');
    check(await candles.first().evaluate(node=>{
     const wick=Number(node.querySelector('line').getAttribute('x1')),hit=node.querySelector('.candle-hit');
     const center=Number(hit.getAttribute('x'))+Number(hit.getAttribute('width'))/2;
     const line=node.closest('svg').querySelector('.sma20-chart-line');
     const startX=Number(line?.getAttribute('d')?.match(/^M([\d.]+)/)?.[1]);
     return Math.abs(wick-center)<.01&&Math.abs(wick-startX)<.1;
    }),true,'candle hover target and SMA align with the visible candle after zoom and pan');
    await page.locator('#chart-reset').click();
    await page.waitForFunction(count=>document.querySelectorAll('.price-candle').length===count,initialCount);
    if (verifyAnchors) {
     check(Boolean(anchorData),true,'dense range has a saved drawing');
     check(await page.evaluate(key=>localStorage.getItem(key),drawingKey),anchorData,'zoom and pan preserve drawing anchors');
     await page.locator('[data-draw-reset]').click();
    }
    short=true;
    await page.locator('#refresh-chart').click();
    await page.waitForFunction(()=>document.querySelector('#stock-price-chart').dataset.sourceCandles==='12');
    check(await page.locator('.price-candle').count(),12,'short dense range preserves the provider rows');
    check((await page.locator('#chart-updated').textContent()).includes('ข้อมูลแท่งเทียนยังไม่เพียงพอ'),true,'short dense range still shows insufficient data');
    check((await page.locator('#chart-updated').textContent()).includes('12/100'),false,'short dense range hides source candle count');
    const shortReceipt = range==='1M' ? '01 ม.ค. 2568 16:00' : '01 ม.ค. 2568 22:00';
    const cadenceNotice = range==='3M' ? ' · ยังยืนยันความถี่ของแท่งไม่ได้' : '';
    check(await page.locator('#chart-updated').textContent(),
     'อัปเดตเมื่อ '+shortReceipt+' (เวลาไทย) · ข้อมูลแท่งเทียนยังไม่เพียงพอ'+cadenceNotice,
     'short range shows the actual receipt and preserves warnings');
    short=false;
   }
   phase=`${width}-${theme}-daily-confirmation`;
   {
    const range='1Y';
    await page.locator(`[data-range="${range}"]`).click();await page.waitForFunction(range=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith(range),range);
    let priorReasons;
    for(const mode of ['closed','during','draft-spike','missing','mismatch']){
     dailyState=mode;
     const done=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market');await page.locator('#refresh-chart').click();await done;
     const expected=Date.UTC(2025,0,1,3,0,17,123)+(mode==='closed'?259:258)*86400000;
     await page.waitForFunction(time=>document.querySelector('.analysis-panel').dataset.signalCandleTime===String(time),expected);await pause(page);await parity();
     check(await page.locator('#stock-price-chart').getAttribute('data-signal-candle-time'),String(expected),'chart and summary use the same signal reference');
     check(await page.locator('#stock-price-chart').getAttribute('data-latest-candle-time'),String(Date.UTC(2025,0,1,3,0,17,123)+259*86400000),'raw chart candle time is unchanged');
     check(['ซื้อ','ขาย','เป็นกลาง'].includes(await page.locator('#overall-signal').textContent()),true,'available confirmed history does not remain waiting');
     check((await page.locator('#analysis-note').textContent()).includes(mode==='closed'?'แท่งยืนยันแล้ว':'ใช้แท่งปิดก่อนหน้า'),true);
     check((await page.locator('#chart-updated').textContent()).includes(['during','draft-spike'].includes(mode)?'11:00':'16:40'),true,'received time is not daily open time');
     check((await page.locator('#chart-updated').getAttribute('title')).includes('แท่งราคาล่าสุดเปิด'),true);
     const reasons=await page.locator('.technical-reason-text').allTextContents();if(mode==='during')priorReasons=reasons;if(mode==='draft-spike')check(reasons,priorReasons,'draft spike cannot change confirmed explanations');
     check(await page.locator('#technical-reasons pre').count(),0,'daily evidence never renders JSON');
    }
     qualityWarning=true;const warningDone=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market');await page.locator('#refresh-chart').click();await warningDone;await page.waitForFunction(()=>document.querySelector('#overall-signal').textContent==='ข้อมูลต้องตรวจสอบ');await parity(0);check(await page.locator('#buy-count').textContent(),'—','critical quality cannot show actionable votes');check(await page.locator('#analysis-note').isVisible(),true);check((await page.locator('#analysis-note').textContent()).startsWith('ข้อมูลต้องตรวจสอบ'),true);qualityWarning=false;dailyState='closed';
   }
   short=true;dailyState='missing';const shortDone=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market');await page.locator('#refresh-chart').click();await shortDone;await page.waitForFunction(()=>document.querySelector('#overall-signal').textContent==='ข้อมูลไม่เพียงพอ');check(await page.locator('#rsi-value').textContent(),'—');check(await page.locator('#analysis-note').isVisible(),true);check((await page.locator('#analysis-note').textContent()).startsWith('ข้อมูลไม่เพียงพอ'),true);
   short=false;dailyState='unknown-receipt';const unconfirmedDone=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market');await page.locator('#refresh-chart').click();await unconfirmedDone;await page.waitForFunction(()=>document.querySelector('#overall-signal').textContent==='รอแท่งปิด');check(await page.locator('#analysis-note').isVisible(),true);check((await page.locator('#analysis-note').textContent()).startsWith('รอแท่งปิด'),true);check((await page.locator('#chart-updated').textContent()), 'อัปเดตเมื่อ —');check(await page.locator('#stock-price-chart').getAttribute('data-signal-candle-time'),'');
   short=false;dailyState='closed';await page.locator('[data-range="1D"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1D'));await parity();
   phase=`${width}-${theme}-ranking`;
   ranking='nearest';
   for(const range of ['1D','1W','1M','3M','1Y']){
    const done=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market'&&new URL(r.url()).searchParams.get('range')===range);
    if(range==='1D')await page.locator('#refresh-chart').click();else await page.locator(`[data-range="${range}"]`).click();
    await done;await page.waitForFunction(()=>document.querySelector('#support-1').textContent.startsWith('36.25'));await parity();
    for(let i=0;i<12&&await page.locator('.price-candle').count()<200;i++){await page.locator('#chart-zoom-out').click();await pause(page);}
    check(await page.locator('.price-candle').count(),200,'full fixture view exposes all evidenced levels');
    for(const [side,letter,values]of [['support','S',[36.25,35.25,35]],['resistance','R',[41.25,41.75,42]]]){
     const labels=await page.locator(`.chart-level.${side} text`).allTextContents();check(labels.length,3);
     for(let i=0;i<3;i++){
      check(Number((await page.locator(`#${side}-${i+1}`).textContent()).split(' · ')[0]),values[i],'card order follows price');
      check(labels[i].startsWith(`${letter}${i+1} ${values[i].toFixed(2)} · `),true,'chart and cards share rank/value');
     }
    }
    const reasons=await page.locator('.compact-reasons').textContent(),plan=await page.locator('#technical-plan').textContent();
    check(reasons.includes('แนวรับ 36.25 · แนวต้าน 41.25'),true,'summary shares S1/R1');
    check(plan.includes('แนวรับ 1 36.25')&&plan.includes('แนวต้าน 1 41.25'),true,'plan shares S1/R1');
    check((await page.locator('#chart-updated').textContent()).startsWith('อัปเดตเมื่อ '),true);
    check((await page.locator('#chart-updated').textContent()).includes('(เวลาไทย)'),true);
    check(await page.locator('.chart-source-note').textContent(),'แหล่งข้อมูล: Yahoo Finance · ล่าช้าประมาณ 15 นาที');
    check(await page.locator('#technical-reasons pre').count(),0);
    const localCalls=marketCalls.length;await page.locator('#chart-reset').click();await pause(page);check(marketCalls.length,localCalls,'ranking/zoom are local');
   }
   ranking='role';await page.locator('[data-range="1D"]').click();await page.waitForFunction(()=>document.querySelector('#support-1').textContent.startsWith('110.00'));await parity();
   for(let i=0;i<5&&await page.locator('.price-candle').count()<45;i++){await page.locator('#chart-zoom-out').click();await pause(page);}
   check(await page.locator('#support-1').textContent(),'110.00 · Swing high');
   check(await page.locator('.chart-level.support text').first().textContent(),'S1 110.00 · Swing high');
   ranking='reverse-role';await page.locator('#refresh-chart').click();
   await page.waitForFunction(()=>document.querySelector('#resistance-1').textContent.startsWith('90.00'));await parity();
   check(await page.locator('#resistance-1').textContent(),'90.00 · Swing low');
   check(await page.locator('.chart-level.resistance text').first().textContent(),'R1 90.00 · Swing low');
   ranking='scarce';await page.locator('#refresh-chart').click();await page.waitForFunction(()=>document.querySelector('#support-1').textContent.startsWith('16.67'));await parity();
   for(const rank of [2,3])check(await page.locator(`#support-${rank}`).textContent(),'ไม่มีแนวในช่วงนี้','missing levels are not invented');
   ranking=null;await page.locator('#refresh-chart').click();await page.waitForFunction(()=>!document.querySelector('#support-1').textContent.startsWith('16.67'));await parity();
   phase=`${width}-${theme}-race`;
   if(!await evidence.evaluate(node=>node.open)) await summary.click();
   const raceCalls=marketCalls.length;
   let release,started;const began=new Promise(resolve=>{started=resolve;});pending={range:'1W',started,wait:new Promise(resolve=>{release=resolve;})};
   await page.locator('[data-range="1W"]').click();await began;await page.locator('[data-range="1M"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1M'));
   await parity();
   const winningSnapshot=await page.locator('.analysis-panel').getAttribute('data-snapshot-id');
   check(await evidence.evaluate(node=>node.open),true,'latest timeframe keeps evidence expanded before the late response');
   const completed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market'&&new URL(r.url()).searchParams.get('range')==='1W');release();await completed;await pause(page);
   check((await page.locator('.price-chart-svg').getAttribute('aria-label')).endsWith('1M'),true,'late timeframe response cannot replace newer data');await parity();
   check(await page.locator('.analysis-panel').getAttribute('data-snapshot-id'),winningSnapshot,'late timeframe response cannot replace the analysis snapshot');
   check(await evidence.evaluate(node=>node.open),true,'late timeframe response cannot alter the evidence state');
   check(marketCalls.slice(raceCalls).map(call=>call.range),['1W','1M'],'rapid switching makes one market request per selection');
   for(const symbol of ['CPALL','PTT']){await page.locator('#stock-search').fill(symbol);await page.locator(`.suggestion-item[data-symbol=${symbol}]`).waitFor();await page.locator(`.suggestion-item[data-symbol=${symbol}]`).click();await page.waitForFunction(symbol=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').includes(symbol),symbol);await parity();}
   await page.locator('[data-range="1D"]').click();await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').endsWith('1D'));await parity();
   short=true;await page.locator('#refresh-chart').click();await page.waitForFunction(()=>document.querySelector('#overall-signal').textContent==='ข้อมูลไม่เพียงพอ');
   check(await page.locator('.price-candle').count(),12,'insufficient history keeps real candles visible');check(await page.locator('#rsi-value').textContent(),'—');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);check(errors,[],'no browser errors');
   if(process.env.SETSCOPE_TECHNICAL_SCREENSHOT_DIR){short=false;await page.locator('#refresh-chart').click();await page.waitForSelector('.compact-reasons');await page.locator('.indicator-workspace summary').click();await page.selectOption('#indicator-preset','momentum');await page.locator('.rsi-panel').waitFor();await page.locator('#chart-section').screenshot({path:path.join(process.env.SETSCOPE_TECHNICAL_SCREENSHOT_DIR,`technical-${width}-${theme}.png`)});}
   phase=`${width}-${theme}-account-switch`;
   short=false;await page.locator('#refresh-chart').click();await page.waitForSelector('.compact-reasons');
   await draw('trend',width<790);check(await page.locator('[data-draw-list] button').count(),1);
   if(!await page.locator('#indicator-settings').isVisible())await page.locator('.indicator-workspace summary').click();
   await page.locator('#indicator-settings input[name=rsi]').fill('7');await page.locator('#indicator-settings button[type=submit]').click();
   if(verifyEvidenceRefresh && !await evidence.evaluate(node=>node.open)) await summary.click();
   // Logout shows the form before its asynchronous reload; wait for the new document.
   await page.locator('#user-avatar').click();await Promise.all([page.waitForEvent('load'),page.locator('#profile-logout-button').click()]);await page.waitForSelector('#login-form');
   await page.locator('#login-form input[name=email]').fill('b@example.test');await page.locator('#login-form input[name=password]').fill('synthetic-chart-fixture');await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('body.authenticated');
   await page.locator('[data-workspace-route=chart]:visible').first().click();await page.waitForSelector('.price-candle');await parity();
   if(verifyEvidenceRefresh){
    await page.locator('#stock-search').fill('PTT');
    await page.locator('.suggestion-item[data-symbol=PTT]').click();
    await page.waitForFunction(()=>document.querySelector('.price-chart-svg')?.getAttribute('aria-label').includes('PTT'));
    check(await evidence.evaluate(node=>node.open),false,'account B starts collapsed for the same symbol and timeframe');
   }
   check(await page.locator('[data-draw-list] button').count(),0,'account B never sees account A drawings');check(await page.locator('#indicator-settings input[name=rsi]').inputValue(),'14','account B never inherits account A parameters');
   check(await page.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('setscope-drawings:')&&!/user-[ab]$/.test(key))),false,'no unscoped drawing storage');check(errors,[]);
   console.log(JSON.stringify({width,theme,result:'PASS',checks}));await context.close();
  }
  console.log(JSON.stringify({technicalBrowser:'PASS',checks,liveProviderRequests:0}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(JSON.stringify({technicalBrowser:'FAIL',phase,name:error.name,message:error.message}));process.exitCode=1;});
