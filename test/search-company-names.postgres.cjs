'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {prepareCompanyNameImport}=require('../server/search-company-names');
test('PostgreSQL 17 additive names, permissions, guarded import and rollback preserve all coverage data',
 {skip:!process.env.SETSCOPE_TEST_PG_CONFIG},async()=>{
 const config=JSON.parse(fs.readFileSync(process.env.SETSCOPE_TEST_PG_CONFIG,'utf8'));
 assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'postgres');
 const {Client}=require(process.env.SETSCOPE_TEST_PG_MODULE||'pg'),admin=new Client(config);await admin.connect();
 const db='setscope_names_'+randomUUID().replaceAll('-','').slice(0,12);
 const sql=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');let client;
 try{
  assert.match((await admin.query('show server_version')).rows[0].server_version,/^17\./);await admin.query('create database '+db);
  client=new Client({...config,database:db});await client.connect();await client.query(sql('supabase/coverage.sql'));
  await client.query("INSERT INTO public.security_coverage(symbol,provider_symbol,status,symbol_verified,chart_ready,technical_ready) SELECT 'S'||lpad(n::text,4,'0'),'S'||lpad(n::text,4,'0')||'.BK','verified',true,true,true FROM generate_series(0,499) n");
  const snapshot=async()=> (await client.query("SELECT to_jsonb(c)-'company_name_en'-'name_source'-'name_checked_at' data FROM public.security_coverage c ORDER BY symbol")).rows;
  const permissions=async()=> (await client.query("SELECT relrowsecurity,relforcerowsecurity,relacl FROM pg_class WHERE oid='public.security_coverage'::regclass")).rows;
  const before=await snapshot(),acl=await permissions();
  await client.query(sql('supabase/migrations/20261026162359_search_company_names.sql'));
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await permissions(),acl);
  const columns=(await client.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='security_coverage' AND column_name IN ('company_name_en','name_source','name_checked_at')")).rows;
  assert.equal(columns.length,3);assert.ok(columns.every(c=>c.is_nullable==='YES'));
  const rows=(await client.query('SELECT * FROM public.security_coverage ORDER BY symbol')).rows;
  const records=rows.slice(0,5).map((row,i)=>({symbol:row.symbol,provider_symbol:row.provider_symbol,
   company_name_en:i===0?"Synthetic O'Reilly $names$ Public Company Limited":`Synthetic Company ${i} Public Company Limited`,
   name_source:'https://licensed.example/names',name_checked_at:'2026-10-25T00:00:00Z',
   identity_evidence:'https://licensed.example/identity',rights_evidence:'https://licensed.example/license',storage_allowed:true,display_allowed:true}));
  const plan=prepareCompanyNameImport({registry:rows,records});await client.query(plan.sql);
  assert.equal((await client.query('SELECT count(*)::int n FROM public.security_coverage WHERE company_name_en IS NOT NULL')).rows[0].n,5);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await permissions(),acl);
  await assert.rejects(client.query(plan.sql),/state changed/);await client.query('ROLLBACK');
  assert.deepEqual(await snapshot(),before);
  // A concurrent mapping change rejects the entire import and leaves every name untouched.
  await client.query(plan.rollbackSql);
  await client.query("UPDATE public.security_coverage SET provider_symbol='WRONG.BK' WHERE symbol='S0004'");
  await assert.rejects(client.query(plan.sql),/state changed/);await client.query('ROLLBACK');
  assert.equal((await client.query('SELECT count(*)::int n FROM public.security_coverage WHERE company_name_en IS NOT NULL')).rows[0].n,0);
  await client.query("UPDATE public.security_coverage SET provider_symbol='S0004.BK' WHERE symbol='S0004'");
  await client.query(plan.sql);await client.query(plan.rollbackSql);assert.deepEqual(await snapshot(),before);
  for(const role of ['anon','authenticated']){
   await client.query('SET ROLE '+role);await assert.rejects(client.query('SELECT * FROM public.security_coverage'),/permission denied/);await client.query('RESET ROLE');
  }
  await client.query(sql('supabase/search_company_names_rollback.sql'));
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await permissions(),acl);
 }finally{await client?.end();await admin.query('DROP DATABASE IF EXISTS '+db);await admin.end();}
});
