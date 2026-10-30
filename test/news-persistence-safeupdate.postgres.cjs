'use strict';
// Explicit localhost-only persistence regression. Never enables or rebuilds the query index.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {Pool}=require('pg'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const {article}=require('./fixtures/news-evidence.cjs'),{createNewsArchiveService,archiveFingerprint}=require('../server/news-archive-service');
const {validStoredEvidence}=require('../lib/news-evidence'),{createNewsWorkStore}=require('../server/news-work-store'),{createDurableNewsIngest}=require('../server/news-work');
const repo=path.join(__dirname,'..'),patchFile='supabase/migrations/20261029154157_news_archive_query_safeupdate.sql';
test('G1 persistence with installed WS7 triggers, real safeupdate and query flag OFF',{
 skip:!process.env.SETSCOPE_PERSISTENCE_PG,timeout:120000
},async t=>{
 const config=JSON.parse(process.env.SETSCOPE_PERSISTENCE_PG),library=String(process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY||'').replaceAll('\\','/');
 assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');assert.ok(library,'Real safeupdate required');assert.match(library,/^[A-Za-z0-9_:./-]+$/);
 const database='persistence_'+randomUUID().replaceAll('-',''),options='-c statement_timeout=30000 -c session_preload_libraries='+library;
 let admin=new Pool({...config,max:1}),pool,http;
 admin.on('error',()=>{});await admin.query('create database '+database);
 const connect=()=>{pool=new Pool({...config,database,max:6,options});pool.on('error',()=>{});};connect();
 const state=async()=>(await pool.query('select source_revision::text,index_revision::text,policy,(select count(*)::int from news_archive_query_dirty) dirty,(select count(*)::int from news_archive_query_rows) indexed from news_archive_query_state')).rows[0];
 const raw=async()=>(await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows;
 const protections=async()=>(await pool.query("select c.relname name,c.relacl::text acl,c.relrowsecurity rls,c.relforcerowsecurity forced from pg_class c where c.relnamespace='public'::regnamespace and c.relname in('news_archive','news_archive_query_state','news_archive_query_dirty','news_archive_query_groups','news_archive_query_rows') order by c.relname")).rows;
 const definitions=async()=>(await pool.query("select oid,proname,proacl::text,prosecdef,prosrc from pg_proc where pronamespace='public'::regnamespace and proname in('news_archive_query_revision','news_archive_query_commit','news_archive_query_reset') order by proname")).rows;
 const check=async()=>{const results=await pool.query(await fs.readFile(path.join(repo,'supabase/news_archive_safeupdate_check.sql'),'utf8'));return results.find(r=>r.rows?.[0]?.compatibility_check).rows[0].compatibility_check;};
 let env;const trace=[];
 const transport=async(input,init={})=>{
  const u=new URL(input);assert.equal(u.origin,'https://persistence.invalid');assert.ok(!u.pathname.includes('news_archive_query_'),'No bootstrap/index RPC is authorized by this regression');
  const response=await fetch(http.base+u.pathname.slice('/rest/v1'.length)+u.search,init);
  if(!response.ok){const error=await response.clone().json();trace.push({endpoint:u.pathname,status:response.status,code:error.code,message:error.message});}
  return response;
 };
 const archive=(fetchImpl=transport)=>createNewsArchiveService({env,fetchImpl});
 const rpc=async rows=>{const response=await fetch(http.base+'/rpc/upsert_news_archive_evidence',{method:'POST',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},body:JSON.stringify({p_rows:rows})});return{status:response.status,body:await response.json()};};
 const start=async()=>{http=await require('./fixtures/news-archive-query-http.cjs')(pool,{...config,database});env={SUPABASE_URL:'https://persistence.invalid',SUPABASE_SECRET_KEY:http.token,SETSCOPE_NEWS_EVIDENCE:'write',SETSCOPE_NEWS_ARCHIVE_QUERY:'off',SETSCOPE_NEWS_WORK_QUEUE:'off',SETSCOPE_GOOGLE_NEWS_RPC:'off',SETSCOPE_P1_DISPLAY_GATE:'on'};};
 try{
  assert.match((await pool.query('show server_version')).rows[0].server_version,/^17\./);assert.equal((await pool.query("select current_setting('safeupdate.enabled') enabled")).rows[0].enabled,'on');
  for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
  for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
  await start();const existing=article({title:'PTT ประกาศผลประกอบการและแผนลงทุน',url:'https://thunhoon.com/article-preserved-persistence',checkedAt:Date.now()-10000});
  assert.equal((await archive().ingest([existing])).ingested,1);
  await pool.query("update news_archive set analysis_mode='ai',analysis_summary='Stored synthetic AI preserved' where fingerprint=$1",[archiveFingerprint(existing)]);
  const beforeRows=await raw();
  await http.stop();http=null;await pool.query(await fs.readFile(path.join(repo,'supabase/migrations/20261029131808_news_archive_query.sql'),'utf8'));await start();
  const beforeState=await state(),beforeProtection=await protections(),beforeDefinitions=await definitions();assert.equal((await check()).patch_state,'ORIGINAL');
  const candidate=article({title:'PTT เปิดเผยข้อมูลธุรกิจล่าสุด',url:'https://thunhoon.com/article-new-persistence'});
  await t.test('BEFORE: G1 HTTP upsert returns 400/21000 and SQL context identifies revision trigger',async()=>{
   await assert.rejects(archive().ingest([candidate]),/HTTP 400/);
   const error=trace.at(-1);assert.equal(error.code,'21000');assert.match(error.message,/UPDATE requires a WHERE clause/);
   await assert.rejects(pool.query("update news_archive set snippet=snippet where fingerprint=$1",[archiveFingerprint(existing)]),e=>e.code==='21000'&&/news_archive_query_revision/.test(e.where));
   assert.deepEqual(await raw(),beforeRows);assert.deepEqual(await state(),beforeState);
   console.log(JSON.stringify({evidence:'BEFORE',http:error.status,sqlstate:error.code,message:error.message,context:'news_archive_query_revision',queryFlag:'off',archiveUnchanged:true}));
  });
  const patch=await fs.readFile(path.join(repo,patchFile),'utf8');
  await t.test('proposed patch is atomic; transaction rollback restores original definitions and failure',async()=>{
   const c=await pool.connect();try{await c.query('begin');await c.query(patch.replace(/^begin;$/m,'').replace(/^commit;$/m,''));assert.notDeepEqual((await c.query("select prosrc from pg_proc where proname='news_archive_query_revision'")).rows.map(x=>x.prosrc),beforeDefinitions.filter(x=>x.proname==='news_archive_query_revision').map(x=>x.prosrc));await c.query('rollback');}finally{c.release();}
   assert.deepEqual(await definitions(),beforeDefinitions);await assert.rejects(archive().ingest([candidate]),/HTTP 400/);assert.equal(trace.at(-1).code,'21000');assert.deepEqual(await raw(),beforeRows);
  });
  await t.test('AFTER: reuse PR77 patch; real named HTTP RPC persists with index still inactive',async()=>{
   await pool.query(patch);const verified=await check();assert.equal(verified.patch_state,'PATCHED');assert.equal(verified.rls_active,true);assert.deepEqual(await raw(),beforeRows);assert.deepEqual(await state(),beforeState);assert.deepEqual(await protections(),beforeProtection);
   const after=await definitions();assert.deepEqual(after.map(({prosrc,...rest})=>rest),beforeDefinitions.map(({prosrc,...rest})=>rest));
   assert.equal((await archive().ingest([candidate])).ingested,1);
   const rows=await raw();assert.equal(rows.length,2);assert.ok(rows.every(x=>validStoredEvidence(x.row)));assert.deepEqual(rows[0],beforeRows[0]);
   const s=await state();assert.equal(s.indexed,0);assert.equal(s.index_revision,'0');assert.equal(s.policy,null);assert.equal(s.source_revision,String(Number(beforeState.source_revision)+2)); // INSERT ... ON CONFLICT fires both statement triggers.
   console.log(JSON.stringify({evidence:'AFTER',http:200,outcome:'persisted',queryFlag:'off',policy:s.policy,indexed:s.indexed,sourceRevision:s.source_revision}));
  });
  await t.test('metadata refresh, repeated patch, dedup and article refresh preserve AI first-seen fingerprint',async()=>{
   const first=beforeRows[0].row;const metadata={...existing,verification:undefined,snippet:existing.snippet||'Synthetic source metadata refresh for the original article'};metadata.verification=require('../lib/news-quality').reviewNewsItem(metadata);assert.equal(metadata.verification.basis,'metadata');assert.equal((await archive().ingest([metadata])).retained,1);const refreshed=article({...existing,verification:undefined,checkedAt:Date.now()+100,title:existing.title});
   await archive().ingest([refreshed]);await archive().ingest([refreshed]);
   const current=(await raw()).find(x=>x.row.fingerprint===first.fingerprint).row;for(const key of ['fingerprint','first_seen_at','analysis_summary','analysis_mode'])assert.deepEqual(current[key],first[key]);assert.ok(validStoredEvidence(current));
   const snapshot=await raw(),s=await state();await pool.query(patch);assert.deepEqual(await raw(),snapshot);assert.deepEqual(await state(),s);assert.deepEqual(await protections(),beforeProtection);
   const listed=await archive().list();assert.equal(listed.total,2);assert.equal(listed.items.find(x=>x.fingerprint===first.fingerprint).analysisSummary,first.analysis_summary);
  });
  await t.test('competing evidence revisions produce one persisted winner and one conflict',async()=>{
   const old=(await raw()).find(x=>x.row.url===candidate.url).row;
   const rows=['A','B'].map(suffix=>({...archive().prepare([article({url:candidate.url,title:'PTT ข่าวการลงทุน '+suffix,checkedAt:Date.now()+1000})])[0],expected_revision:old.verification_revision}));
   const outcomes=await Promise.all(rows.map(row=>rpc([row])));assert.ok(outcomes.every(x=>x.status===200));assert.deepEqual(outcomes.map(x=>x.body[0].outcome).sort(),['conflict','persisted']);assert.equal((await raw()).length,2);assert.ok((await raw()).every(x=>validStoredEvidence(x.row)));
  });
  await t.test('lost acknowledgement and transient failure replay without duplicate or corrupted evidence',async()=>{
   const item=article({url:'https://thunhoon.com/article-lost-ack-persistence'});let lose=true;
   const lost=archive(async(...args)=>{const r=await transport(...args);if(lose&&String(args[0]).endsWith('/upsert_news_archive_evidence')){lose=false;await r.text();throw Error('SYNTHETIC_LOST_ACK');}return r;});
   await assert.rejects(lost.ingest([item]),/SYNTHETIC_LOST_ACK/);const before=await raw();const result=await archive().ingest([item]);assert.equal(result.retained,1);assert.deepEqual(await raw(),before);
   await assert.rejects(archive(async()=>{throw Error('SYNTHETIC_NETWORK_FAILURE');}).ingest([item]),/SYNTHETIC_NETWORK_FAILURE/);assert.deepEqual(await raw(),before);
  });
  await t.test('anon and two authenticated subjects remain denied; safeupdate and RLS remain enabled',async()=>{
   const before=await raw();for(const [role,claims]of [['anon',{}],['authenticated',{sub:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}],['authenticated',{sub:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}]]){
    const headers={Authorization:'Bearer '+http.jwt(role,claims),'content-type':'application/json'};
    assert.ok([401,403].includes((await fetch(http.base+'/news_archive?select=fingerprint',{headers})).status));
    assert.ok([401,403,404].includes((await fetch(http.base+'/rpc/upsert_news_archive_evidence',{method:'POST',headers,body:'{"p_rows":[]}'})).status));
   }
   const denied=await fetch(http.base+'/news_archive_query_state',{method:'PATCH',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},body:'{"source_revision":999}'});assert.equal(denied.status,400);assert.equal((await denied.json()).code,'21000');
   assert.equal((await pool.query("select current_setting('safeupdate.enabled') enabled")).rows[0].enabled,'on');assert.deepEqual(await protections(),beforeProtection);assert.deepEqual(await raw(),before);
  });
  await t.test('lease reclaim retries preserve the checkpoint after persistence acknowledgement failure',async()=>{
   await http.stop();http=null;await pool.query(await fs.readFile(path.join(repo,'supabase/migrations/20261029035841_news_work.sql'),'utf8'));await start();
   // Only this synthetic worker instance is enabled; application flags remain OFF.
   const store=createNewsWorkStore({env:{...env,SETSCOPE_NEWS_WORK_QUEUE:'on'},fetchImpl:transport});let lose=true;
   const interrupted={...store,finish:async(...args)=>{if(lose&&args[1]==='completed'){lose=false;throw Error('SYNTHETIC_ACK_FAILURE');}return store.finish(...args);}};
   const item=article({url:'https://thunhoon.com/article-lease-persistence'});
   await createDurableNewsIngest({archive:archive(),store:interrupted}).ingest([item]);const before=await raw();
   await pool.query("update news_work set available_at=now()-interval '1 second' where scope='general' and state='retry'");
   const abandoned=(await store.claim({scope:'general',leaseSeconds:30}))[0];assert.ok(abandoned.lease_token);await pool.query("update news_work set lease_until=now()-interval '1 second' where id=$1 and state='processing'",[abandoned.id]);
   const result=await createDurableNewsIngest({archive:archive(),store}).runOnce();assert.equal(result.outcomes[0].outcome,'completed');assert.equal(await store.finish(abandoned,'completed'),false);assert.deepEqual(await raw(),before);
  });
  await t.test('database and HTTP restart preserve the archive while the query index remains inactive',async()=>{
   const before=await raw(),s=await state();await http.stop();http=null;await pool.end();pool=null;await admin.end();admin=null;
   const data=process.env.SETSCOPE_WS3_PG_DATA,bin=process.env.SETSCOPE_TEST_PG_BIN;assert.ok(data&&bin);
   const control=action=>new Promise((resolve,reject)=>{const child=spawn(path.join(bin,'pg_ctl.exe'),['-D',data,'-l',path.join(data,'../postgres.log'),...(action==='start'?['-o','-h 127.0.0.1 -p '+config.port]:['-m','fast']),'-w',action],{windowsHide:true,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('ISOLATED_RESTART_FAILED')));});
   await control('stop');await control('start');admin=new Pool({...config,max:1});admin.on('error',()=>{});connect();await start();assert.deepEqual(await raw(),before);assert.deepEqual(await state(),s);assert.equal((await archive().list()).total,before.length);
  });
  await t.test('application rollback keeps compatibility patch and archive; Queue OFF makes no queue RPC',async()=>{
   const before=await raw(),s=await state();let calls=0;const disabled=createNewsWorkStore({env:{...env,SETSCOPE_NEWS_WORK_QUEUE:'off'},fetchImpl:async()=>{calls++;throw Error('UNEXPECTED_QUEUE_CALL');}});
   const result=await createDurableNewsIngest({archive:archive(),store:disabled}).ingest([]);assert.equal(result.ingested,0);assert.equal(calls,0);assert.deepEqual(await raw(),before);assert.deepEqual(await state(),s);assert.equal(s.policy,null);assert.equal(s.indexed,0);
   assert.equal((await pool.query("select current_setting('safeupdate.enabled') enabled")).rows[0].enabled,'on');
  });
 }finally{await http?.stop();await pool?.end();if(!admin){admin=new Pool({...config,max:1});admin.on('error',()=>{});}await admin.query('drop database '+database+' with(force)');await admin.end();}
});
