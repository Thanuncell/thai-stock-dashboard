'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {Pool}=require('pg'),run=promisify(execFile);
const {createNewsWorker,createDurableNewsIngest}=require('../server/news-work');
const {createNewsWorkStore,workKey}=require('../server/news-work-store');
const {createNewsArchiveService}=require('../server/news-archive-service');
const {article,env}=require('./fixtures/news-evidence.cjs');
test('WS3 native PostgreSQL 17 queue, leases, archive and rollback',{skip:!process.env.SETSCOPE_WS3_PG,timeout:120000},async t=>{
 const config=JSON.parse(process.env.SETSCOPE_WS3_PG);assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');
 const admin=new Pool({...config,max:1}),database='ws3_'+randomUUID().replaceAll('-','');
 assert.match((await admin.query('show server_version')).rows[0].server_version,/^17\./);
 await admin.query('create database '+database);
 let pool=new Pool({...config,database,max:8});let writer;
 try{
  for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
  for(const f of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql','supabase/migrations/20261029035841_news_work.sql'])await pool.query(await fs.readFile(path.join(__dirname,'..',f),'utf8'));
  writer=new Pool({...config,database,max:8,options:'-c role=service_role'});
  // Actual native SQL semantics. This is explicitly not PostgREST HTTP transport.
  const fetchImpl=async(input,init={})=>{
   const u=new URL(input),p=JSON.parse(init.body||'{}');let rows;
   if(u.pathname.endsWith('/enqueue_news_work'))rows=(await writer.query('select * from enqueue_news_work($1,$2,$3,$4::jsonb)',[p.p_key,p.p_scope,p.p_stage,JSON.stringify(p.p_payload)])).rows;
   else if(u.pathname.endsWith('/claim_news_work'))rows=(await writer.query('select * from claim_news_work($1,$2,$3)',[p.p_scope,p.p_limit,p.p_lease_seconds])).rows;
   else if(u.pathname.endsWith('/finish_news_work'))return Response.json((await writer.query('select finish_news_work($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ok',[p.p_id,p.p_token,p.p_scope,p.p_action,p.p_stage,JSON.stringify(p.p_checkpoint),p.p_error,p.p_delay])).rows[0].ok);
   else if(u.pathname.endsWith('/upsert_news_archive_evidence'))rows=(await writer.query('select * from upsert_news_archive_evidence($1::jsonb)',[JSON.stringify(p.p_rows)])).rows;
   else if(u.pathname.endsWith('/cleanup_news_archive'))return Response.json(0);
   else if(u.pathname.endsWith('/news_archive')){const filter=u.searchParams.get('fingerprint');rows=(await writer.query(filter?'select * from news_archive where fingerprint=any($1::text[])':'select * from news_archive order by id',filter?[filter.slice(4,-1).split(',')]:[])).rows;}
   else throw Error('Unexpected isolated endpoint');
   return Response.json(rows,{headers:{'content-range':'0-'+Math.max(0,rows.length-1)+'/'+rows.length}});
  };
  const store=()=>createNewsWorkStore({env:{...env,SETSCOPE_NEWS_WORK_QUEUE:'on'},fetchImpl});
  const archive=()=>createNewsArchiveService({env,fetchImpl});
  const enqueue=(key,scope='general',stage='persistence',payload={test:true})=>store().enqueue({scope,key,stage,payload});
  await t.test('migration is additive, RLS forced, no authenticated access or RPC execution',async()=>{
   const r=(await pool.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='news_work'::regclass")).rows[0];assert.deepEqual(r,{relrowsecurity:true,relforcerowsecurity:true});
   for(const role of ['anon','authenticated']){const q=(await pool.query("select has_table_privilege($1,'news_work','select') t,has_function_privilege($1,'claim_news_work(text,integer,integer)','execute') f",[role])).rows[0];assert.deepEqual(q,{t:false,f:false});}
  });
  await t.test('duplicate enqueue and lost acknowledgement preserve one immutable job',async()=>{await enqueue('same');await enqueue('same');assert.equal((await pool.query('select count(*)::int n from news_work')).rows[0].n,1);await assert.rejects(enqueue('same','general','persistence',{altered:true}),/NEWS_WORK_KEY_COLLISION/);});
  await t.test('competing workers claim distinct jobs without blocking',async()=>{await enqueue('second');const batches=await Promise.all([store().claim({scope:'general'}),store().claim({scope:'general'})]);assert.notEqual(batches[0][0].id,batches[1][0].id);await pool.query('delete from news_work');});
  await t.test('per-scope capacity bounds competing workers and a new scope stays independent',async()=>{
   for(let n=0;n<8;n++)await enqueue('capacity-'+n,'capacity');
   const claims=await Promise.all(Array.from({length:8},()=>store().claim({scope:'capacity'})));
   assert.equal(claims.flat().length,4);
   await enqueue('independent','independent');assert.equal((await store().claim({scope:'independent'})).length,1);
   await pool.query("update news_work set lease_until=now()-interval '1 second' where scope='capacity' and state='processing'");
   assert.equal((await store().claim({scope:'capacity'})).length,1);
  });
  await t.test('expired lease reclaims once and fences the previous token',async()=>{await enqueue('lease');const old=(await store().claim({scope:'general'}))[0];await pool.query("update news_work set lease_until=now()-interval '1 second' where id=$1",[old.id]);const fresh=(await store().claim({scope:'general'}))[0];assert.notEqual(old.lease_token,fresh.lease_token);assert.equal(await store().finish(old,'completed'),false);assert.equal(await store().finish(fresh,'completed'),true);});
  await t.test('scope A/B cannot claim or acknowledge one another',async()=>{await enqueue('private','owner-A');await enqueue('private','owner-B');const a=(await store().claim({scope:'owner-A'}))[0];assert.equal(a.scope,'owner-A');assert.equal(await store().finish({...a,scope:'owner-B'},'completed'),false);assert.equal(await store().finish(a,'completed'),true);});
  await t.test('discovery and extraction checkpoints survive fresh store/worker instances',async()=>{
   await enqueue('stages','pipeline','discovery',{seed:true});const handlers={discover:async()=>({discovered:true}),extract:async x=>{assert.equal(x.discovered,true);return {extracted:true};},persist:async x=>{assert.equal(x.extracted,true);return {ack:true};}};
   for(let n=0;n<3;n++)await createNewsWorker({store:store(),...handlers}).runOnce({scope:'pipeline'});
   assert.equal((await pool.query("select state from news_work where scope='pipeline'")).rows[0].state,'completed');
   await enqueue('stages','pipeline','discovery',{seed:true});
  });
  await t.test('retry exhaustion, poison isolation, due-time backoff and no silent job deletion',async()=>{
   await enqueue('retry','failures');await enqueue('good','failures');
   const worker=createNewsWorker({store:store(),persist:async(_,ctx)=>{if(ctx.job.work_key===workKey('failures','retry'))throw Object.assign(Error('temporary'),{status:429});return {ack:true};}});
   await worker.runOnce({scope:'failures',limit:2});assert.equal((await pool.query("select count(*)::int n from news_work where scope='failures' and state='completed'")).rows[0].n,1);
   for(let n=0;n<5;n++){await pool.query("update news_work set available_at=now()-interval '1 second' where scope='failures' and state='retry'");await worker.runOnce({scope:'failures'});}
   const failed=(await pool.query("select * from news_work where scope='failures' and state='terminal'")).rows[0];assert.equal(failed.attempts,5);assert.equal(failed.last_error,'PERSISTENCE_HTTP_429');
  });
  await t.test('forced worker termination after claim is recovered without completing stale work',async()=>{
   await enqueue('crash','crash');
   const {spawn}=require('node:child_process');
   const code="const {Pool}=require('pg');const p=new Pool(JSON.parse(process.env.WS3_CHILD_CONFIG));p.query(\"select * from claim_news_work('crash',1,10)\").then(()=>{console.log('CLAIMED');setInterval(()=>{},1000);});";
   const child=spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:{...process.env,WS3_CHILD_CONFIG:JSON.stringify({...config,database})},windowsHide:true,stdio:['ignore','pipe','pipe']});
   try{
    await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Isolated child claim timed out')),10000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('CLAIMED')){clearTimeout(timer);resolve();}});});
    const closed=new Promise(resolve=>child.once('close',resolve));child.kill('SIGKILL');await closed;
   }finally{if(child.exitCode===null)child.kill();}
   await pool.query("update news_work set lease_until=now()-interval '1 second' where scope='crash'");
   const result=await createNewsWorker({store:store(),persist:async()=>({ack:true})}).runOnce({scope:'crash'});assert.equal(result.outcomes[0].outcome,'completed');
  });
  await t.test('trusted article queue roundtrip preserves evidence and stored AI under retry',async()=>{
   const item=article();const queue=createDurableNewsIngest({archive:archive(),store:store()});
   await queue.ingest([item]);let rows=(await pool.query('select * from news_archive')).rows;assert.equal(rows.length,1);assert.equal(rows[0].verification_basis,'article');
   await pool.query("update news_archive set analysis_summary='Stored synthetic AI',analysis_mode='ai'");const before=(await pool.query('select * from news_archive')).rows[0];
   await queue.ingest([item]);const after=(await pool.query('select * from news_archive')).rows[0];assert.equal(after.fingerprint,before.fingerprint);assert.equal(+after.first_seen_at,+before.first_seen_at);assert.equal(after.analysis_summary,before.analysis_summary);
   assert.equal((await archive().list()).items[0].verification.basis,'article');
  });
  await t.test('durable discovery checkpoints reach actual extraction and PostgreSQL with provenance bound',async()=>{
   const {recordDiscovery}=require('../lib/news-discovery'),{createNewsService}=require('./fixtures/news-service.cjs');
   const candidate=recordDiscovery({title:'PTT รายงานผลประกอบการและแผนลงทุนล่าสุด',url:'https://thunhoon.com/article-ws3-durable-checkpoint',source:'thunhoon',sourceName:'Thunhoon',snippet:'บริษัท PTT รายงานผลประกอบการและแผนลงทุน',pubDate:new Date(Date.now()-60000).toISOString()},{pathway:'google-news-rss/general'});
   let requests=0;const html='<script type="application/ld+json">'+JSON.stringify({'@type':'NewsArticle',url:candidate.url,headline:candidate.title,datePublished:candidate.pubDate,articleBody:'บริษัท PTT รายงานผลประกอบการและรายละเอียดแผนลงทุนตามบทความต้นฉบับ '.repeat(8)})+'</script>';
   const review=createNewsService({env:{...env,SETSCOPE_P1_DISPLAY_GATE:'on'},fetchImpl:async input=>{requests++;assert.equal(String(input),candidate.url);return new Response(html,{headers:{'content-type':'text/html'}});}}).reviewDiscovered;
   const pipeline=()=>createDurableNewsIngest({archive:archive(),store:store(),review});
   await pipeline().captureDiscovered([candidate]);
   for(let n=0;n<3;n++)await pipeline().runOnce();
   const row=(await pool.query('select * from news_archive where url=$1',[candidate.url])).rows[0];
   assert.ok(row);assert.equal(row.verification_basis,'article');assert.equal(row.verification_provenance.discovery.pathway,'google-news-rss/general');
   assert.equal(row.verification_provenance.discovery.originalUrl,candidate.url);assert.equal(row.verification_provenance.discovery.publisher,candidate.sourceName);assert.equal(requests,1);
  });
  await require('./fixtures/news-work-http.cjs')(t,{pool,config:{...config,database}});
  await t.test('database restart preserves pending jobs, checkpoints and committed evidence',async()=>{
   await enqueue('db-restart','restart-db','extraction',{candidate:true});
   const snapshot=async()=> (await pool.query("select (select jsonb_agg(to_jsonb(a) order by id) from news_archive a) archive,(select jsonb_agg(to_jsonb(w) order by id) from news_work w) work")).rows[0];
   const before=await snapshot();
   await writer.end();await pool.end();admin.on('error',()=>{});
   const {spawn}=require('node:child_process');await new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SETSCOPE_TEST_PG_BIN,'pg_ctl.exe'),['-D',process.env.SETSCOPE_WS3_PG_DATA,'-m','fast','-w','restart'],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('Isolated restart failed')));});
   pool=new Pool({...config,database,max:8});writer=new Pool({...config,database,max:8,options:'-c role=service_role'});
   assert.deepEqual(await snapshot(),before);
   const restored=(await store().claim({scope:'restart-db'}))[0];assert.equal(restored.stage,'extraction');assert.deepEqual(restored.payload,{candidate:true});await store().finish(restored,'terminal',{error:'SYNTHETIC_TEST_DONE'});
  });
  await t.test('migration transaction rollback removes every new queue object and preserves existing data',async()=>{
   const isolated='ws3_rollback_'+randomUUID().replaceAll('-','');await admin.query('create database '+isolated);
   const db=new Pool({...config,database:isolated,max:1});let connection;
   try{
    await db.query("create table public.rollback_sentinel(id integer primary key,value text);insert into rollback_sentinel values(1,'preserved')");
    const sql=await fs.readFile(path.join(__dirname,'../supabase/migrations/20261029035841_news_work.sql'),'utf8');
    connection=await db.connect();await connection.query('begin');
    await connection.query(sql.replace(/^begin;$/m,'').replace(/^commit;$/m,''));
    assert.ok((await connection.query("select to_regclass('public.news_work') q")).rows[0].q);
    await connection.query('rollback');connection.release();connection=null;
    assert.equal((await db.query("select to_regclass('public.news_work') q")).rows[0].q,null);
    assert.equal((await db.query("select to_regprocedure('public.claim_news_work(text,integer,integer)') f")).rows[0].f,null);
    assert.equal((await db.query('select value from rollback_sentinel where id=1')).rows[0].value,'preserved');
   }finally{if(connection){await connection.query('rollback');connection.release();}await db.end();await admin.query('drop database '+isolated+' with (force)');}
  });
  await t.test('application rollback disables all queue calls and preserves queue, evidence and archive rows',async()=>{
   const before=(await pool.query("select (select count(*) from news_work)::int jobs,(select jsonb_agg(to_jsonb(a) order by id) from news_archive a) archive")).rows[0];
   let calls=0;const disabled=createNewsWorkStore({env:{SETSCOPE_NEWS_WORK_QUEUE:'off'},fetchImpl:async()=>{calls++;throw Error('must not fetch');}});
   assert.deepEqual(await createNewsWorker({store:disabled}).runOnce(),{enabled:false,processed:0});
   await createDurableNewsIngest({archive:archive(),store:disabled}).ingest([]);
   const after=(await pool.query("select (select count(*) from news_work)::int jobs,(select jsonb_agg(to_jsonb(a) order by id) from news_archive a) archive")).rows[0];
   assert.deepEqual(after,before);assert.equal(calls,0);
  });
  await t.test('transaction rollback leaves no partial checkpoint or job',async()=>{const c=await writer.connect();try{await c.query('begin');await c.query("select * from enqueue_news_work($1,'rollback','discovery','{}')",[workKey('rollback','seed')]);await c.query('rollback');}finally{c.release();}assert.equal((await pool.query("select count(*)::int n from news_work where scope='rollback'")).rows[0].n,0);});
 }finally{await writer?.end();await pool.end();await admin.query('drop database '+database+' with (force)');await admin.end();}
});
