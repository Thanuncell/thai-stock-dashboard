'use strict';
const fs=require('node:fs');
const https=require('node:https');
const {spawn}=require('node:child_process');
const {createHash,createDecipheriv,X509Certificate}=require('node:crypto');
const {Client}=require('pg');
const {readVault}=require('../scripts/run-v165-dev.cjs');
const {createPostgresRememberedSessionStore}=require('../server/remembered-session-postgres');
const {DEV_PROJECT,DEV_URL}=require('../server/dev-remembered-runtime');
const guard=require('./fixtures/dev-live-errors.cjs').installSafeDriverErrors();
const must=(condition,code)=>{if(!condition)throw Error(code);};
const value=name=>process.argv[process.argv.indexOf(name)+1];
let child,digest,secret,client;
(async()=>{
 must(process.argv.includes('--dev-tests-only'),'DEV_TEST_FLAG_REQUIRED');
 const vault=value('--vault'),publicFile=value('--public-config'),evidence=value('--evidence');
 secret=readVault(vault);const pub=JSON.parse(fs.readFileSync(publicFile,'utf8'));
 must(pub.projectId===DEV_PROJECT&&pub.supabaseUrl===DEV_URL&&secret.testAccounts?.[0]?.email==='v165-a-01@example.test','DEV_TEST_TARGET_REQUIRED');
 const certificate=new X509Certificate(fs.readFileSync(vault+'.crt')).toString(),origin='https://localhost:4175';
 let output='';
 async function stop(){if(!child)return;const current=child;child=null;if(current.exitCode!==null)return;await new Promise(resolve=>{current.once('exit',resolve);current.kill();});}
 async function start(){child=spawn(process.execPath,['scripts/run-v165-dev.cjs','--dev-tests-only','--vault',vault,'--public-config',publicFile,
   '--test-emails','v165-a-01@example.test,v165-b-01@example.test','--enable-remember','--guard-verified-for-dev-tests'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RESTART_START_TIMEOUT')),15000);
    child.once('exit',()=>{clearTimeout(timer);reject(Error('RESTART_START_FAILED'));});
    child.stderr.on('data',chunk=>{output+=chunk;});child.stdout.on('data',chunk=>{output+=chunk;if(chunk.toString().includes('Dev BFF ready')){clearTimeout(timer);resolve();}});});}
 async function request(route,{method='POST',body,cookie,generation,bearer}={}){return new Promise((resolve,reject)=>{
  const req=https.request({hostname:'localhost',family:4,port:4175,path:route,method,ca:certificate,rejectUnauthorized:true,minVersion:'TLSv1.2',
   headers:{origin,'x-setscope-request':'1',...(cookie?{cookie}:{}),...(generation?{'x-setscope-session':generation}:{}),
    ...(bearer?{authorization:`Bearer ${bearer}`} :{}),...(body?{'content-type':'application/json'}:{})}},res=>{
     const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{let json;try{json=JSON.parse(Buffer.concat(chunks));}catch(_){}
      resolve({status:res.statusCode,body:json,headers:res.headers});});});
  req.on('error',()=>reject(Error('RESTART_HTTPS_FAILED')));req.setTimeout(10000,()=>req.destroy());if(body)req.write(JSON.stringify(body));req.end();});}
 try{
  await start();const login=await request('/api/auth/session/login',{body:{...secret.testAccounts[0],rememberDevice:true}});
  must(login.status===200,'RESTART_LOGIN_FAILED');const cookie=login.headers['set-cookie'][0].split(';')[0],generation=login.body.generation;
  digest=createHash('sha256').update(cookie.slice(cookie.indexOf('=')+1)).digest('hex');
  const d=secret.database;client=new Client({...d,ssl:{ca:d.ca,rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeoutMillis:7000});await client.connect();
  const {rows:[row]}=await client.query('select digest,encrypted from setscope_private.remembered_sessions where digest=$1',[digest]);
  const bytes=Buffer.from(row.encrypted,'base64url'),decipher=createDecipheriv('aes-256-gcm',Buffer.from(secret.encryptionKey,'base64'),bytes.subarray(0,12));
  decipher.setAAD(Buffer.from(digest));decipher.setAuthTag(bytes.subarray(12,28));const tokens=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]));
  await client.end();client=null;
  await stop();must(readVault(vault).encryptionKey===secret.encryptionKey,'RESTART_KEY_CHANGED');await start();
  must((await request('/api/auth/session/restore',{cookie})).status===200,'PROCESS_RESTORE_FAILED');
  must((await request('/api/watchlists',{method:'GET',cookie,generation})).status===200,'PROCESS_WATCHLIST_FAILED');
  must((await request('/api/auth/session/logout',{cookie,generation})).status===200,'PROCESS_LOGOUT_FAILED');
  await stop();await start();
  must((await request('/api/auth/session/restore',{cookie})).status===401,'PROCESS_REVIVED_COOKIE');
  must((await request('/api/watchlists',{method:'GET',bearer:tokens.access})).status===401,'PROCESS_REVIVED_BEARER');
  const rest=await fetch(DEV_URL+'/rest/v1/user_watchlists?select=user_id',{headers:{apikey:pub.publishableKey,Authorization:`Bearer ${tokens.access}`},signal:AbortSignal.timeout(7000)});
  must(rest.status===200&&(await rest.json()).length===0,'PROCESS_REVIVED_DATA_API');
  must(![secret.database.password,secret.encryptionKey,...secret.testAccounts.map(a=>a.password),cookie,tokens.access,tokens.refresh].some(v=>output.includes(v)),'RESTART_SECRET_LOG');
  must(!guard.failed(),'RESTART_ASYNC_FAILURE');
  const result={status:'PASS',freshNodeProcesses:3,dpapiKeyPersistence:true,restoreAfterProcessRestart:true,revocationAfterProcessRestart:true,
   nodeReplayHttp:401,dataApiReplayHttp:200,dataApiReplayRows:0,credentialsInChildLogs:false};
  fs.writeFileSync(evidence,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{
  await stop();if(client)await client.end().catch(()=>{});
  if(digest){const d=secret.database,cleanup=new Client({...d,ssl:{ca:d.ca,rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeoutMillis:7000});
   try{await cleanup.connect();const {rows:[r]}=await cleanup.query('select revoked_at_ms from setscope_private.remembered_sessions where digest=$1',[digest]);
    if(r&&r.revoked_at_ms===null)await createPostgresRememberedSessionStore(cleanup).revoke(digest,Date.now());}finally{await cleanup.end();}}
 }
 guard.dispose();
})().catch(()=>{console.error('Dev process restart FAIL; secret details suppressed');process.exitCode=1;});
