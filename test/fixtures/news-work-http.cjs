'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),{spawn}=require('node:child_process'),{randomBytes,createHmac}=require('node:crypto');
const {createNewsWorkStore}=require('../../server/news-work-store'),{createDurableNewsIngest}=require('../../server/news-work'),{createNewsArchiveService}=require('../../server/news-archive-service'),{article}=require('./news-evidence.cjs');
module.exports=async function httpChecks(t,{pool,config}){
 const executable=process.env.SETSCOPE_TEST_POSTGREST;
 if(!executable){await t.test('actual PostgREST HTTP queue integration',{skip:'explicit isolated PostgREST runtime required'},()=>{});return;}
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'setscope-ws3-http-')),conf=path.join(root,'postgrest.conf'),secret=randomBytes(32).toString('hex'),password=randomBytes(24).toString('hex'),role='ws3_http_'+randomBytes(6).toString('hex');
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;let child;
 const jwt=role=>{const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const value=enc({alg:'HS256',typ:'JWT'})+'.'+enc({role,exp:Math.floor(Date.now()/1000)+600});return value+'.'+createHmac('sha256',secret).update(value).digest('base64url');};
 const env={SUPABASE_URL:'https://isolated.invalid',SUPABASE_SECRET_KEY:jwt('service_role'),SETSCOPE_NEWS_WORK_QUEUE:'on',SETSCOPE_NEWS_EVIDENCE:'write'};
 const trace=[];
 const transport=async(input,init={})=>{const u=new URL(input);assert.equal(u.origin,'https://isolated.invalid');const result=await fetch(base+u.pathname.slice('/rest/v1'.length)+u.search,init);trace.push({path:u.pathname,status:result.status});return result;};
 const store=()=>createNewsWorkStore({env,fetchImpl:transport}),archive=()=>createNewsArchiveService({env,fetchImpl:transport});
 async function stop(){if(child&&child.exitCode===null){const p=child;await new Promise(r=>{p.once('close',r);p.kill();});}child=null;}
 async function start(){
  const childEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PGRST_|^PG(HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)/i.test(key)));
  childEnv.PATH=process.env.SETSCOPE_TEST_PG_BIN+';'+(childEnv.PATH||childEnv.Path||'');
  child=spawn(executable,[conf],{env:childEnv,windowsHide:true,stdio:'ignore'});
  for(let n=0;n<100;n++){try{const r=await fetch(base+'/rpc/claim_news_work',{method:'POST',headers:{Authorization:'Bearer '+env.SUPABASE_SECRET_KEY,'content-type':'application/json'},body:JSON.stringify({p_scope:'http-startup',p_limit:1,p_lease_seconds:60})});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Isolated PostgREST startup failed');
 }
 try{
  await pool.query("create role "+role+" login noinherit nosuperuser nocreatedb nocreaterole password '"+password+"'; grant anon,authenticated,service_role to "+role);
  const safeupdate=process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY;
  if(safeupdate){if(!/^[A-Za-z0-9_:./\\-]+$/.test(safeupdate))throw Error('Unsafe isolated library path');await pool.query("alter role "+role+" set session_preload_libraries='"+safeupdate.replaceAll('\\','/')+"'");}
  await fs.writeFile(conf,'db-uri = "postgresql://'+role+':'+password+'@127.0.0.1:'+config.port+'/'+config.database+'"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = '+port+'\njwt-secret = "'+secret+'"\n');
  await start();
  await t.test('PostgREST real HTTP: schema cache and named queue RPC payload/response',async()=>{
   const added=await store().enqueue({scope:'http',key:'named',stage:'discovery',payload:{candidate:true}});assert.equal(added.length,1);
   const claimed=(await store().claim({scope:'http'}))[0];assert.ok(claimed.lease_token);
   assert.equal(await store().finish(claimed,'advance',{stage:'extraction',checkpoint:{discovered:true}}),true);
   assert.ok(trace.some(x=>x.path.endsWith('/enqueue_news_work')&&x.status===200));
  });
  await t.test('Recovery HTTP: legacy Service Role configuration can enqueue, claim, finish and inspect',async()=>{
   const legacyEnv={...env,SUPABASE_SECRET_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:env.SUPABASE_SECRET_KEY},legacy=createNewsWorkStore({env:legacyEnv,fetchImpl:transport});
   const job={scope:'legacy-key',key:'recovery',stage:'persistence',payload:{synthetic:true}};await legacy.enqueue(job);const claimed=(await legacy.claim({scope:job.scope}))[0];assert.equal(await legacy.finish(claimed,'completed'),true);assert.equal((await legacy.inspect({scope:job.scope})).depth,0);
   const legacyArchive=createNewsArchiveService({env:legacyEnv,fetchImpl:transport}),item=article({url:'https://thunhoon.com/article-recovery-legacy-key'});const result=await createDurableNewsIngest({archive:legacyArchive,store:legacy}).ingest([item]);assert.equal(result.outcomes[0].outcome,'completed');const stored=(await pool.query('select * from news_archive where url=$1',[item.url])).rows;assert.equal(stored.length,1);assert.equal(stored[0].verification_basis,'article');

  });
  await t.test('Recovery HTTP: safeupdate guard remains enforced while qualified queue RPCs work',{skip:!process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY},async()=>{
   const response=await fetch(base+'/news_work',{method:'PATCH',headers:{Authorization:'Bearer '+env.SUPABASE_SECRET_KEY,'content-type':'application/json'},body:JSON.stringify({last_error:'synthetic'})});assert.equal(response.status,400);assert.equal((await response.json()).code,'21000');
  });
  await t.test('PostgREST HTTP: anon/authenticated cannot read queue or execute claim RPC',async()=>{
   for(const roleName of ['anon','authenticated']){
    const r=await fetch(base+'/news_work?select=id',{headers:{Authorization:'Bearer '+jwt(roleName)}});assert.ok([401,403].includes(r.status));
    const c=await fetch(base+'/rpc/claim_news_work',{method:'POST',headers:{Authorization:'Bearer '+jwt(roleName),'content-type':'application/json'},body:'{"p_scope":"http"}'});assert.ok([401,403].includes(c.status));
   }
  });
  await t.test('PostgREST HTTP: lost enqueue acknowledgement is idempotent after process restart',async()=>{
   let lose=true;const lost=createNewsWorkStore({env,fetchImpl:async(...args)=>{const r=await transport(...args);if(lose&&String(args[0]).endsWith('/enqueue_news_work')){lose=false;await r.text();throw Error('SYNTHETIC_LOST_ACK');}return r;}});
   const job={scope:'http-lost',key:'lost',stage:'discovery',payload:{seed:true}};
   await assert.rejects(lost.enqueue(job),/SYNTHETIC_LOST_ACK/);await stop();await start();
   const duplicate=await store().enqueue(job);assert.equal(duplicate.length,1);assert.equal((await pool.query("select count(*)::int n from news_work where scope='http-lost'")).rows[0].n,1);
  });
  await t.test('PostgREST HTTP: queue worker persists article evidence without overwriting stored AI',async()=>{
   const before=(await pool.query('select * from news_archive order by id limit 1')).rows[0];
   const item=article();await createDurableNewsIngest({archive:archive(),store:store()}).ingest([item]);
   const after=(await pool.query('select * from news_archive where fingerprint=$1',[before.fingerprint])).rows[0];
   assert.equal(after.verification_basis,'article');assert.equal(after.analysis_summary,before.analysis_summary);assert.equal(+after.first_seen_at,+before.first_seen_at);
   assert.equal((await archive().list()).items[0].verification.basis,'article');
  });
  await t.test('PostgREST HTTP: lost archive acknowledgement retries without duplicate rows or lost proof',async()=>{
   const item=article({url:'https://thunhoon.com/article-ws3-lost-archive'});let lose=true;
   const lostArchive=createNewsArchiveService({env,fetchImpl:async(...args)=>{const r=await transport(...args);if(lose&&String(args[0]).endsWith('/upsert_news_archive_evidence')){lose=false;await r.text();throw Error('SYNTHETIC_LOST_ARCHIVE_ACK');}return r;}});
   const first=await createDurableNewsIngest({archive:lostArchive,store:store()}).ingest([item]);assert.equal(first.outcomes[0].outcome,'retry');
   const count=(await pool.query('select count(*)::int n from news_archive')).rows[0].n;
   await pool.query("update news_work set available_at=now()-interval '1 second' where scope='general' and state='retry'");
   const second=await createDurableNewsIngest({archive:archive(),store:store()}).runOnce();assert.equal(second.outcomes[0].outcome,'completed');
   assert.equal((await pool.query('select count(*)::int n from news_archive')).rows[0].n,count);
  });
  await t.test('Recovery HTTP: kill after persistence before acknowledgement replays without losing original data',async()=>{
   const item=article({url:'https://thunhoon.com/article-recovery-hard-crash'}),prepared=archive().prepare([item])[0],scope='hard-crash';await store().enqueue({scope,key:'checkpoint',stage:'persistence',payload:prepared});
   const code="const path=require('path');const {createNewsWorkStore}=require('./server/news-work-store'),{createNewsArchiveService}=require('./server/news-archive-service');const base=new URL(process.env.RECOVERY_HTTP);if(base.hostname!=='127.0.0.1')throw Error('Not isolated');const transport=(input,init)=>{const u=new URL(input);if(u.origin!=='https://isolated.invalid')throw Error('Unsafe fixture request');return fetch(base.origin+u.pathname.slice('/rest/v1'.length)+u.search,init);};const store=createNewsWorkStore({fetchImpl:transport}),archive=createNewsArchiveService({fetchImpl:transport});(async()=>{const job=(await store.claim({scope:'hard-crash'}))[0],item=archive.restorePrepared(job.payload);await archive.ingest([item]);console.log('ARCHIVE_WRITTEN');setInterval(()=>{},1000);})().catch(()=>process.exit(1));";
   const proc=spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'../..'),env:{...process.env,...env,RECOVERY_HTTP:base},windowsHide:true,stdio:['ignore','pipe','ignore']});
   try{await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Isolated crash checkpoint timed out')),12000);proc.once('error',e=>{clearTimeout(timer);reject(e);});proc.stdout.on('data',chunk=>{text+=chunk;if(text.includes('ARCHIVE_WRITTEN')){clearTimeout(timer);resolve();}});proc.once('exit',()=>{clearTimeout(timer);reject(Error('Isolated worker exited before checkpoint'));});});const closed=new Promise(r=>proc.once('close',r));proc.kill('SIGKILL');await closed;}finally{if(proc.exitCode===null)proc.kill();}
   const job=(await pool.query('select * from news_work where scope=$1',[scope])).rows[0];assert.equal(job.state,'processing');assert.equal((await store().claim({scope})).length,0);
   await pool.query("update news_archive set analysis_mode='ai',analysis_summary='Preserved recovery AI' where url=$1",[item.url]);const before=(await pool.query('select * from news_archive where url=$1',[item.url])).rows[0];
   await pool.query("update news_work set lease_until=now()-interval '1 second' where scope=$1",[scope]);assert.equal((await createDurableNewsIngest({archive:archive(),store:store()}).runOnce({scope})).outcomes[0].outcome,'completed');
   const rows=(await pool.query('select * from news_archive where url=$1',[item.url])).rows;assert.equal(rows.length,1);for(const name of ['fingerprint','first_seen_at','analysis_summary','verification_subject_hash','verification_basis'])assert.deepEqual(rows[0][name],before[name]);
  });
  await t.test('WS4 HTTP: canonical display dedup preserves both original fingerprints, first-seen, stored AI and rows',async()=>{
   const date=new Date(Date.now()-60000).toISOString(),url='https://thunhoon.com/article-ws4-persisted';
   const first=article({title:'WS4 ตรวจสอบข่าวซ้ำโดยรักษาข้อมูลเดิม',url:url+'?fbclid=first',pubDate:date});
   const second=article({title:first.title,url:url+'?gclid=second',pubDate:date});
   await archive().ingest([first]);
   await pool.query("update news_archive set analysis_summary='Preserved WS4 AI',analysis_mode='ai' where url=$1",[first.url]);
   await archive().ingest([second]);
   const before=(await pool.query("select * from news_archive where url=any($1::text[]) order by id",[[first.url,second.url]])).rows;
   assert.equal(before.length,2);assert.notEqual(before[0].fingerprint,before[1].fingerprint);
   const service=archive(),display=await service.list({query:'WS4 ตรวจสอบข่าวซ้ำ'});
   assert.equal(display.total,1);assert.equal(display.items[0].analysisSummary,'Preserved WS4 AI');
   assert.equal(Date.parse(display.items[0].firstSeenAt),+before[0].first_seen_at);
   assert.equal((await service.list({query:'WS4 ตรวจสอบข่าวซ้ำ',excludeUrls:[url]})).total,0);
   const after=(await pool.query("select * from news_archive where url=any($1::text[]) order by id",[[first.url,second.url]])).rows;assert.deepEqual(after,before);
  });

  await t.test('WS5 HTTP: Retry-After defers durable work and scoped health does not read payloads',async()=>{
   await store().enqueue({scope:'ws5-rate',key:'rate',stage:'extraction',payload:{original:true}});
   const health=await store().inspect({scope:'ws5-rate'});assert.equal(health.depth,1);assert.ok(health.oldestAgeMs>=0);
   const worker=require('../../server/news-work').createNewsWorker({store:store(),extract:async()=>{throw Object.assign(Error('synthetic limit'),{status:429,retryAfterMs:180000});}});
   assert.equal((await worker.runOnce({scope:'ws5-rate'})).outcomes[0].outcome,'retry');
   const row=(await pool.query("select * from news_work where scope='ws5-rate'")).rows[0];
   assert.equal(row.state,'retry');assert.deepEqual(row.payload,{original:true});assert.ok(+row.available_at-Date.now()>170000);
  });
  await t.test('WS5 HTTP: failed completion acknowledgement reclaims without duplicate archive or lost AI',async()=>{
   const item=article({url:'https://thunhoon.com/article-ws5-ack-failure'}),row=archive().prepare([item])[0];
   await store().enqueue({scope:'ws5-ack',key:'ack',stage:'persistence',payload:row});
   const failing=createNewsWorkStore({env,fetchImpl:async(input,init)=>String(input).endsWith('/finish_news_work')?new Response('',{status:503}):transport(input,init)});
   const result=await createDurableNewsIngest({archive:archive(),store:failing}).runOnce({scope:'ws5-ack'});
   assert.equal(result.outcomes[0].outcome,'acknowledgement-unavailable');
   const job=(await pool.query("select * from news_work where scope='ws5-ack'")).rows[0];assert.equal(job.state,'processing');assert.deepEqual(job.payload,row);
   await pool.query("update news_archive set analysis_mode='ai',analysis_summary='Preserved WS5 AI' where url=$1",[item.url]);
   const before=(await pool.query('select * from news_archive where url=$1',[item.url])).rows[0];
   await pool.query("update news_work set lease_until=now()-interval '1 second' where scope='ws5-ack'");
   assert.equal((await createDurableNewsIngest({archive:archive(),store:store()}).runOnce({scope:'ws5-ack'})).outcomes[0].outcome,'completed');
   const after=(await pool.query('select * from news_archive where url=$1',[item.url])).rows;assert.equal(after.length,1);assert.equal(after[0].fingerprint,before.fingerprint);assert.equal(+after[0].first_seen_at,+before.first_seen_at);assert.equal(after[0].analysis_summary,before.analysis_summary);assert.equal(after[0].verification_subject_hash,before.verification_subject_hash);
   assert.equal((await store().inspect({scope:'ws5-ack'})).depth,0);
  });

 }finally{await stop();await fs.unlink(conf).catch(()=>{});await pool.query('drop role if exists '+role);}
};
