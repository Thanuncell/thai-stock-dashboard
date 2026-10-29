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
  await fs.writeFile(conf,'db-uri = "postgresql://'+role+':'+password+'@127.0.0.1:'+config.port+'/'+config.database+'"\ndb-schemas = "public"\ndb-anon-role = "anon"\nserver-host = "127.0.0.1"\nserver-port = '+port+'\njwt-secret = "'+secret+'"\n');
  await start();
  await t.test('PostgREST real HTTP: schema cache and named queue RPC payload/response',async()=>{
   const added=await store().enqueue({scope:'http',key:'named',stage:'discovery',payload:{candidate:true}});assert.equal(added.length,1);
   const claimed=(await store().claim({scope:'http'}))[0];assert.ok(claimed.lease_token);
   assert.equal(await store().finish(claimed,'advance',{stage:'extraction',checkpoint:{discovered:true}}),true);
   assert.ok(trace.some(x=>x.path.endsWith('/enqueue_news_work')&&x.status===200));
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
 }finally{await stop();await fs.unlink(conf).catch(()=>{});await pool.query('drop role if exists '+role);}
};
