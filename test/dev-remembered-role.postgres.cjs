'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');

test('proposed Dev runtime login inherits only the approved store capabilities locally', { skip: !process.env.SETSCOPE_V165_LOCAL_PG }, async () => {
  const config = JSON.parse(process.env.SETSCOPE_V165_LOCAL_PG);
  assert.equal(path.basename(path.dirname(config.dataDir)), 'v165-pg-verification');
  const connect = user => new Pool({host:'127.0.0.1',port:config.port,user,database:'postgres',connectionTimeoutMillis:1500});
  const admin=connect('setscope_test_admin'),owner=connect('v165_role_owner'),runtime=connect('setscope_v165_dev_bff');
  try {
    const marker=(await admin.query("select current_user,current_setting('server_version') as version,current_setting('data_directory') as data,inet_server_addr()::text as address")).rows[0];
    assert.equal(marker.current_user,'setscope_test_admin');assert.match(marker.version,/^17\./);
    assert.equal(path.resolve(marker.data).toLowerCase(),path.resolve(config.dataDir).toLowerCase());assert.equal(marker.address,'127.0.0.1/32');
    await admin.query(`create role v165_role_owner login createrole nosuperuser;
      create schema setscope_private;create table setscope_private.remembered_sessions(digest text primary key,expires_at_ms bigint,encrypted text);
      create schema auth;create table auth.synthetic_members(id integer);
      create table public.synthetic_watchlists(id integer);`);
    await owner.query('create role setscope_session_store nologin noinherit nobypassrls');
    await admin.query(`grant usage on schema setscope_private to setscope_session_store;
      grant select,insert on setscope_private.remembered_sessions to setscope_session_store;
      grant update(encrypted) on setscope_private.remembered_sessions to setscope_session_store;`);
    await owner.query(await fs.readFile(path.join(__dirname,'../supabase/proposals/v165_dev_bff_role.sql'),'utf8'));
    const state=(await runtime.query(`select current_user,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolconnlimit,
      has_table_privilege(current_user,'setscope_private.remembered_sessions','select') as read,
      has_table_privilege(current_user,'setscope_private.remembered_sessions','insert') as insert,
      has_column_privilege(current_user,'setscope_private.remembered_sessions','encrypted','update') as rotate,
      has_column_privilege(current_user,'setscope_private.remembered_sessions','expires_at_ms','update') as extend,
      has_table_privilege(current_user,'setscope_private.remembered_sessions','delete') as delete,
      has_table_privilege(current_user,'setscope_private.remembered_sessions','truncate') as truncate,
      pg_has_role(current_user,'setscope_session_store','SET') as set_store
      from pg_roles where rolname=current_user`)).rows[0];
    assert.deepEqual(state,{current_user:'setscope_v165_dev_bff',rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,
      rolbypassrls:false,rolconnlimit:2,read:true,insert:true,rotate:true,extend:false,delete:false,truncate:false,set_store:false});
    await assert.rejects(runtime.query('select * from auth.synthetic_members'),{code:'42501'});
    await assert.rejects(runtime.query('select * from public.synthetic_watchlists'),{code:'42501'});
    await assert.rejects(runtime.query('create schema denied'),{code:'42501'});
  } finally { await Promise.all([admin.end(),owner.end(),runtime.end()]); }
});
