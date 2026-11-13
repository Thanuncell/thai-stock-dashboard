'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { createProductionRememberedRuntime } = require('../server/production-remembered-runtime');
const { fixture, owners } = require('./fixtures/remembered-session.cjs');

// Offline SQL transport double, not a production store or a TLS integration test.
function setup(mode = 'cohort', fixtureOptions = {}) {
  const f = fixture({ initialTime: Date.now(), ...fixtureOptions });
  const env = { NODE_ENV:'production', SUPABASE_URL:'https://nrlznztqtresaycbxuck.supabase.co',
    SUPABASE_ANON_KEY:'sb_publishable_fixture', SETSCOPE_REMEMBER_PROJECT:'nrlznztqtresaycbxuck',
    SETSCOPE_REMEMBER_ORIGIN:'https://setscope.onrender.com', SETSCOPE_REMEMBER_MODE:mode,
    SETSCOPE_REMEMBER_REQUIRED:'1', SETSCOPE_REMEMBER_GUARDS_READY:'1', SETSCOPE_REMEMBER_COHORT_IDS:owners.a,
    SETSCOPE_REMEMBER_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
    SETSCOPE_REMEMBER_DB_HOST:'aws-0-ap-southeast-1.pooler.supabase.com',
    SETSCOPE_REMEMBER_DB_USER:'setscope_v165_bff.nrlznztqtresaycbxuck', SETSCOPE_REMEMBER_DB_PORT:'5432',
    SETSCOPE_REMEMBER_DB_PASSWORD:'fixture-only', SETSCOPE_REMEMBER_DB_CA:'-----BEGIN CERTIFICATE-----\nfixture' };
  const state = { role:'setscope_v165_bff',database:'postgres',login:true,superuser:false,bypass:false,
    create_role:false,create_db:false,replication:false,connection_limit:8,ssl:true,store_read:true,store_insert:true,
    rotate:true,extend:false,remap:false,store_delete:false,store_truncate:false,member_data:false,api_private:false,
    api_truncate:false,guard:true,watchlist_rls:true,store_rls:true,tombstone_guard:true,lookup_role_separate:true };
  const rows = new Map(), stats = { opened:0,closed:0,requests:0,certificate:true,encrypted:true,
    protocol:'TLSv1.3',startupQueries:0,outage:false }, configs=[];
  const query = async (sql, p = []) => {
    if (stats.outage) throw Error('fixture-private-db-detail');
    if (/^select current_user/.test(sql)) { stats.startupQueries++; return { rows:[state] }; }
    if (/^select 1/.test(sql)) return { rowCount:[...rows.values()].filter(r=>r.provider_session_id===p[0]).length };
    if (/^select \*/.test(sql)) return { rows:rows.has(p[0])?[{...rows.get(p[0]),checked_at_ms:f.now()}]:[] };
    if (/^insert into/.test(sql)) {
      if ([...rows.values()].some(r=>r.provider_session_id===p[1])) return {rowCount:0};
      const names=['digest','provider_session_id','owner_id','generation','user_summary','issued_at_ms',
        'expires_at_ms','access_expires_at_ms','encrypted'];
      rows.set(p[0],{...Object.fromEntries(names.map((n,i)=>[n,p[i]])),revoked_at_ms:null,version:0,lease_id:null,lease_until_ms:null});
      return {rowCount:1};
    }
    if (/^update .* set revoked_at_ms/.test(sql)) {
      const r=rows.get(p[0]); if(!r || r.revoked_at_ms!==null)return {rowCount:0};
      Object.assign(r,{revoked_at_ms:f.now(),encrypted:null,user_summary:null,version:r.version+1});return {rowCount:1};
    }
    if (/^(begin|commit|rollback)$/.test(sql)) return {};
    throw Error('Unexpected fixture SQL');
  };
  class Pool {
    constructor(config) { stats.opened++; configs.push(config); }
    on() {}
    query = query;
    async connect() { return { query,release(){},connection:{stream:stats.missingStream?undefined:{
      encrypted:stats.encrypted,authorized:stats.certificate,getProtocol:()=>stats.protocol,
      getPeerCertificate:()=>({subjectaltname:`DNS:${stats.peerHost || env.SETSCOPE_REMEMBER_DB_HOST}`})
    }} }; }
    async end() {stats.closed++;}
  }
  const send=(res,status,body,headers)=>Object.assign(res,{status,body,headers});
  const start=()=>createProductionRememberedRuntime({env,send,Pool,now:f.now,fetchImpl:async(input,init)=>{
    stats.requests++;
    return f.fetchProvider(String(input).replace(env.SUPABASE_URL,'https://fixture.supabase.test'),init);
  }});
  const req=(extra={})=>({method:'POST',headers:{origin:env.SETSCOPE_REMEMBER_ORIGIN,
    'x-setscope-request':'1','content-type':'application/json',...extra}});
  const login=async(auth,account='a',extra={})=>{
    const res={};await auth.handleSession(req(extra),res,'login',async()=>({email:`${account}@example.test`,password:'fixture-password',rememberDevice:true}));
    return res;
  };
  return {f,env,state,stats,configs,rows,start,req,login};
}

