'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto'),{Pool}=require('pg'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const {createNewsArchiveService}=require('../server/news-archive-service'),repo=path.join(__dirname,'..'),patchFile='supabase/migrations/20261029154157_news_archive_query_safeupdate.sql',policy='news-query-1:read:metadata';
test('WS7 real safeupdate compatibility over PostgreSQL 17 and PostgREST HTTP',{skip:!process.env.SETSCOPE_WS7_PG},async t=>{
 const config=JSON.parse(process.env.SETSCOPE_WS7_PG);assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');assert.ok(process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY,'Real safeupdate library is required; no simulated guard');
 const admin=new Pool({...config,max:1}),database='setscope_safeupdate_'+randomUUID().replaceAll('-','');await admin.query('create database '+database);
 const pool=new Pool({...config,database,max:4,options:'-c statement_timeout=30000 -c session_preload_libraries='+process.env.SETSCOPE_TEST_SAFEUPDATE_LIBRARY});let http;
 try{
  assert.match((await pool.query('show server_version')).rows[0].server_version,/^17\./);assert.equal((await pool.query("select current_setting('safeupdate.enabled') enabled")).rows[0].enabled,'on');
  for(const role of ['anon','authenticated','service_role'])if(!(await admin.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await admin.query('create role '+role+' nologin'+(role==='service_role'?' bypassrls':''));
  for(const file of ['supabase/news_archive.sql','supabase/news_archive_least_privilege.sql','supabase/migrations/20261027112037_news_archive_evidence.sql'])await pool.query(await fs.readFile(path.join(repo,file),'utf8'));
  await pool.query("insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at,matched_symbols,analysis_mode,analysis_summary) values('preserved-safeupdate','PTT ผลประกอบการและแผนการลงทุน','https://news.google.com/rss/articles/safeupdate-preserved','infoquest','InfoQuest','บริษัทเปิดเผยผลประกอบการและข้อมูลการลงทุนจากแหล่งข่าวต้นทาง',now()-interval '1 minute',now(),array['PTT'],'ai','Stored AI preserved')");
  const original=(await pool.query("select to_jsonb(a) row from news_archive a where fingerprint='preserved-safeupdate'")).rows[0].row;
  await pool.query(await fs.readFile(path.join(repo,'supabase/migrations/20261029131808_news_archive_query.sql'),'utf8'));
  http=await require('./fixtures/news-archive-query-http.cjs')(pool,{...config,database});
  const calls=[],rpc=async(name,body,role='service_role')=>{const response=await fetch(http.base+'/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+http.jwt(role),'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();calls.push({name,status:response.status});return{status:response.status,data};};
  const env={SUPABASE_URL:'https://ws7-bootstrap.invalid',SUPABASE_SECRET_KEY:http.token,SETSCOPE_NEWS_EVIDENCE:'read',SETSCOPE_NEWS_ARCHIVE_QUERY:'on',SETSCOPE_NEWS_WORK_QUEUE:'off'},service=()=>createNewsArchiveService({env,fetchImpl:async(input,init)=>{const u=new URL(input);assert.equal(u.origin,env.SUPABASE_URL);const response=await fetch(http.base+u.pathname.slice('/rest/v1'.length)+u.search,init);calls.push({name:u.pathname.split('/').pop(),status:response.status});return response;}});
  const state=async()=>(await pool.query('select source_revision::text,index_revision::text,policy,(select count(*)::int from news_archive_query_dirty) dirty,(select count(*)::int from news_archive_query_rows) indexed from news_archive_query_state')).rows[0];
  const catalog=async()=>(await pool.query("select 'table:'||relname name,relacl::text acl,relrowsecurity rls,relforcerowsecurity forced,null::boolean definer,oid from pg_class where relname in('news_archive','news_archive_query_state','news_archive_query_dirty','news_archive_query_rows','news_archive_query_groups') union all select 'function:'||proname,proacl::text,null,null,prosecdef,oid from pg_proc where pronamespace='public'::regnamespace and proname in('news_archive_query_revision','news_archive_query_commit','news_archive_query_reset') order by name")).rows;
  const protections=await catalog(),before=await state();
  await t.test('original bootstrap reproduces work/components200 then commit400 and SQLSTATE21000',async()=>{
   await assert.rejects(service().refreshQueryIndex(),/HTTP 400/);assert.deepEqual(calls.slice(-3).map(x=>[x.name,x.status]),[['news_archive_query_work',200],['news_archive_query_components',200],['news_archive_query_commit',400]]);
   const result=await rpc('news_archive_query_commit',{p_source_revision:'0',p_index_revision:'0',p_policy:policy,p_dirty:[],p_removed:[],p_groups:[],p_rows:[]});assert.equal(result.status,400);assert.equal(result.data.code,'21000');assert.match(result.data.message,/UPDATE requires a WHERE clause/);assert.deepEqual(await state(),before);
  });
  await t.test('original revision and reset failures roll back atomically under the real guard',async()=>{
   await assert.rejects(pool.query("update news_archive set snippet=snippet where fingerprint='preserved-safeupdate'"),e=>e.code==='21000'&&/UPDATE requires a WHERE clause/.test(e.message));
   const result=await rpc('news_archive_query_reset',{p_policy:policy});assert.equal(result.status,400);assert.equal(result.data.code,'21000');assert.match(result.data.message,/DELETE requires a WHERE clause/);assert.deepEqual(await state(),before);
   assert.deepEqual((await pool.query("select to_jsonb(a) row from news_archive a where fingerprint='preserved-safeupdate'")).rows[0].row,original);
  });
  await t.test('additive patch rehearses transaction rollback then preserves identities grants RLS and data',async()=>{
   const patch=await fs.readFile(path.join(repo,patchFile),'utf8'),oldDefinition=(await pool.query("select prosrc from pg_proc where oid='news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb)'::regprocedure")).rows[0].prosrc,connection=await pool.connect();
   try{await connection.query('begin');await connection.query(patch.replace(/^begin;$/m,'').replace(/^commit;$/m,''));assert.notEqual((await connection.query("select prosrc from pg_proc where oid='news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb)'::regprocedure")).rows[0].prosrc,oldDefinition);await connection.query('rollback');}finally{connection.release();}
   assert.equal((await pool.query("select prosrc from pg_proc where oid='news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb)'::regprocedure")).rows[0].prosrc,oldDefinition);
   await pool.query(patch);assert.deepEqual(await state(),before);assert.deepEqual(await catalog(),protections);assert.deepEqual((await pool.query("select to_jsonb(a) row from news_archive a where fingerprint='preserved-safeupdate'")).rows[0].row,original);
  });
  const bootstrap=async()=>{const result=await promisify(execFile)(process.execPath,['--require',path.join(__dirname,'fixtures/news-archive-query-cli.cjs'),'scripts/rebuild-news-archive-query.js','--apply-derived-index','--confirm-origin=https://ws7-bootstrap.invalid'],{cwd:repo,env:{...process.env,...env,SETSCOPE_WS7_HTTP_BASE:http.base}});const answer=JSON.parse(result.stdout);assert.equal(answer.enabled,true);assert.equal(answer.pending,0);return answer;};
  await t.test('approved CLI bootstrap completes and repeated admission is idempotent without reset',async()=>{
   await bootstrap();const a=await state();assert.equal(a.dirty,0);assert.equal(a.indexed,1);assert.equal((await service().list()).total,1);await bootstrap();assert.deepEqual(await state(),a);
  });
  await t.test('incremental source update works and keeps fingerprint FirstSeen StoredAI',async()=>{
   const response=await fetch(http.base+'/news_archive?fingerprint=eq.preserved-safeupdate',{method:'PATCH',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},body:JSON.stringify({matched_symbols:['PTT','OR']})});assert.equal(response.status,204);assert.equal((await state()).dirty,1);
   assert.equal((await service().refreshQueryIndex()).pending,0);assert.equal((await service().list({symbol:'OR'})).total,1);
   const row=(await pool.query("select to_jsonb(a) row from news_archive a where fingerprint='preserved-safeupdate'")).rows[0].row;for(const name of ['fingerprint','first_seen_at','analysis_summary','analysis_mode','url','title'])assert.deepEqual(row[name],original[name]);
  });
  await t.test('competing same-revision HTTP writers yield one atomic winner and one bounded conflict',async()=>{
   const work=(await rpc('news_archive_query_work',{p_limit:1})).data,args={p_source_revision:work.sourceRevision,p_index_revision:work.indexRevision,p_policy:policy,p_dirty:[],p_removed:[],p_groups:[],p_rows:[]};
   const results=await Promise.all([rpc('news_archive_query_commit',args),rpc('news_archive_query_commit',args)]);assert.ok(results.every(x=>x.status===200));assert.equal(results.filter(x=>x.data.committed).length,1);assert.equal(results.filter(x=>x.data.reason==='REVISION_CONFLICT').length,1);assert.equal((await state()).indexed,1);assert.equal((await state()).dirty,0);
  });
  await t.test('RLS clients remain denied and malformed reset cannot clear the derived index',async()=>{
   for(const role of ['anon','authenticated'])for(const name of ['news_archive_query_reset','news_archive_query_work']){const result=await rpc(name,name.endsWith('reset')?{p_policy:policy}:{p_limit:1},role);assert.ok([401,403,404].includes(result.status));}
   const a=await state();const result=await rpc('news_archive_query_reset',{p_policy:'caller-controlled-policy'});assert.equal(result.status,400);assert.match(result.data.message,/NEWS_QUERY_POLICY_MISMATCH/);assert.deepEqual(await state(),a);assert.deepEqual(await catalog(),protections);
  });
  await t.test('explicit isolated reset uses captured derived keys, including empty index, without losing original news',async()=>{
   const raw=(await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows;for(let n=0;n<2;n++){const response=await rpc('news_archive_query_reset',{p_policy:policy});assert.equal(response.status,200);assert.equal((await state()).indexed,0);assert.equal((await state()).dirty,1);}await bootstrap();assert.equal((await state()).indexed,1);assert.deepEqual((await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows,raw);
   // Guard still rejects arbitrary full-table mutations after the patch.
   const response=await fetch(http.base+'/news_archive_query_state',{method:'PATCH',headers:{Authorization:'Bearer '+http.token,'content-type':'application/json'},body:JSON.stringify({index_revision:999})});assert.equal(response.status,400);assert.equal((await response.json()).code,'21000');assert.equal((await pool.query("select current_setting('safeupdate.enabled') enabled")).rows[0].enabled,'on');
  });
  await t.test('reset captures 50k stale derived keys and preserves the source Archive',async()=>{
   const raw=(await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows;
   // Synthetic orphan projections exercise repair of stale index members; never original news.
   await pool.query("insert into news_archive_query_groups select (jsonb_populate_record(null::news_archive_query_groups,to_jsonb(g)||jsonb_build_object('group_key',encode(sha256(convert_to('orphan-'||n,'UTF8')),'hex'),'winner_fingerprint','orphan-'||n))).* from (select * from news_archive_query_groups limit 1) g cross join generate_series(1,50000) n");
   await pool.query("insert into news_archive_query_rows select 'orphan-'||n,encode(sha256(convert_to('orphan-'||n,'UTF8')),'hex'),'synthetic-orphan','UNVERIFIED' from generate_series(1,50000) n");
   assert.equal((await state()).indexed,50001);assert.equal((await rpc('news_archive_query_reset',{p_policy:policy})).status,200);assert.equal((await state()).indexed,0);assert.equal((await pool.query('select count(*)::int n from news_archive_query_groups')).rows[0].n,0);assert.equal((await state()).dirty,1);
   assert.deepEqual((await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows,raw);await bootstrap();
  });
  await t.test('derived-object rollback preserves all original Archive data with guard enabled',async()=>{
   const raw=(await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows;await pool.query(await fs.readFile(path.join(repo,'supabase/news_archive_query_rollback.sql'),'utf8'));assert.deepEqual((await pool.query('select to_jsonb(a) row from news_archive a order by id')).rows,raw);assert.equal((await pool.query("select to_regclass('public.news_archive_query_state') x")).rows[0].x,null);
  });
 }finally{await http?.stop();await pool.end();await admin.query('drop database '+database+' with(force)');await admin.end();}
});
