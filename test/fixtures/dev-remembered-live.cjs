'use strict';
// Explicit Dev-only harness. Secrets remain in DPAPI or process memory.
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const {createHash,createDecipheriv,X509Certificate}=require('node:crypto');
const {Pool}=require('pg');
const {readVault}=require('../../scripts/run-v165-dev.cjs');
const {createPostgresRememberedSessionStore}=require('../../server/remembered-session-postgres');
const {createDevRememberedRuntime,DEV_PROJECT,DEV_URL}=require('../../server/dev-remembered-runtime');
const must=(condition,code)=>{if(!condition)throw Error(code);};

async function fixture(){
  must(process.argv.includes('--dev-tests-only')&&process.env.NODE_ENV!=='production','DEV_TEST_FLAG_REQUIRED');
  const arg=name=>process.argv[process.argv.indexOf(name)+1];
  const vault=arg('--vault'),publicFile=arg('--public-config'),evidence=arg('--evidence');
  must(path.isAbsolute(vault)&&path.isAbsolute(publicFile)&&path.isAbsolute(evidence),'EXPLICIT_EXTERNAL_PATHS_REQUIRED');
  const secrets=readVault(vault),pub=JSON.parse(fs.readFileSync(publicFile,'utf8'));
  must(pub.projectId===DEV_PROJECT&&pub.supabaseUrl===DEV_URL,'DEV_TARGET_REQUIRED');
  const accounts=secrets.testAccounts;
  must(accounts?.length===2&&accounts.every((a,i)=>a.email===`v165-${i?'b':'a'}-01@example.test`&&a.password),'SYNTHETIC_ACCOUNTS_REQUIRED');
  const secretValues=new Set([secrets.database?.password,secrets.encryptionKey,secrets.tls.passphrase,...accounts.map(a=>a.password)].filter(Boolean));
  const originalLog=console.log,originalError=console.error,originalInfo=console.info,originalWarn=console.warn;let secretLeak=false;
  function audit(value){if([...secretValues].some(secret=>String(value).includes(secret))||/__Host-setscope-remember=[\w-]+|Bearer eyJ/.test(String(value)))secretLeak=true;}
  console.log=(...args)=>{const text=args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' ');audit(text);if(!secretLeak&&/^(PASS|FAIL) /.test(text))originalLog(text);};
  console.error=(...args)=>{audit(args.map(String).join(' '));};
  console.info=(...args)=>{audit(args.map(String).join(' '));};console.warn=(...args)=>{audit(args.map(String).join(' '));};
  for(const key of Object.keys(process.env))if(/^SUPABASE_|^SETSCOPE_|^PG|^DATABASE_URL$|^TRUST_PROXY$/.test(key))delete process.env[key];
  delete process.env.DEBUG;delete process.env.PWDEBUG;
  Object.assign(process.env,{SUPABASE_URL:DEV_URL,SUPABASE_ANON_KEY:pub.publishableKey,NODE_ENV:'development',HOST:'127.0.0.1'});
  const {handle}=require('../../server');
  const origin='https://localhost:4175';
  const state={outage:false,clock:null,holdRefresh:null,holdResponse:null,refreshCalls:0};
  class GuardedPool extends Pool{
    query(...args){if(state.outage)return Promise.reject(Error('TEST_TRANSPORT_UNAVAILABLE'));return super.query(...args);}
    connect(...args){if(state.outage)return Promise.reject(Error('TEST_TRANSPORT_UNAVAILABLE'));return super.connect(...args);}
  }
  const rawFetch=globalThis.fetch;
  const providerFetch=async(input,init)=>{
    const url=new URL(input);must(url.origin===DEV_URL,'DEV_UPSTREAM_ONLY');
    if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='refresh_token'){
      state.refreshCalls++;const response=await rawFetch(input,init);
      if(state.holdRefresh)await state.holdRefresh();
      return response;
    }
    return rawFetch(input,init);
  };
  const send=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});res.end(JSON.stringify(body));};
  let runtime;
  async function start(enable=true){
    runtime=await createDevRememberedRuntime({config:{devTestsOnly:true,nodeEnv:'development',projectId:DEV_PROJECT,supabaseUrl:DEV_URL,
      publishableKey:pub.publishableKey,origin,testEmails:accounts.map(a=>a.email),enableRemember:enable,guardVerifiedForDevTests:enable},
    secrets,Pool:GuardedPool,send,fetchImpl:providerFetch,now:()=>state.clock??Date.now()});
  }
  await start();
  const existingDigests=new Set((await runtime.pool.query('select digest from setscope_private.remembered_sessions')).rows.map(r=>r.digest));
  const server=https.createServer({pfx:Buffer.from(secrets.tls.pfx,'base64'),passphrase:secrets.tls.passphrase,minVersion:'TLSv1.2'},async(req,res)=>{
    const url=new URL(req.url,origin);
    if(state.holdResponse&&url.searchParams.has('hold-live-test'))await state.holdResponse();
    if(url.pathname.startsWith('/api/')&&!['/api/auth-config','/api/watchlists','/api/screener'].includes(url.pathname)
      &&!url.pathname.startsWith('/api/auth/session/'))return send(res,503,{error:'DEV_AUTH_TEST_SCOPE_ONLY'});
    handle(req,res,runtime.auth).catch(()=>{if(!res.headersSent)send(res,503,{error:'DEV_REQUEST_UNAVAILABLE'});else res.end();});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4175,'127.0.0.1',resolve);});
  const certificate=new X509Certificate(fs.readFileSync(vault+'.crt'));
  const logs=[],results=[],sessions=[],legacy=[];
  function record(method,route,status,body){logs.push({method,route:route.split('?')[0],status,...(Array.isArray(body)?{rows:body.length}:{}),
    ...(typeof body?.code==='string'&&/^[A-Z0-9_]+$/.test(body.code)?{code:body.code}:{})});}
  async function bff(route,{method='POST',body,cookie,generation,bearer,headers={}}={}){
    const requestHeaders={origin,'x-setscope-request':'1',...(cookie?{cookie}:{}),...(generation?{'x-setscope-session':generation}:{}),
      ...(bearer?{authorization:`Bearer ${bearer}`} :{}),...(body?{'content-type':'application/json'}:{}),...headers};
    const result=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'localhost',family:4,port:4175,path:route,method,headers:requestHeaders,
        ca:certificate.toString(),rejectUnauthorized:true,minVersion:'TLSv1.2'},res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let json=null;try{json=JSON.parse(Buffer.concat(chunks));}catch(_){}
          resolve({status:res.statusCode,body:json,headers:res.headers});});});
      req.on('error',()=>reject(Error('BFF_HTTPS_UNAVAILABLE')));req.setTimeout(12000,()=>req.destroy());
      if(body)req.write(JSON.stringify(body));req.end();
    });record(method,route,result.status,result.body);return result;
  }
  async function data(route,token,{method='GET',body,headers={}}={}){
    const response=await rawFetch(`${DEV_URL}${route}`,{method,headers:{apikey:pub.publishableKey,...(token?{Authorization:`Bearer ${token}`} :{}),
      ...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
    let json=null;try{json=await response.json();}catch(_){}record(method,route,response.status,json);return {status:response.status,body:json};
  }
  async function provider(path,token,body){return data('/auth/v1/'+path,token,{method:body||path.startsWith('logout')?'POST':'GET',body});}
  async function rawLogin(index=0){const r=await provider('token?grant_type=password',null,accounts[index]);must(r.status===200,'LIVE_PASSWORD_LOGIN_FAILED');
    must((await provider('user',r.body.access_token)).body?.id===r.body.user.id,'LIVE_USER_VERIFICATION_FAILED');
    secretValues.add(r.body.access_token);secretValues.add(r.body.refresh_token);legacy.push(r.body);return r.body;}
  async function login(index=0,previous){const response=await bff('/api/auth/session/login',{body:{...accounts[index],rememberDevice:true},...previous});
    must(response.status===200,'REMEMBERED_LOGIN_FAILED');const set=response.headers['set-cookie']?.[0];must(!!set,'COOKIE_MISSING');
    const cookie=set.split(';')[0],digest=createHash('sha256').update(cookie.slice(cookie.indexOf('=')+1)).digest('hex');
    secretValues.add(cookie);secretValues.add(cookie.split('=')[1]);
    const session={cookie,digest,generation:response.body.generation,user:response.body.user,cookieHeader:set};sessions.push(session);return session;}
  async function row(session){const {rows:[r]}=await runtime.pool.query('select * from setscope_private.remembered_sessions where digest=$1',[session.digest]);return r;}
  function tokens(row){const bytes=Buffer.from(row.encrypted,'base64url');const decipher=createDecipheriv('aes-256-gcm',Buffer.from(secrets.encryptionKey,'base64'),bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(row.digest));decipher.setAuthTag(bytes.subarray(12,28));const result=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]));
    secretValues.add(result.access);secretValues.add(result.refresh);return result;}
  async function expireAccess(session){await runtime.pool.query('update setscope_private.remembered_sessions set access_expires_at_ms=$2 where digest=$1',[session.digest,Date.now()-1000]);}
  async function run(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){
    const code=/^[A-Z][A-Z0-9_]{1,75}$/.test(e.message||'')?e.message:'SAFE_TEST_FAILURE';results.push({name,status:'FAIL',code});console.log('FAIL '+name+' '+code);}}
  function notRun(name,reason){results.push({name,status:'NOT RUN',reason});}
  return {origin,secrets,accounts,pub,state,certificate,logs,results,sessions,legacy,evidence,bff,data,provider,rawLogin,login,row,tokens,expireAccess,run,notRun,
    pool:()=>runtime.pool,audit,logsSafe:()=>!secretLeak,restart:async(enable=true)=>{await runtime.close();await start(enable);},
    close:async()=>{state.outage=false;state.clock=null;for(const s of sessions){try{await bff('/api/auth/session/logout',s);}catch(_){} }
      for(const s of legacy){try{await provider('logout?scope=local',s.access_token);}catch(_){} }
      const created=(await runtime.pool.query('select * from setscope_private.remembered_sessions where revoked_at_ms is null')).rows
        .filter(r=>!existingDigests.has(r.digest)&&accounts.some(a=>a.email===r.user_summary?.email));
      const cleanupStore=createPostgresRememberedSessionStore(runtime.pool);
      for(const r of created){try{await provider('logout?scope=local',tokens(r).access);}catch(_){}await cleanupStore.revoke(r.digest,Date.now());}
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();console.log=originalLog;console.error=originalError;console.info=originalInfo;console.warn=originalWarn;},
    persist:()=>fs.writeFileSync(evidence,JSON.stringify({environment:'Supabase Dev only',projectId:DEV_PROJECT,results,http:logs},null,2))};
}
module.exports={fixture,must};
