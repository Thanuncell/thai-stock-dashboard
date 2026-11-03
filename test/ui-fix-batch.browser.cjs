'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require(process.env.SETSCOPE_PLAYWRIGHT_MODULE||'playwright');
const {mockRequest}=require('./account-isolation.browser.cjs');
let checks=0,phase='setup';
const recoveryMessage='โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่';
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
(async()=>{
 const root=path.resolve(__dirname,'..'),server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  const file=path.resolve(root,['/','/login','/register'].includes(pathname)?'index.html':pathname.slice(1));
  if(!file.startsWith(root+path.sep))return res.writeHead(403).end();
  fs.readFile(file,(error,data)=>{if(error)return res.writeHead(404).end();res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream'});res.end(data);});
 });
 let browser;
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.SETSCOPE_BROWSER_EXECUTABLE||undefined});
  const stamp='2026-10-30T07:21:09.000Z',rows=Array.from({length:25},(_,i)=>({symbol:'UNIT'+(i+1),rank:i+1,last:10+i,change:0.1,changePercent:1,turnoverMillion:100-i,volumeThousand:10+i}));
  for(const width of [320,390,1366])for(const theme of ['light','dark']){
   const context=await browser.newContext({viewport:{width,height:900}}),state={getOwners:[],putOwners:[],holdNextAPut:false,holdNextLogout:false,holdNextAGet:false,holdNextAMarket:false};
   let count=20,clock=stamp,stale=false,recoverMode='success';const errors=[],authCalls=[],overviewCalls=[];
   await context.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin!==base&&url.origin!=='https://isolation-test.supabase.co')return route.abort();
    const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    if(url.origin==='https://isolation-test.supabase.co'&&url.pathname==='/auth/v1/recover'){
     authCalls.push({path:url.pathname,redirect:url.searchParams.get('redirect_to')});
     if(recoverMode==='network')return route.abort('failed');
     if(recoverMode==='server')return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({msg:'private-provider-detail'})});
     return json(req.postDataJSON().email.startsWith('absent@')?{}:{message:'private-existing-account'});
    }
    if(url.origin===base&&url.pathname==='/api/market-overview'){
     overviewCalls.push(url.search);
     return json({source:'SETTRADE',fetchedAt:clock,dataState:stale?'stale':'delayed',stale,indices:[],breadth:[],activeValue:rows.slice(0,count),fieldStatus:{activeValue:{state:stale?'LKG':'PASS',sourceUpdatedAt:stamp,quantityStatus:'HTML_LABELLED'}},tfex:{},nvdr:{},foreign:{}});
    }
    return mockRequest(route,base,state);
   });
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.name));
   await page.addInitScript(({theme})=>{localStorage.setItem('setscope-theme',theme);sessionStorage.setItem('setscope-auth-return-v1','/#profile');sessionStorage.setItem('setscope-navigation-fallback-v1',JSON.stringify({route:'profile'}));},{theme});
   phase='login-default';await page.goto(base+'/login');await page.waitForSelector('#login-form');
   await page.locator('#login-form input[name=email]').fill('a@example.test');await page.locator('#login-form input[name=password]').fill('synthetic-ui-fixture');await page.locator('#login-form button[type=submit]').click();
   await page.waitForSelector('body.authenticated');check(new URL(page.url()).hash,'#overview','stale Profile state must not win over normal login');
   phase='overview';await page.waitForSelector('#active-value-content tbody tr');
   const source=await page.locator('#settrade-updated').textContent();
   check(source.startsWith('แหล่งข้อมูล SETTRADE · อัปเดตล่าสุด: '),true);
   check(source.includes('14:21:09'),true,'timestamp comes from fixture response, not browser clock');
   check((await page.locator('#market-data-overview').textContent()).match(/อัปเดตล่าสุด/g)?.length,1,'overview update label appears once');
   check((await page.locator('#market-data-overview').textContent()).match(/14:21:09/g)?.length,1,'the same timestamp is not repeated below Most Active');
   check(await page.locator('#settrade-updated').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getClientRects().length;}),1,'source and timestamp occupy one line');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'real timestamp fits narrow viewport');
   check(await page.locator('#active-value-content tbody tr').count(),5);
   const symbols=()=>page.locator('#active-value-content tbody tr td:first-child b').allTextContents();
   check(await symbols(),rows.slice(0,5).map(row=>row.symbol));
   if(process.env.SETSCOPE_UI_SCREENSHOT_DIR&&theme==='light'&&[390,1366].includes(width))await page.locator('#market-data-overview').screenshot({path:path.join(process.env.SETSCOPE_UI_SCREENSHOT_DIR,'overview-'+width+'.png')});
   const toggle=page.locator('#toggle-active-value'),before=overviewCalls.length;
   await toggle.focus();await page.keyboard.press('Enter');check(await toggle.textContent(),'แสดงน้อยลง');check(await toggle.getAttribute('aria-expanded'),'true');
   check(await symbols(),rows.slice(0,20).map(row=>row.symbol));check(overviewCalls.length,before,'expand is local UI only');
   await page.keyboard.press('Space');check(await toggle.textContent(),'แสดงทั้งหมด');check(await symbols(),rows.slice(0,5).map(row=>row.symbol));
   for(const n of [3,0,25]){
    count=n;await page.locator('#refresh-market-data').click();await page.waitForFunction(()=>!document.querySelector('#refresh-market-data').disabled);
    check(await page.locator('#active-value-content tbody tr').count(),Math.min(n,5));check(await toggle.isVisible(),n>5);
    if(n>5){await toggle.click();check(await symbols(),rows.slice(0,20).map(row=>row.symbol),'existing API display maximum retained');}
   }
   stale=true;await page.locator('#refresh-market-data').click();await page.waitForFunction(()=>!document.querySelector('#refresh-market-data').disabled);
   check((await page.locator('#settrade-updated').textContent()).endsWith('ข้อมูลเก่า'),true,'saved data is never presented as fresh');
   check((await page.locator('#active-value-content .market-source-caption').textContent()).includes('ข้อมูลเก่า'),true);
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'saved-data timestamp also fits narrow viewport');
   clock='2026-10-30T08:00:00.000Z';await page.locator('#refresh-market-data').click();await page.waitForFunction(()=>!document.querySelector('#refresh-market-data').disabled);
   check((await page.locator('#settrade-updated').textContent()).includes('15:00:00'),true);
   check((await page.locator('#active-value-content .market-source-caption').textContent()).includes('14:21:09'),true,'different source as-of remains visible for saved data');
   stale=false;clock='invalid';await page.locator('#refresh-market-data').click();await page.waitForFunction(()=>!document.querySelector('#refresh-market-data').disabled);
   check(await page.locator('#settrade-updated').textContent(),'แหล่งข้อมูล SETTRADE · อัปเดตล่าสุด: —');
   phase='logout';await page.locator('#user-avatar').click();await page.waitForSelector('#profile-page:not(.workspace-hidden)');
   check(await page.locator('#profile-recovery-button').textContent(),'รับรหัสผ่านใหม่');
   await page.locator('#profile-recovery-button').click();await page.waitForFunction(text=>document.querySelector('#profile-message').textContent===text,recoveryMessage);
   check(await page.locator('#profile-message').textContent(),recoveryMessage);
   check(authCalls.length,1);check(authCalls[0].redirect,base);
   await page.locator('#profile-logout-button').click();await page.waitForSelector('#login-form');
   await page.locator('#forgot-password-button').click();check(await page.locator('#forgot-password-form button[type=submit]').textContent(),'รับรหัสผ่านใหม่');
   await page.locator('#forgot-password-form input[name=email]').fill('a@example.test');await page.locator('#forgot-password-form button[type=submit]').click();
   await page.waitForFunction(text=>document.querySelector('#auth-message').textContent===text,recoveryMessage);check(authCalls.length,2);check(authCalls[1].redirect,base);
   check(await page.locator('#auth-message').textContent(),recoveryMessage,'existing email receives neutral success');
   await page.locator('#forgot-password-form input[name=email]').fill('absent@example.test');await page.locator('#forgot-password-form button[type=submit]').click();
   await page.waitForFunction(text=>document.querySelector('#auth-message').textContent===text&&!document.querySelector('#forgot-password-form button[type=submit]').disabled,recoveryMessage);
   check(authCalls.length,3);check(await page.locator('#auth-message').textContent(),recoveryMessage,'absent email receives identical neutral success');
   for(const failure of ['network','server']){
    recoverMode=failure;await page.locator('#forgot-password-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#auth-message').textContent==='ส่งอีเมลไม่สำเร็จ กรุณารอสักครู่แล้วลองอีกครั้ง');
    check(await page.locator('#auth-message').textContent(),'ส่งอีเมลไม่สำเร็จ กรุณารอสักครู่แล้วลองอีกครั้ง');
    check(await page.locator('#forgot-password-form button[type=submit]').isEnabled(),true);
   }
   await page.locator('#auth-login-tab').click();await page.locator('#login-form input[name=email]').fill('b@example.test');await page.locator('#login-form input[name=password]').fill('synthetic-ui-fixture');
   await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('body.authenticated');check(new URL(page.url()).hash,'#overview','Profile logout followed by another account starts Overview');
   check(await page.locator('#profile-email').textContent(),'b@example.test');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);check(errors,[]);
   await context.close();console.log(JSON.stringify({width,theme,result:'PASS'}));
  }
  console.log(JSON.stringify({uiFixBatchBrowser:'PASS',checks,liveProviderRequests:0}));
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(JSON.stringify({uiFixBatchBrowser:'FAIL',phase,name:error.name,message:error.message}));process.exitCode=1;});