test('production target, required latch and exact modes reject before connecting',async()=>{
  for(const change of [{NODE_ENV:'development'},{SETSCOPE_REMEMBER_REQUIRED:''},{SETSCOPE_REMEMBER_MODE:'legacy'},
    {SETSCOPE_REMEMBER_MODE:'on'},{SETSCOPE_REMEMBER_MODE:'false'},
    {SETSCOPE_REMEMBER_PROJECT:'mlqbmtycvlbfbszyrsqd'},{SUPABASE_URL:'https://mlqbmtycvlbfbszyrsqd.supabase.co'},
    {SETSCOPE_REMEMBER_ORIGIN:'http://setscope.onrender.com'}]) {
    const x=setup();Object.assign(x.env,change);await assert.rejects(x.start(),/PRODUCTION_/);assert.equal(x.stats.opened,0);
  }
});
test('cohort requires an explicit all-instance attestation and immutable account UUIDs',async()=>{
  for(const change of [{SETSCOPE_REMEMBER_GUARDS_READY:'0'},{SETSCOPE_REMEMBER_COHORT_IDS:''},
    {SETSCOPE_REMEMBER_COHORT_IDS:'owner@example.test'},
    {SETSCOPE_REMEMBER_COHORT_IDS:Array.from({length:21},()=>randomUUID()).join(',')}]) {
    const x=setup();Object.assign(x.env,change);await assert.rejects(x.start(),/COHORT/);assert.equal(x.stats.opened,0);
  }
});
test('public issuance requires explicit mode and all-instance guard readiness',async()=>{
  for(const ready of ['',undefined,'0','true']) {
    const x=setup('public');x.env.SETSCOPE_REMEMBER_GUARDS_READY=ready;
    await assert.rejects(x.start(),/PRODUCTION_PUBLIC_PREREQUISITES_REQUIRED/);
    assert.equal(x.stats.opened,0);
  }
  const x=setup('guard'),runtime=await x.start();
  try {
    assert.equal(runtime.auth.configPayload({headers:{'x-setscope-cohort-preview':'1'}}).rememberDevice,undefined);
    assert.equal((await x.login(runtime.auth,'b')).status,404);
    assert.equal(x.rows.size,0);assert.equal(x.stats.requests,0);
  }finally{await runtime.close();}
});
test('production-only persisted key, public API key and explicit TLS credentials are mandatory',async()=>{
  const adminKey=['fixture',Buffer.from(JSON.stringify({role:'service_role',ref:'nrlznztqtresaycbxuck'})).toString('base64url'),'signature'].join('.');
  for(const change of [{SETSCOPE_REMEMBER_ENCRYPTION_KEY:''},{SETSCOPE_REMEMBER_ENCRYPTION_KEY:'fixture'},
    {SUPABASE_ANON_KEY:adminKey},{SUPABASE_ANON_KEY:'sb_secret_fixture'},
    {SETSCOPE_REMEMBER_DB_HOST:'db.mlqbmtycvlbfbszyrsqd.supabase.co'},
    {SETSCOPE_REMEMBER_DB_PORT:'6543'},{SETSCOPE_REMEMBER_DB_USER:'postgres'},
    {SETSCOPE_REMEMBER_DB_PASSWORD:''},{SETSCOPE_REMEMBER_DB_CA:''}]) {
    const x=setup();Object.assign(x.env,change);await assert.rejects(x.start(),/PRODUCTION_/);assert.equal(x.stats.opened,0);
  }
});
test('runtime validates least privilege, RLS and irreversible revocation',async()=>{
  for(const mode of ['cohort','public']) {
  for(const change of [{superuser:true},{bypass:true},{create_role:true},{create_db:true},{replication:true},
    {connection_limit:-1},{connection_limit:2},{rotate:false},{extend:true},{remap:true},{member_data:true},
    {store_delete:true},{store_truncate:true},{store_read:false},{store_insert:false},{api_private:true},
    {api_truncate:true},{guard:false},{watchlist_rls:false},{store_rls:false},{tombstone_guard:false},
    {lookup_role_separate:false}]) {
    const x=setup(mode);Object.assign(x.state,change);await assert.rejects(x.start(),/SECURITY_REJECTED/);assert.equal(x.stats.closed,1);
  }
  }
});
test('verified pooler TLS accepts a backend without SSL; direct connections retain their backend check',async()=>{
  for(const ssl of [false,true,null,undefined]) {
    const x=setup('guard');x.state.ssl=ssl;
    const runtime=await x.start();
    assert.equal(runtime.auth.configPayload().rememberDevice,undefined);
    assert.equal(x.stats.requests,0);await runtime.close();assert.equal(x.stats.closed,1);
  }
  for(const ssl of [false,true]) {
    const x=setup('guard');x.state.ssl=ssl;
    Object.assign(x.env,{SETSCOPE_REMEMBER_DB_HOST:'db.nrlznztqtresaycbxuck.supabase.co',SETSCOPE_REMEMBER_DB_USER:'setscope_v165_bff'});
    if(ssl) await (await x.start()).close();
    else await assert.rejects(x.start(),/DATABASE_SECURITY_REJECTED/);
    assert.equal(x.stats.closed,1);
  }
});
test('plaintext, unverified certificates, wrong hostnames and obsolete TLS fail before SQL',async()=>{
  for(const mode of ['guard','public']) {
  for(const change of [{encrypted:false},{certificate:false},{missingStream:true},
    {protocol:'TLSv1.1'},{protocol:'TLSv1'},{protocol:null},{protocol:undefined},
    {peerHost:'untrusted.example.test'}]) {
    const x=setup(mode);x.state.ssl=true;Object.assign(x.stats,change);
    await assert.rejects(x.start(),/PRODUCTION_CERTIFICATE_REJECTED/);
    assert.equal(x.stats.startupQueries,0);assert.equal(x.stats.closed,1);assert.equal(x.stats.requests,0);
  }
  }
  for(const protocol of ['TLSv1.2','TLSv1.3']) {
    const x=setup('guard');x.stats.protocol=protocol;x.state.ssl=false;
    await (await x.start()).close();assert.equal(x.stats.closed,1);
  }
});
test('fixed pool/TLS options ignore inherited PG and connection-string overrides',async()=>{
  const x=setup();Object.assign(x.env,{PGSSLMODE:'disable',DATABASE_URL:'fixture-ignore',PGUSER:'postgres'});
  const runtime=await x.start(),c=x.configs[0];
  assert.equal(c.max,2);assert.equal(c.connectionString,undefined);assert.equal(c.user,x.env.SETSCOPE_REMEMBER_DB_USER);
  assert.deepEqual(c.ssl,{rejectUnauthorized:true,minVersion:'TLSv1.2',ca:x.env.SETSCOPE_REMEMBER_DB_CA});
  assert.equal(c.options,'-c search_path=pg_catalog');await runtime.close();assert.equal(x.stats.closed,1);
});
test('default UI hides cohort availability; preview never bypasses verified account authorization',async()=>{
  const x=setup(),r=await x.start();
  try {
    assert.equal(r.auth.configPayload().rememberDevice,undefined);
    assert.equal(r.auth.configPayload({headers:{'x-setscope-cohort-preview':'1'}}).rememberDevice,true);
    const denied=await x.login(r.auth,'b',{'x-setscope-cohort-preview':'1'});
    assert.equal(denied.status,403);assert.equal(denied.headers,undefined);assert.equal(x.rows.size,0);
    assert.equal(x.f.stats.logout,1);
    const allowed=await x.login(r.auth);
    assert.equal(allowed.status,200);assert.match(allowed.headers['set-cookie'],/Secure; HttpOnly; SameSite=Lax/);
    assert.equal(x.rows.size,1);assert.equal([...x.rows.values()][0].owner_id,owners.a);
  }finally{await r.close();}
});
test('public mode advertises opt-in without preview and accepts both verified fixture accounts',async()=>{
  const x=setup('public');x.env.SETSCOPE_REMEMBER_COHORT_IDS='';const r=await x.start();
  try {
    assert.equal(r.auth.configPayload().rememberDevice,true);
    assert.equal(r.auth.configPayload().rememberedSessionRoutes,true);
    for(const owner of ['a','b']) {
      const logged=await x.login(r.auth,owner);
      assert.equal(logged.status,200);assert.equal(logged.body.user.id,owners[owner]);
      const restored={};await r.auth.handleSession(x.req({cookie:logged.headers['set-cookie'].split(';')[0]}),restored,'restore');
      assert.equal(restored.status,200);assert.equal(restored.body.user.id,owners[owner]);
    }
    assert.equal(x.rows.size,2);
    const legacy=x.f.legacy('b').access_token;
    assert.equal((await r.auth.authorize({headers:{authorization:`Bearer ${legacy}`}},{})).user.id,owners.b);
  }finally{await r.close();}
});
test('public mode rejects provider-identity mismatches and invalid session claims without issuing a cookie',async()=>{
  for(const change of [{sub:owners.b},{session_id:'invalid'},{exp:0}]) {
    const x=setup('public',{signClaims:claims=>['fixture',Buffer.from(JSON.stringify({...claims,...change})).toString('base64url'),'fixture-signature'].join('.')});
    const r=await x.start();
    try {const denied=await x.login(r.auth,'a');assert.equal(denied.status,401);assert.equal(denied.headers,undefined);assert.equal(x.rows.size,0);}
    finally{await r.close();}
  }
});
test('non-cohort legacy sessions work; mapped Bearer and store outages fail closed without mock fallback',async()=>{
  for(const mode of ['cohort','public']) {
  const x=setup(mode),r=await x.start();
  try {
    const legacy=x.f.legacy('b').access_token;
    const bearer=token=>({headers:{authorization:`Bearer ${token}`}});
    assert.equal((await r.auth.authorize(bearer(legacy),{})).user.id,owners.b);
    await x.login(r.auth);
    const token=[...x.f.sessions.values()].at(-1).accessToken;
    const replay={};assert.equal(await r.auth.authorize(bearer(token),replay),false);assert.equal(replay.status,401);
    x.stats.outage=true;const outage={};assert.equal(await r.auth.authorize(bearer(legacy),outage),false);
    assert.equal(outage.status,503);assert.ok(!JSON.stringify(outage).includes('fixture-private-db-detail'));
    x.stats.outage=false;assert.equal((await r.auth.authorize(bearer(legacy),{})).user.id,owners.b);
  }finally{await r.close();}
  }
});
test('guard-only rollback retains restore/logout and tombstones across runtime restart with the same key',async()=>{
  for(const mode of ['cohort','public']) {
  const x=setup(mode),r=await x.start();const logged=await x.login(r.auth);
  const cookie=logged.headers['set-cookie'].split(';')[0],generation=logged.body.generation;
  const deadline=[...x.rows.values()][0].expires_at_ms;await r.close();
  x.env.SETSCOPE_REMEMBER_MODE='guard';x.env.SETSCOPE_REMEMBER_COHORT_IDS='';
  const guarded=await x.start();
  try {
    assert.equal((await x.login(guarded.auth)).status,404);
    const restored={};await guarded.auth.handleSession(x.req({cookie}),restored,'restore');
    assert.equal(restored.status,200);assert.equal(restored.body.user.id,owners.a);
    assert.equal([...x.rows.values()][0].expires_at_ms,deadline);
    const logout={};await guarded.auth.handleSession(x.req({cookie,'x-setscope-session':generation}),logout,'logout');
    assert.equal(logout.status,200);assert.equal(x.rows.size,1);assert.equal([...x.rows.values()][0].encrypted,null);
    const denied={};await guarded.auth.handleSession(x.req({cookie}),denied,'restore');assert.equal(denied.status,401);
  }finally{await guarded.close();}
  }
});
test('startup connection failure emits a fixed code without provider details',async()=>{
  const x=setup();x.stats.outage=true;
  await assert.rejects(x.start(),e=>e.message==='PRODUCTION_DATABASE_NOT_READY');assert.equal(x.stats.closed,1);
});
