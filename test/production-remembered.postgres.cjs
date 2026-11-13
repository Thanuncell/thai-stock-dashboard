'use strict';
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const { randomBytes } = require('node:crypto');
const { createProductionRememberedRuntime } = require('../server/production-remembered-runtime');
const { createPostgresRememberedSessionStore } = require('../server/remembered-session-postgres');
const { fixture, login, requestSession, owners } = require('./fixtures/remembered-session.cjs');

test('Production additive SQL rehearsal against synthetic existing data on local PG17',
  { skip: !process.env.SETSCOPE_V165_LOCAL_PG }, async t => {
    const c=JSON.parse(process.env.SETSCOPE_V165_LOCAL_PG);
    assert.equal(path.basename(path.dirname(c.dataDir)),'v165-pg-verification');
    const pool=user=>new Pool({host:'127.0.0.1',port:c.port,user,database:'postgres',max:2,connectionTimeoutMillis:1500});
    const admin=pool('setscope_test_admin'),installer=pool('test_owner'),bff=pool('setscope_v165_bff');
    const script=async(file,connection=installer)=>{
      const client=await connection.connect();
      try{await client.query(await readFile(path.join(__dirname,'..',file),'utf8'));}
      catch(e){await client.query('rollback');throw e;}finally{client.release();}
    };
    const f=fixture({initialTime:Date.now()});
    const api=async(claims,sql,values=[])=>{
      const client=await admin.connect();
      try{
        await client.query('begin');await client.query('set local role authenticated');
        await client.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
        const result=await client.query(sql,values);await client.query('commit');return result;
      }catch(e){await client.query('rollback');throw e;}finally{client.release();}
    };
    const claims=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url'));
    const members=async()=>({users:(await admin.query('select * from auth.users order by id')).rows,
      lists:(await admin.query('select * from public.user_watchlists order by user_id')).rows});
    try{
      const marker=(await admin.query("select current_user,inet_server_addr()::text as address,current_setting('data_directory') as data,current_setting('server_version') as version")).rows[0];
      assert.equal(marker.current_user,'setscope_test_admin');assert.equal(marker.address,'127.0.0.1/32');
      assert.equal(path.resolve(marker.data).toLowerCase(),path.resolve(c.dataDir).toLowerCase());assert.match(marker.version,/^17\./);
      await admin.query(`create role anon nologin;create role authenticated nologin nobypassrls;
        create role service_role nologin bypassrls;
        create role test_owner login createrole nosuperuser;
        grant create on database postgres to test_owner;
        grant create on schema public to test_owner;
        create schema auth;create table auth.users(id uuid primary key);
        create function auth.jwt() returns jsonb language sql stable as
          $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
        create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
        grant usage on schema auth to authenticated,test_owner;`);
      await script('supabase/watchlists.sql',admin);
      await admin.query(`alter table public.user_watchlists owner to test_owner;
        grant all on public.user_watchlists to anon,authenticated,service_role;`);
      await admin.query('insert into auth.users values($1),($2)',[owners.a,owners.b]);
      await admin.query("insert into public.user_watchlists(user_id,watchlists) values($1,'[1]'),($2,'[2]')",[owners.a,owners.b]);
      const baseline=await members();
      const identities=async()=>({
        oid:(await admin.query("select 'public.user_watchlists'::regclass::oid as oid")).rows[0].oid,
        policies:(await admin.query("select polname,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check from pg_policy where polrelid='public.user_watchlists'::regclass and polpermissive order by polname")).rows,
        triggers:(await admin.query("select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid='public.user_watchlists'::regclass and not tgisinternal order by tgname")).rows
      });
      const original=await identities();
      let migrated=false;
      await t.test('P01/P02/P03 apply as a managed non-superuser without rebuilding existing tables',async()=>{
        for(const part of ['p01_store','p02_guard','p03_bff_role']) await script(`supabase/proposals/v165_production_${part}.sql`);
        assert.deepEqual(await members(),baseline);assert.deepEqual(await identities(),original);
        assert.equal((await installer.query("select has_schema_privilege('authenticated','setscope_private','usage') as permitted")).rows[0].permitted,false);
        migrated=true;
      });
      assert.ok(migrated,'Migration failed; dependent security tests must not execute');
      await t.test('effective grants close TRUNCATE/RPC bypass while keeping owner DML and legacy access',async()=>{
        const legacy=claims(f.legacy('a').access_token);
        const r=await api(legacy,'select user_id from public.user_watchlists');assert.deepEqual(r.rows,[{user_id:owners.a}]);
        await assert.rejects(api(legacy,'truncate public.user_watchlists'),{code:'42501'});
        await assert.rejects(api(legacy,'select setscope_private.watchlist_session_allowed($1,$2)',[legacy.session_id,owners.a]),{code:'42501'});
        assert.equal((await api(legacy,'delete from public.user_watchlists returning user_id')).rowCount,0);
        assert.equal((await api(legacy,'update public.user_watchlists set watchlists=watchlists where user_id=$1 returning user_id',[owners.b])).rowCount,0);
        await assert.rejects(api(legacy,'insert into public.user_watchlists(user_id) values($1)',[owners.b]),{code:'42501'});
        await api(legacy,`insert into public.user_watchlists(user_id,watchlists) values($1,'[1]')
          on conflict(user_id) do update set watchlists=excluded.watchlists`,[owners.a]);
        const rights=(await bff.query(`select rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,rolconnlimit,
          has_table_privilege(current_user,'public.user_watchlists','select') as watchlist,
          has_table_privilege(current_user,'setscope_private.remembered_sessions','delete,truncate') as erase,
          has_column_privilege(current_user,'setscope_private.remembered_sessions','expires_at_ms','update') as extend
          from pg_roles where rolname=current_user`)).rows[0];
        assert.deepEqual(rights,{rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,
          rolconnlimit:8,watchlist:false,erase:false,extend:false});
        await assert.rejects(bff.query('set role setscope_session_guard'),{code:'42501'});
      });
      await t.test('runtime startup query validates actual SQL/roles on PG17 with only TLS transport simulated',async()=>{
        // Deliberately inject an existing loopback pool. No connection is made
        // to the Production hostname below. Local trust transport is NOT TLS
        // evidence; the SQL security checks execute unchanged on PostgreSQL.
        class LocalTransport {
          on() {}
          async end() {}
          async connect() {
            const client=await bff.connect();
            return { connection:{stream:{encrypted:true,authorized:true,getProtocol:()=> 'TLSv1.3',
              getPeerCertificate:()=>({subjectaltname:'DNS:db.nrlznztqtresaycbxuck.supabase.co'})}}, release:()=>client.release(),
              query:async(sql,args)=>{
                const result=await client.query(sql,args);
                if(sql.includes('pg_stat_ssl')) result.rows[0].ssl=true;
                return result;
              } };
          }
          query=(...args)=>bff.query(...args);
        }
        const runtime=await createProductionRememberedRuntime({
          env:{NODE_ENV:'production',SUPABASE_URL:'https://nrlznztqtresaycbxuck.supabase.co',
            SUPABASE_ANON_KEY:'sb_publishable_fixture',SETSCOPE_REMEMBER_PROJECT:'nrlznztqtresaycbxuck',
            SETSCOPE_REMEMBER_ORIGIN:'https://setscope.onrender.com',SETSCOPE_REMEMBER_MODE:'guard',
            SETSCOPE_REMEMBER_REQUIRED:'1',SETSCOPE_REMEMBER_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
            SETSCOPE_REMEMBER_DB_HOST:'db.nrlznztqtresaycbxuck.supabase.co',
            SETSCOPE_REMEMBER_DB_USER:'setscope_v165_bff',SETSCOPE_REMEMBER_DB_PORT:'5432',
            SETSCOPE_REMEMBER_DB_PASSWORD:'fixture-only',SETSCOPE_REMEMBER_DB_CA:'-----BEGIN CERTIFICATE-----\nfixture'},
          send(){},fetchImpl:async()=>{throw Error('No upstream request allowed in startup');},Pool:LocalTransport
        });
        try{assert.equal(runtime.auth.configPayload().rememberDevice,undefined);
          assert.equal(runtime.auth.configPayload().rememberedSessionRoutes,true);}finally{await runtime.close();}
      });
      await t.test('shared PostgreSQL adapter enforces revocation in Node and Data API; rollback retains rows',async()=>{
        const store=createPostgresRememberedSessionStore(bff),app=f.app({store}),a=await login(app);
        assert.equal(a.response.status,200);
        const token=[...f.sessions.values()].at(-1).accessToken,remembered=claims(token);
        assert.equal((await api(remembered,'select user_id from public.user_watchlists')).rowCount,1);
        assert.equal((await app('/api/watchlists',{headers:{authorization:`Bearer ${token}`}})).status,401);
        assert.equal((await requestSession(app,'logout',a)).status,200);
        assert.equal((await api(remembered,'select user_id from public.user_watchlists')).rowCount,0);
        await assert.rejects(api(remembered,'insert into public.user_watchlists(user_id) values($1)',[owners.a]),{code:'42501'});
        assert.equal((await api(remembered,'update public.user_watchlists set watchlists=watchlists returning user_id')).rowCount,0);
        const before=(await admin.query('select * from setscope_private.remembered_sessions')).rows;
        await script('supabase/proposals/v165_production_rollback_check.sql');
        assert.deepEqual((await admin.query('select * from setscope_private.remembered_sessions')).rows,before);
        assert.ok(before[0].revoked_at_ms);assert.equal(before[0].encrypted,null);
        await assert.rejects(admin.query('update setscope_private.remembered_sessions set revoked_at_ms=null'),{code:'23514'});
        assert.deepEqual((await members()).users,baseline.users);
        assert.deepEqual((await members()).lists.map(({updated_at,...r})=>r),baseline.lists.map(({updated_at,...r})=>r));
      });
    }finally{await Promise.all([admin.end(),installer.end(),bff.end()]);}
  });
