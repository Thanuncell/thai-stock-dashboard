'use strict';
// Final acceptance gaps only; reuse the accepted Dev BFF and PostgreSQL adapter.
const fs=require('node:fs');
const {createHash,randomBytes}=require('node:crypto');
const {chromium}=require('playwright');
const {fixture,must}=require('./fixtures/dev-remembered-live.cjs');
const {readVault,writeVault}=require('../scripts/run-v165-dev.cjs');
const errors=require('./fixtures/dev-live-errors.cjs').installSafeDriverErrors();
const arg=name=>process.argv[process.argv.indexOf(name)+1];
(async()=>{
 const f=await fixture();let legacy,remembered,revokedToken,context;
 const observations={emailDelivery:'NOT VERIFIED',reason:'Owner confirmed no test mailbox',signup:null,recovery:null};
 const exposure={};
 const exposureOnly=process.argv.includes('--exposure-only');
 try{
  await f.run('Dev Auth settings and GraphQL stub verified before HTTP tests',async()=>{
   const settings=await f.provider('settings');must(settings.status===200&&settings.body.external?.email===true,'EMAIL_AUTH_UNAVAILABLE');
   observations.emailAutoconfirm=settings.body.mailer_autoconfirm===true;
   const {rows:[extension]}=await f.pool().query("select exists(select 1 from pg_extension where extname='pg_graphql') as installed");
   const {rows}=await f.pool().query("select n.nspname,p.proname,p.prosecdef,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','graphql','graphql_public') and (p.proname ilike '%graphql%' or p.proname='resolve')");
   must(!extension.installed&&rows.length===1&&rows[0].nspname==='graphql_public'&&!rows[0].prosecdef
    &&rows[0].definition.includes('pg_graphql extension is not enabled.')&&!/\b(create extension|execute|insert into|update|delete from)\b/i.test(rows[0].definition),'UNEXPECTED_GRAPHQL_IMPLEMENTATION');
   exposure.extensionInstalled=false;exposure.stubSecurityDefiner=false;exposure.stubOnly=true;
  });
  await f.run('Current exposed schemas and effective grants contain no private session surface',async()=>{
   legacy=await f.rawLogin(0);
   const denied=await f.data('/rest/v1/user_watchlists',legacy.access_token,{headers:{'Accept-Profile':'setscope_private'}});
   must(denied.status===406&&denied.body.code==='PGRST106','PRIVATE_SCHEMA_EXPOSED');
   exposure.schemaError=String(denied.body.message||'');
   const {rows:names}=await f.pool().query("select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by nspname");
   exposure.allowedProfiles=[];exposure.rejectedProfiles=[];exposure.profileResponses=[];
   for(const profile of [...names.map(r=>r.nspname),'pg_catalog','information_schema']){
    const result=await f.data('/rest/v1/user_watchlists?select=user_id&limit=0',legacy.access_token,{headers:{Accept:'application/json','Accept-Profile':profile}});
    exposure.profileResponses.push({profile,http:result.status,code:result.body?.code||null});
    if(profile==='public'){must(result.status===200&&Array.isArray(result.body),'PUBLIC_API_PROFILE_UNAVAILABLE');exposure.allowedProfiles.push(profile);}
    else if(profile==='graphql_public'){
     must(result.status===404&&result.body.code==='PGRST205','GRAPHQL_PROFILE_UNVERIFIED');
     const rpc=await f.data('/rest/v1/rpc/graphql',legacy.access_token,{method:'POST',body:{query:'{ __typename }'},headers:{'Content-Profile':profile}});
     must(rpc.status===200&&rpc.body.errors?.some(e=>e.message==='pg_graphql extension is not enabled.'),'GRAPHQL_STUB_UNVERIFIED');exposure.allowedProfiles.push(profile);
    }
    else{must(result.status===406&&result.body.code==='PGRST106','INTERNAL_SCHEMA_EXPOSED');exposure.rejectedProfiles.push(profile);}
   }
   const schema=await f.data('/rest/v1/',legacy.access_token,{headers:{Accept:'application/openapi+json','Accept-Profile':'public'}});
   exposure.openapi={http:schema.status,available:!!schema.body?.paths};
   const {rows:tables}=await f.pool().query("select n.nspname as schema,c.relname as name,c.relrowsecurity as rls,has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_read,has_table_privilege('anon',c.oid,'SELECT') as anon_read from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','graphql_public','setscope_private') and c.relkind in ('r','v','m')");
   exposure.tables=tables;must(tables.every(t=>t.schema==='setscope_private'?!t.authenticated_read&&!t.anon_read:t.name==='user_watchlists'&&t.rls&&!t.anon_read),'UNEXPECTED_TABLE_GRANTS');
   const {rows:rpc}=await f.pool().query("select n.nspname as schema,p.proname as name,p.prosecdef as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','graphql_public') and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))");
   exposure.callableFunctions=rpc;must(rpc.length===1&&rpc[0].schema==='graphql_public'&&rpc[0].name==='graphql'&&!rpc[0].definer,'UNEXPECTED_PUBLIC_RPC');
  });
  if(!exposureOnly)await f.run('GraphQL HTTP and RPC cannot expose data to anonymous, legacy or revoked JWT',async()=>{
   remembered=await f.login(0);revokedToken=f.tokens(await f.row(remembered)).access;
   must((await f.bff('/api/auth/session/logout',remembered)).status===200,'GRAPHQL_REVOCATION_SETUP');
   const query='{ user_watchlistsCollection { edges { node { user_id } } } remembered_sessionsCollection { edges { node { digest } } } }';
   exposure.http=[];
   for(const [identity,token]of [['anonymous',null],['legacy',legacy.access_token],['revoked',revokedToken]]){
    for(const [route,headers]of [['/graphql/v1',{}],['/rest/v1/rpc/graphql',{'Content-Profile':'graphql_public'}]]){
     const r=await f.data(route,token,{method:'POST',body:{query},headers});
     const disabled=r.status===200&&Array.isArray(r.body.errors)&&r.body.errors.some(e=>String(e.message).includes('pg_graphql extension is not enabled.'));
     must(disabled||[400,401,403,404,406].includes(r.status),'GRAPHQL_CHANNEL_ACTIVE');
     must(!r.body?.data||Object.values(r.body.data).every(v=>v===null),'GRAPHQL_PROTECTED_DATA');
     exposure.http.push({identity,route,status:r.status,disabledResponse:disabled,protectedData:false});
    }
   }
  });
  if(!exposureOnly){
  const executable=arg('--browser');must(executable&&fs.existsSync(executable),'LOCAL_BROWSER_REQUIRED');
  const spki=createHash('sha256').update(f.certificate.publicKey.export({format:'der',type:'spki'})).digest('base64');
  const browser=await chromium.launch({headless:true,executablePath:executable,args:[`--ignore-certificate-errors-spki-list=${spki}`]});
  try{
   context=await browser.newContext();context.setDefaultTimeout(15000);
   await context.route('**/*',route=>[f.origin,f.pub.supabaseUrl].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
   const page=await context.newPage();let logLeak=false;
   const signupPassword=randomBytes(24).toString('base64url');
   const audit=text=>{f.audit(text);if(text.includes(signupPassword)||/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|__Host-setscope-remember=[\w-]+/.test(text))logLeak=true;};
   page.on('console',msg=>audit(msg.text()));page.on('pageerror',error=>audit(error.message));
   const authResponse=(path)=>page.waitForResponse(response=>new URL(response.url()).origin===f.pub.supabaseUrl&&new URL(response.url()).pathname==='/auth/v1/'+path&&response.request().method()==='POST');
   async function openLogin(){await page.goto(f.origin+'/login');await page.waitForFunction(()=>!document.querySelector('#login-form [type=submit]').disabled);}
   await f.run('Registration submits real Dev HTTP and handles its response safely',async()=>{
    await openLogin();await page.locator('#auth-signup-tab').click();
    const email='v165-signup-'+Date.now().toString(36)+'@example.test';
    await page.locator('#signup-form [name=email]').fill(email);await page.locator('#signup-form [name=password]').fill(signupPassword);
    await page.locator('#signup-form [name=confirmPassword]').fill(signupPassword);await page.locator('#signup-form [name=acceptTerms]').check();
    const pending=authResponse('signup');await page.locator('#signup-form [type=submit]').click();const response=await pending;
    let payload;try{payload=await response.json();}catch(_){}
    const code=String(payload?.error_code??payload?.code??'');
    observations.signup={http:response.status(),code:/^[a-z0-9_]+$/i.test(code)?code:null,successfulRegistration:response.ok(),confirmation:'NOT VERIFIED'};
    must([200,400,401,403,422,429].includes(response.status()),'SIGNUP_PROVIDER_UNAVAILABLE');
    await page.waitForFunction(()=>!document.querySelector('#signup-form [type=submit]').disabled);
    must(await page.locator('#auth-message').evaluate(el=>!!el.textContent.trim()),'SIGNUP_FEEDBACK_MISSING');
    must(await page.evaluate(()=>!Object.values(localStorage).some(v=>/access_token|refresh_token/.test(v))),'SIGNUP_PERSISTENT_TOKEN');
    // Preserve only an actually-created synthetic account credential in DPAPI.
    if(response.ok()&&payload?.user?.id){const vault=arg('--vault'),value=readVault(vault);value.acceptanceSignupAccounts=[...(value.acceptanceSignupAccounts||[]),{email,password:signupPassword}];writeVault(vault,value);}
   });
   await f.run('Forgot Password submits real Dev HTTP and handles its response safely',async()=>{
    await openLogin();await page.locator('#forgot-password-button').click();await page.locator('#forgot-password-form [name=email]').fill(f.accounts[0].email);
    const pending=authResponse('recover');await page.locator('#forgot-password-form [type=submit]').click();const response=await pending;
    let payload;try{payload=await response.json();}catch(_){}
    const code=String(payload?.error_code??payload?.code??'');
    observations.recovery={http:response.status(),code:/^[a-z0-9_]+$/i.test(code)?code:null,requestAccepted:response.ok(),emailReceived:'NOT VERIFIED',linkAndPasswordReset:'NOT VERIFIED'};
    must([200,400,401,403,422,429].includes(response.status()),'RECOVERY_PROVIDER_UNAVAILABLE');
    await page.waitForFunction(()=>!document.querySelector('#forgot-password-form [type=submit]').disabled);
    must(await page.locator('#auth-message').evaluate(el=>!!el.textContent.trim()),'RECOVERY_FEEDBACK_MISSING');
    must(await page.locator('#app-shell').getAttribute('aria-hidden')==='true','RECOVERY_AUTHENTICATION_BYPASS');
   });
   await f.run('Remember OFF actual browser token refresh preserves Profile and Watchlist',async()=>{
    await openLogin();await page.locator('#login-form [name=email]').fill(f.accounts[0].email);await page.locator('#login-form [name=password]').fill(f.accounts[0].password);
    must(!(await page.locator('#remember-device').isChecked()),'REMEMBER_OPT_IN_CHANGED');await page.locator('#login-form [type=submit]').click();await page.locator('#app-shell').waitFor({state:'visible'});
    const before=await page.evaluate(()=>{const session=JSON.parse(sessionStorage.getItem('setscope-auth-session-v1'));const refresh=session.refresh_token;session.expires_at=Date.now()-1000;sessionStorage.setItem('setscope-auth-session-v1',JSON.stringify(session));return refresh;});
    const pending=page.waitForResponse(response=>response.url().includes('/auth/v1/token?grant_type=refresh_token')&&response.request().method()==='POST');
    await page.reload();must((await pending).status()===200,'LEGACY_REFRESH_FAILED');await page.locator('#app-shell').waitFor({state:'visible'});
    const after=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('setscope-auth-session-v1')));f.legacy.push(after);
    must(after.refresh_token&&after.refresh_token!==before,'LEGACY_REFRESH_NOT_ROTATED');
    must(await page.evaluate(async()=> (await setscopeAuth.authorizedFetch('/api/watchlists')).status)===200,'LEGACY_REFRESH_WATCHLIST_FAILED');
    must(await page.evaluate(email=>setscopeAuth.user.email===email,f.accounts[0].email),'LEGACY_REFRESH_PROFILE_FAILED');
    must(!(await context.cookies(f.origin)).some(c=>c.name==='__Host-setscope-remember'),'REMEMBER_OFF_PERSISTENT_COOKIE');
    const logout=authResponse('logout');await page.locator('#profile-logout-button').evaluate(el=>el.click());must((await logout).ok(),'LEGACY_LOGOUT_PROVIDER_FAILED');
    await page.locator('#login-form').waitFor({state:'visible'});must(await page.evaluate(()=>sessionStorage.getItem('setscope-auth-session-v1')===null),'LEGACY_LOGOUT_STORAGE');
   });
   await f.run('Final browser and BFF logs contain no tokens or cookies',async()=>must(!logLeak&&f.logsSafe()&&!errors.failed(),'FINAL_LOG_REDACTION_FAILED'));
  }finally{await context?.close();await browser.close();}
  }
 }finally{
  await f.close();f.persist();const report=JSON.parse(fs.readFileSync(f.evidence,'utf8'));
  Object.assign(report,{scope:'Final acceptance gaps only',email:observations,apiExposure:exposure});fs.writeFileSync(f.evidence,JSON.stringify(report,null,2));
 }
 const failed=f.results.filter(r=>r.status==='FAIL').length;console.log(JSON.stringify({pass:f.results.filter(r=>r.status==='PASS').length,fail:failed,emailDelivery:observations.emailDelivery}));if(failed)process.exitCode=1;errors.dispose();
})().catch(()=>{console.error('Final Dev acceptance could not complete; secret details suppressed');process.exitCode=1;});
