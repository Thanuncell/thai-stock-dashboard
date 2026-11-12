'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');
const {must}=require('./fixtures/dev-remembered-live.cjs');

module.exports=async function browserTests(f){
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'setscope-v165-dev-browser-'));
 const executable=process.argv[process.argv.indexOf('--browser')+1];
 must(executable&&fs.existsSync(executable),'LOCAL_BROWSER_REQUIRED');
 const spki=createHash('sha256').update(f.certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
 const options={headless:true,executablePath:executable,args:[`--ignore-certificate-errors-spki-list=${spki}`]};
 let device,otherDevice,page,other;
 async function routes(context){
  context.setDefaultTimeout(15000);
  context.on('page',p=>{p.on('console',msg=>f.audit(msg.text()));p.on('pageerror',err=>f.audit(err.message));});
  // Auth, real BFF and all application assets use actual HTTPS. External market
  // widgets/fonts are outside this security test and receive no requests.
  await context.route('**/*',route=>{
   const origin=new URL(route.request().url()).origin;
   return [f.origin,f.pub.supabaseUrl].includes(origin)?route.continue():route.abort();
  });
 }
 async function launch(){device=await chromium.launchPersistentContext(profile,options);await routes(device);return device;}
 async function open(context){const p=await context.newPage();await p.goto(f.origin+'/login');await p.waitForFunction(()=>!document.querySelector('#login-form [type=submit]').disabled);return p;}
 async function signIn(p,index,remember){await p.locator('#login-form [name=email]').fill(f.accounts[index].email);await p.locator('#login-form [name=password]').fill(f.accounts[index].password);
  await p.locator('#remember-device').setChecked(remember);await p.locator('#login-form [type=submit]').click();
  await p.waitForFunction(email=>window.setscopeAuth?.user?.email===email,f.accounts[index].email);await p.locator('#app-shell').waitFor({state:'visible'});}
 async function signOut(p){await p.locator('#profile-logout-button').evaluate(el=>el.click());await p.locator('#login-form').waitFor({state:'visible'});}
 async function privateStatus(p){return p.evaluate(async()=> (await setscopeAuth.authorizedFetch('/api/watchlists')).status);}
 async function remembered(p,index){await p.waitForFunction(email=>window.setscopeAuth?.user?.email===email,f.accounts[index].email);
  must(await p.evaluate(()=>sessionStorage.getItem('setscope-auth-session-v1')===null),'REMEMBERED_WEB_STORAGE_TOKEN');
  must(await p.evaluate(()=>!Object.values(localStorage).some(value=>/access_token|refresh_token|__Host-setscope-remember/.test(value))),'PERSISTENT_AUTH_TOKEN');
  must(await p.evaluate(()=>!document.cookie.includes('setscope-remember')),'HTTPONLY_COOKIE_READABLE');must(await privateStatus(p)===200,'BROWSER_PRIVATE_API_DENIED');}
 try{
  await f.run('Browser real HTTPS startup, responsive and Light/Dark login UI',async()=>{
   await launch();page=await open(device);
   for(const width of [320,375,390,768,1024,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:950});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    const layout=await page.evaluate(()=>{const checkbox=document.querySelector('#remember-device'),forgot=document.querySelector('#forgot-password-button');
     const a=checkbox.getBoundingClientRect(),b=forgot.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,checked:checkbox.checked,overlap:a.right>b.left,row:Math.abs(a.y-b.y)<30};});
    must(!layout.overflow&&!layout.checked&&!layout.overlap&&layout.row,'RESPONSIVE_LOGIN_LAYOUT');
   }
   await page.setViewportSize({width:1024,height:900});await page.locator('#login-form [name=email]').focus();
   await page.keyboard.press('Tab');must(await page.locator('#login-form [name=password]').evaluate(el=>el===document.activeElement),'PASSWORD_KEYBOARD_FOCUS');
   await page.keyboard.press('Tab');must(await page.locator('#remember-device').evaluate(el=>el===document.activeElement),'REMEMBER_KEYBOARD_FOCUS');
  });
  await f.run('Browser Remember ON and actual Watchlist application initialization',async()=>{
   await signIn(page,0,true);await remembered(page,0);const cookies=await device.cookies(f.origin);
   const cookie=cookies.find(c=>c.name==='__Host-setscope-remember');must(cookie?.secure&&cookie.httpOnly&&cookie.sameSite==='Lax'&&cookie.expires>Date.now()/1000,'BROWSER_COOKIE_FLAGS');
  });
  await f.run('Browser multi-tab and independent device sessions',async()=>{
   const tab=await open(device);await remembered(tab,0);
   otherDevice=await device.browser().newContext();await routes(otherDevice);other=await open(otherDevice);await signIn(other,0,true);await remembered(other,0);
   await signOut(page);await remembered(other,0);await signIn(page,0,true);await signOut(other);await remembered(page,0);await tab.close();
  });
  await f.run('Restore after actual browser profile close and reopen',async()=>{
   await otherDevice.close();otherDevice=null;await device.close();device=null;await launch();page=await open(device);await remembered(page,0);
  });
  await f.run('Cross-tab logout, stale response protection and account A to B to A',async()=>{
   const tab=await open(device);await remembered(tab,0);
   let arrived,release;const waiting=new Promise(r=>arrived=r),held=new Promise(r=>release=r);
   // Delay only delivery of an already-authorized response, not the auth check.
   await tab.route('**/api/watchlists?hold-live-browser=1',async route=>{
    try{const response=await f.bff('/api/watchlists?hold-live-browser=1',{method:'GET',headers:await route.request().allHeaders()});
     arrived();await held;await route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(response.body)});
    }catch(_){await route.abort().catch(()=>{});}
   });
   const stale=tab.evaluate(()=>setscopeAuth.authorizedFetch('/api/watchlists?hold-live-browser=1').then(r=>r.status,e=>e.code));
   const timer=new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('STALE_RESPONSE_SETUP_TIMEOUT')),12000);t.unref();});await Promise.race([waiting,timer]);
   try{await signOut(page);await tab.locator('#login-form').waitFor({state:'visible'});}finally{release();}
   must(await stale==='STALE_SESSION','STALE_PRIVATE_RESPONSE_ACCEPTED');
   await signIn(page,1,true);await remembered(page,1);must(await tab.evaluate(()=>setscopeAuth.user===null),'CROSS_TAB_ACCOUNT_LEAK');
   await signOut(page);await signIn(page,0,true);await remembered(page,0);await tab.close();
  });
  await f.run('Browser Remember OFF, legacy reload/logout and no persistent auth token',async()=>{
   await signOut(page);await signIn(page,0,false);
   must(await page.evaluate(()=>!!sessionStorage.getItem('setscope-auth-session-v1')),'LEGACY_SESSION_STORAGE_MISSING');
   must(!(await device.cookies(f.origin)).some(c=>c.name==='__Host-setscope-remember'),'REMEMBER_OFF_COOKIE');
   await page.reload();await page.locator('#app-shell').waitFor({state:'visible'});must(await privateStatus(page)===200,'LEGACY_RELOAD_FAILED');await signOut(page);
   must(await page.evaluate(()=>sessionStorage.getItem('setscope-auth-session-v1')===null),'LEGACY_LOGOUT_STORAGE');
  });
  await f.run('Registration and Forgot Password UI preserve navigation and focus',async()=>{
   await page.locator('#auth-signup-tab').click();await page.locator('#signup-form').waitFor({state:'visible'});
   must(await page.locator('#signup-form [name=password]').getAttribute('minlength')==='8','REGISTRATION_CONTRACT_CHANGED');
   await page.locator('#auth-login-tab').click();await page.locator('#forgot-password-button').click();await page.locator('#forgot-password-form').waitFor({state:'visible'});
   must(await page.locator('#forgot-password-form [name=email]').isVisible(),'RECOVERY_FORM_MISSING');
  });
 }finally{
  await otherDevice?.close().catch(()=>{});await device?.close().catch(()=>{});
  const resolved=path.resolve(profile);must(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'setscope-v165-dev-browser-')&&!fs.lstatSync(resolved).isSymbolicLink(),'PROFILE_CLEANUP_SCOPE');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
};
