'use strict';
// Full local application, normal fixture login, controlled API/account data; no production traffic.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest,freePort,waitForServer}=require('./account-isolation.browser.cjs');
const root=path.resolve(__dirname,'..'),out=process.env.SETSCOPE_ALERT_EVIDENCE||path.join(root,'artifacts/alert-popup');
fs.mkdirSync(out,{recursive:true});
let checks=0,phase='setup';const results=[];
const check=(actual,expected,note)=>{assert.deepEqual(actual,expected,note);checks++;};
const fields=['above','below','percentAbove','percentBelow'];
const history=Array.from({length:30},(_,i)=>({symbol:'PTT',title:i<2?'Identical event':`Price event ${i+1}`,body:'Controlled notification history',time:new Date(Date.UTC(2026,10,26,8)-Math.max(0,i-1)*60000).toISOString(),fixtureId:i}));
const initialPrefs={PTT:{above:'100',below:'90',percentAbove:'5',percentBelow:'5',technical:true},CPALL:{above:'70',below:'',percentAbove:'',percentBelow:''}};
(async()=>{
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const server=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),SUPABASE_URL:'https://isolation-test.supabase.co',SUPABASE_ANON_KEY:'public-browser-fixture'},stdio:['ignore','ignore','pipe'],windowsHide:true});
 let browser;try{
  await waitForServer(base+'/healthz');browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'light'],[390,'dark'],[320,'light']]){
   phase=`${width}-${theme}`;
   const context=await browser.newContext({viewport:{width,height:width===320?640:900},isMobile:width<790,hasTouch:width<790});
   const page=await context.newPage(),errors=[],external=[],state={getOwners:[],putOwners:[]};let last=99,marketCalls=0;
   context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));page.on('pageerror',e=>errors.push(e.message));
   const fixtureRoute=async route=>{
    const req=route.request(),u=new URL(req.url()),owner=/token-b/.test(req.headers().authorization||'')?'b':'a';
    const json=data=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    if(u.origin!==base&&u.origin!=='https://isolation-test.supabase.co'){external.push(u.origin);return route.abort();}
    if(u.origin===base&&u.pathname==='/api/watchlists'){
     if(req.method()==='PUT')return json({ok:true});
     const items=symbols=>symbols.map(symbol=>({symbol,name:`Fixture ${symbol}`}));
     return json({record:{watchlists:owner==='a'?[{id:'list-1',name:'First watchlist',items:items(['PTT','CPALL'])},{id:'list-2',name:'Second watchlist',items:items(['PTT','SCB'])},{id:'empty',name:'Empty watchlist',items:[]}]:[{id:'list-1',name:'Second account',items:items(['PTT'])}],active_watchlist_id:'list-1'}});
    }
    if(u.origin===base&&u.pathname==='/api/market'){
     marketCalls++;const now=Date.now(),bars=Array.from({length:80},(_,i)=>({time:now-(80-i)*60000,open:99+i*.01,close:99+i*.01,high:100+i*.01,low:98+i*.01,volume:1000}));
     const stocks=['PTT','CPALL','SCB'].map(symbol=>({symbol,last:symbol==='PTT'?last:60,prior:100,time:now,provider:'Yahoo Finance',guardStatus:'accepted',identityStatus:'accepted',dataState:'delayed',history:bars}));
     const meta={provider:'fixture',interval:'1m',timeZone:'Asia/Bangkok',receivedAt:new Date(now).toISOString()};
     return json({stocks,history:bars,indicatorHistory:bars,levelsHistory:bars,technicalMeta:{history:meta,indicator:meta,levels:meta},indices:[],errors:[],dataState:'delayed',fetchedAt:meta.receivedAt});
    }
    return mockRequest(route,base,state);
   };
   await context.route('**/*',fixtureRoute);
   const seed=({theme,history,initialPrefs})=>{
    localStorage.setItem('setscope-theme',theme);
    if(!localStorage.getItem('popup-fixture-seeded')){
     localStorage.setItem('popup-fixture-seeded','1');
     localStorage.setItem('setscope-alert-prefs:user-a',JSON.stringify(initialPrefs));
     localStorage.setItem('setscope-alert-history:user-a',JSON.stringify(history));
     localStorage.setItem('setscope-alert-prefs:user-b',JSON.stringify({PTT:{above:'200',below:'',percentAbove:'',percentBelow:''}}));
     localStorage.setItem('setscope-alert-history:user-b',JSON.stringify([{symbol:'PTT',title:'B private history',body:'B only',time:new Date().toISOString()}]));
    }
    window.fixtureNotifications=[];window.fixturePermission='default';window.fixturePermissionRequests=0;
    window.Notification=class{static get permission(){return window.fixturePermission;}static async requestPermission(){window.fixturePermissionRequests++;return window.fixturePermission='granted';}constructor(title,options){window.fixtureNotifications.push({title,options});}};
   };
   await page.addInitScript(seed,{theme,history,initialPrefs});
   const login=async(owner='a')=>{await page.locator('#login-form input[name=email]').fill(owner+'@example.test');await page.locator('#login-form input[name=password]').fill('controlled-fixture-password');await page.locator('#login-form button[type=submit]').click();await page.locator('body.authenticated').waitFor();await page.waitForFunction(()=>document.querySelector('#watchlist-mobile [data-sym]'));};
   const logout=async()=>{await Promise.all([page.waitForEvent('load'),page.locator('#profile-logout-button').click()]);await page.locator('#login-form:not([hidden])').waitFor();};
   const nav=async route=>{await page.locator(`.side-nav [data-workspace-route=${route}]`).click();};
   const open=async()=>{if(!await page.locator('#alert-settings-overlay').isVisible()){await nav('profile');await page.locator('#profile-alerts-button').click();}};
   const pick=async symbol=>{await open();await page.locator('#alert-symbol-select').selectOption(symbol);};
   const storage=()=>page.evaluate(()=>Object.fromEntries(['prefs','states','history'].map(k=>[k,localStorage.getItem(`setscope-alert-${k}:user-a`)])));
   const values=()=>page.locator('#alerts-settings [data-field]').evaluateAll(nodes=>nodes.map(n=>n.value));
   const edit=async(field,value)=>{await page.locator(`#alerts-settings [data-enable=${field}]`).check();await page.locator(`#alerts-settings [data-field=${field}]`).fill(value);};
   const switchList=async id=>{await nav('watchlist');await page.locator(width<790?'#watchlist-select-mobile':'#watchlist-select').selectOption(id);};
   const dismiss=async selector=>{const node=page.locator(selector);if(width<790)await node.tap();else await node.click();};
   const buttonStyle=locator=>locator.evaluate(n=>{const s=getComputedStyle(n);return Object.fromEntries(['color','fontFamily','fontSize','fontWeight','lineHeight','backgroundColor','borderTopWidth','paddingLeft','paddingRight','cursor'].map(k=>[k,s[k]]));});
   const focusStyle=locator=>locator.evaluate(n=>{const s=getComputedStyle(n);return {style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor};});
   await page.goto(base+'/?symbol=PTT&range=1D#profile');await login();await nav('watchlist');
   const watchDelete=page.locator('#watchlist-mobile [data-remove]').first();await watchDelete.scrollIntoViewIfNeeded();await page.mouse.move(0,0);const watchNormal=await buttonStyle(watchDelete);await watchDelete.hover();const watchHover=await buttonStyle(watchDelete);await page.keyboard.press('Tab');await watchDelete.focus();const watchFocus=await focusStyle(watchDelete);
   await open();const url=page.url();
   check(await page.locator('#alert-symbol-select option').allTextContents(),['PTT · Fixture PTT','CPALL · Fixture CPALL'],'selected watchlist dropdown');
   check(await values(),['100','90','5','5'],'legacy saved fields');check(await page.locator('#alerts-settings [data-field]').count(),4,'single symbol form');
   const before=await storage();await edit('above','123');check(await storage(),before,'draft does not persist or reset state');
   await dismiss('#alert-settings-cancel');check(page.url(),url,'Cancel keeps URL');await open();check(await values(),['100','90','5','5'],'Cancel discards');
   await edit('above','124');await page.keyboard.press('Escape');check(await page.locator('#profile-alerts-button').evaluate(n=>n===document.activeElement),true,'Escape focus restored');await open();check(await values(),['100','90','5','5'],'Escape discards');
   await edit('above','125');await dismiss('#alert-settings-close');await open();check(await values(),['100','90','5','5'],'Close discards');
   await edit('above','126');await page.locator('#alert-settings-overlay').click({position:{x:1,y:1}});await open();check(await values(),['100','90','5','5'],'backdrop discards');
   await edit('above','127');await pick('CPALL');await pick('PTT');check(await values(),['100','90','5','5'],'symbol change discards unsaved draft');
   await page.locator('#alert-settings-close').focus();await page.keyboard.press('Shift+Tab');check(await page.locator('#alert-settings-save').evaluate(n=>n===document.activeElement),true,'focus wraps backwards');await page.keyboard.press('Tab');check(await page.locator('#alert-settings-close').evaluate(n=>n===document.activeElement),true,'focus wraps forwards');
   const cpallBefore=JSON.parse((await storage()).prefs).CPALL;
   await edit('above','101');await dismiss('#alert-settings-save');check(JSON.parse((await storage()).prefs).PTT.above,'101','save PTT only');check(JSON.parse((await storage()).prefs).CPALL,cpallBefore,'other symbol preserved');
   await open();const unchanged=await storage();await dismiss('#alert-settings-save');check(await storage(),unchanged,'unchanged Save keeps states');
   await open();await pick('CPALL');check((await values())[0],'70','other symbol reads saved value');await page.keyboard.press('Escape');
   await switchList('list-2');await open();check(await page.locator('#alert-symbol-select').inputValue(),'PTT','shared symbol selected');check((await values())[0],'101','shared symbol prefs retained');await pick('SCB');check(await values(),['','','',''],'new symbol opt-in blank');await page.keyboard.press('Escape');
   await switchList('empty');await open();check(await page.locator('#alert-settings-save').isDisabled(),true,'empty list cannot Save');check(await page.locator('#alert-symbol-select').isDisabled(),true,'empty selector disabled');await page.keyboard.press('Escape');
   await switchList('list-1');await page.reload();await page.locator('body.authenticated').waitFor();await page.waitForFunction(()=>document.querySelector('#watchlist-mobile [data-sym]'));await open();check((await values())[0],'101','saved preferences survive refresh');
   await edit('above','0');const beforeInvalid=await storage();await page.locator('#alert-settings-save').click();check(await page.locator('#alert-settings-error').isVisible(),true,'invalid enabled threshold rejects Save');check(await storage(),beforeInvalid,'invalid Save keeps storage');await edit('above','100');await dismiss('#alert-settings-save');await open();
   await page.locator('#notification-permission').click();check(await page.evaluate(()=>window.fixturePermissionRequests),1,'existing permission request');check(await page.locator('#notification-status').textContent(),'เปิดอยู่ · แจ้งเตือนระหว่างเปิด SETscope ไว้','granted permission status');
   const manual=async()=>{const n=marketCalls;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/market');await page.locator('#watchlist-check').click();await response;await page.waitForFunction(()=>!document.querySelector('#watchlist-check').disabled);check(marketCalls,n+1,'Manual Check one request');};
   await manual();last=101;await manual();check(await page.locator('#alert-badge').textContent(),'1','real engine fixture crossing increments badge');
   check(await page.evaluate(()=>window.fixtureNotifications.length),1,'one browser Notification API call');await manual();check(await page.locator('#alert-badge').textContent(),'1','no duplicate on same side');
   await page.keyboard.press('Escape');const profileUrl=page.url();await open();check(await page.locator('#alert-badge').textContent(),'1','Settings does not clear unread');
   check(page.url(),profileUrl,'Settings never adds a route');
   const geometry=await page.locator('.alert-settings-dialog').evaluate(n=>{const r=n.getBoundingClientRect();return {inside:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight,overflow:n.scrollWidth>n.clientWidth,documentOverflow:document.documentElement.scrollWidth>innerWidth};});
   check(geometry,{inside:true,overflow:false,documentOverflow:false},'popup fits viewport');
   await page.locator('#alert-settings-save').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`settings-actions-${width}-${theme}.png`)});
   await page.locator('.alert-settings-dialog').evaluate(n=>n.scrollTop=0);await page.screenshot({path:path.join(out,`settings-${width}-${theme}.png`)});
   const targets=await page.locator('#alerts-settings .alert-condition-toggle, #alert-settings-close, #alert-settings-save, #alert-settings-cancel').evaluateAll(nodes=>nodes.map(n=>({name:n.textContent.trim(),width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})));
   if(width<790)check(targets.every(t=>t.height>=44),true,'mobile controls have touch height');
   await page.keyboard.press('Escape');await page.locator('#alerts-toggle').click();check(await page.locator('#alert-badge').isHidden(),true,'Bell clears unread');
   check(await page.locator('#alerts-panel input, #alerts-panel select, #alerts-panel [role=tab], #alerts-panel #watchlist-check, #alerts-panel #alerts-settings').count(),0,'Bell history only');
   check(await page.locator('#alerts-history .alert-history-item').count(),30,'all thirty records accessible');
   await page.locator('#alerts-history .alert-history-item').last().scrollIntoViewIfNeeded();check(await page.locator('#alerts-history .alert-history-item').last().isVisible(),true,'last history row reachable');
   await page.locator('#alerts-history').evaluate(n=>n.scrollTop=0);
   const beforeDelete=await storage(),rows=JSON.parse(beforeDelete.history);await dismiss('[data-alert-delete="2"]');
   check(JSON.parse((await storage()).history),rows.filter((_,i)=>i!==2),'delete exact index among identical events');check((await storage()).prefs,beforeDelete.prefs,'delete keeps prefs');check((await storage()).states,beforeDelete.states,'delete keeps crossing states');check(await page.locator('#alerts-panel').isVisible(),true,'deletion keeps Bell open');
   const deleteTarget=await page.locator('[data-alert-delete="0"]').boundingBox();
   if(width<790)check(deleteTarget.width>=44&&deleteTarget.height>=44,true,'mobile Bell delete touch target');
   const historyDelete=page.locator('[data-alert-delete="0"]');await page.mouse.move(0,0);check(await buttonStyle(historyDelete),watchNormal,'History delete reuses Watchlist normal visual style');
   check(await historyDelete.textContent(),'×','History delete is cross only');check(await historyDelete.getAttribute('aria-label'),'ลบการแจ้งเตือนรายการที่ 1','accessible delete label retained');
   await historyDelete.hover();check(await buttonStyle(historyDelete),watchHover,'Watchlist hover style retained');await page.keyboard.press('Tab');await historyDelete.focus();check(await focusStyle(historyDelete),watchFocus,'Watchlist keyboard focus style retained');
   const rowGeometry=await page.locator('#alerts-history .alert-history-item').evaluateAll(nodes=>nodes.map(n=>{const b=n.querySelector('button').getBoundingClientRect(),t=n.querySelector('.alert-history-content').getBoundingClientRect();return {right:b.right,overlap:t.right>b.left,overflow:n.scrollWidth>n.clientWidth};}));
   check(rowGeometry.every(r=>Math.abs(r.right-rowGeometry[0].right)<1&&!r.overlap&&!r.overflow),true,'right-aligned crosses never overlap text');
   const clearAll=await page.locator('#alerts-clear-all').evaluate(n=>{const b=n.getBoundingClientRect(),s=getComputedStyle(n),r=n.parentElement.getBoundingClientRect();return {width:b.width,height:b.height,fontSize:s.fontSize,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom,rightAligned:Math.abs(b.right-r.right)<1,inside:b.x>=0&&b.right<=innerWidth,text:n.textContent};});
   check(clearAll.rightAligned&&clearAll.inside,true,'Clear All remains right aligned and within viewport');check(clearAll.text,'ลบทั้งหมด','Clear All label preserved');
   if(width<790){check({height:clearAll.height,font:clearAll.fontSize,padding:clearAll.paddingTop},{height:32,font:'9px',padding:'4px'},'mobile Clear All is compact');check(clearAll.width>=56,true,'compact Clear All retains usable touch width');}
   else check({font:clearAll.fontSize,padding:clearAll.paddingTop},{font:'10px',padding:'5px'},'desktop Clear All style unchanged');
   await page.mouse.move(0,0);await historyDelete.evaluate(n=>n.blur());
   await page.screenshot({path:path.join(out,`bell-${width}-${theme}.png`)});
   const keyboardRows=JSON.parse((await storage()).history);await page.locator('#alerts-close').focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');check(await historyDelete.evaluate(n=>document.activeElement===n),true,'delete reachable by keyboard navigation');await page.keyboard.press('Enter');
   check(JSON.parse((await storage()).history),keyboardRows.slice(1),'Enter deletes only focused row');check(await page.locator('#alerts-panel').isVisible(),true,'keyboard deletion keeps Bell open');check((await storage()).prefs,beforeDelete.prefs,'keyboard delete keeps prefs');check((await storage()).states,beforeDelete.states,'keyboard delete keeps states');
   const confirm=async accept=>{page.once('dialog',d=>accept?d.accept():d.dismiss());await dismiss('#alerts-clear-all');};
   let otherContext,otherPage;
   if(width===1440&&theme==='light'){
    otherContext=await browser.newContext();await otherContext.route('**/*',fixtureRoute);await otherContext.addInitScript(seed,{theme,history,initialPrefs});otherPage=await otherContext.newPage();
    await otherPage.goto(base+'/#profile');await otherPage.locator('#login-form input[name=email]').fill('a@example.test');await otherPage.locator('#login-form input[name=password]').fill('controlled-fixture-password');await otherPage.locator('#login-form button[type=submit]').click();await otherPage.locator('body.authenticated').waitFor();
    check(await otherPage.evaluate(()=>JSON.parse(localStorage.getItem('setscope-alert-history:user-a')).length),30,'other browser context has independent same-account History');
   }
   const retained=await storage();await confirm(false);check(await storage(),retained,'Clear All cancellation keeps storage');await confirm(true);check(JSON.parse((await storage()).history),[],'Clear All confirmed');check((await storage()).prefs,retained.prefs,'Clear All keeps preferences');check((await storage()).states,retained.states,'Clear All keeps states');
   if(otherContext){check(await otherPage.evaluate(()=>JSON.parse(localStorage.getItem('setscope-alert-history:user-a')).length),30,'Clear All does not delete same-account History in another browser context');await otherContext.close();}
   await page.reload();await page.locator('body.authenticated').waitFor();await nav('profile');await page.locator('#alerts-toggle').click();check(await page.locator('#alerts-history .alert-history-item').count(),0,'History deletion persists refresh');await page.keyboard.press('Escape');
   const aSaved=await storage();await logout();await login('b');await open();check(await values(),['200','','',''],'B sees B preferences');await page.keyboard.press('Escape');await page.locator('#alerts-toggle').click();check(await page.locator('#alerts-history .alert-history-item').count(),1,'A deletion did not delete B history');check(await page.locator('#alerts-history').textContent().then(t=>t.includes('B private history')),true,'B history belongs to B');await page.keyboard.press('Escape');
   await logout();await login('a');await open();check((await values())[0],'100','A preferences restored after A B A');check((await storage()).prefs,aSaved.prefs,'B did not change A preferences');check((await storage()).history,aSaved.history,'B did not change A history');
   check(errors,[],'no runtime errors');check(external.filter(origin=>!['https://fonts.googleapis.com','https://fonts.gstatic.com'].includes(origin)),[],'only existing font attempts aborted; no live API traffic');
   results.push({width,theme,geometry,targets,deleteTarget,clearAll,watchNormal,watchHover,watchFocus,rowGeometry,checks,normalFixtureLogin:true,server:'actual server.js',runtimeErrors:errors,external});
   fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,results},null,2));
   await context.close();
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,results},null,2));console.log(JSON.stringify({checks,matrix:results.length,status:'PASS'}));
 }finally{await browser?.close();server.kill();}
})().catch(error=>{console.error({phase,checks,error:error.stack});process.exitCode=1;});
