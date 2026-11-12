'use strict';
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVault } = require('../scripts/run-v165-dev.cjs');
const { createDevRememberedRuntime, DEV_PROJECT, DEV_URL, DB_ROLE } = require('../server/dev-remembered-runtime');

const origin = 'https://localhost:4175';
const email = 'v165-a-01@example.test';
function setup(overrides = {}, secretOverrides = {}) {
  const config = { devTestsOnly: true, nodeEnv: 'development', projectId: DEV_PROJECT, supabaseUrl: DEV_URL,
    origin, publishableKey: 'sb_publishable_fixture', testEmails: [email], ...overrides };
  const secrets = { encryptionKey: randomBytes(32).toString('base64'), database: {
    host: `db.${DEV_PROJECT}.supabase.co`, user: DB_ROLE, port: 5432, database: 'postgres', password: 'synthetic-only'
  }, ...secretOverrides };
  const state = { role: DB_ROLE, login: true, superuser: false, bypass: false, create_role: false, create_db: false,
    replication: false, ssl: true, store_read: true, store_insert: true, store_delete: false, store_truncate: false,
    extend: false, guard: true, watchlist_rls: true, api_private: false };
  const stats = { connections: 0, closed: 0, requests: 0, mapped: new Set(), outage: false, certificate: true };
  let poolConfig;
  class Pool {
    constructor(value) { poolConfig = value; stats.connections++; }
    on() {}
    async connect() { return { query: async () => ({ rows: [state] }), release() {}, connection: {stream:{authorized:stats.certificate}} }; }
    async query() { if(stats.outage)throw Error('synthetic database details must stay private');return {rowCount: stats.mapped.size,rows:[]}; }
    async end() { stats.closed++; }
  }
  const fetchImpl = async () => { stats.requests++; return Response.json({id:userId,email:stats.userEmail||email}); };
  const userId=randomUUID();
  const token = () => ['fixture',Buffer.from(JSON.stringify({sub:userId,session_id:randomUUID(),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'signature'].join('.');
  const send = (res,status,body,headers) => Object.assign(res,{status,body,headers});
  return { config,secrets,state,stats,token,poolConfig:()=>poolConfig,
    start:()=>createDevRememberedRuntime({config,secrets,Pool,fetchImpl,send}) };
}

test('Dev bootstrap rejects production/other project/public origin before opening a pool', async () => {
  for(const override of [{devTestsOnly:false},{nodeEnv:'production'},{projectId:'another-project'},
    {supabaseUrl:'https://unapproved.supabase.co'},{origin:'http://localhost:4175'},{origin:'https://public.example.test'}]) {
    const f=setup(override);await assert.rejects(f.start(),/DEV_/);assert.equal(f.stats.connections,0);
  }
});
test('Dev bootstrap requires synthetic allowlist and explicit store credential', async () => {
  for(const override of [{testEmails:[]},{testEmails:['real@example.com']},{publishableKey:'not-publishable'}]) {
    const f=setup(override);await assert.rejects(f.start(),/DEV_/);assert.equal(f.stats.connections,0);
  }
  for(const db of [null,{host:'wrong-host',user:DB_ROLE,port:5432,password:'fixture'},
    {host:`db.${DEV_PROJECT}.supabase.co`,user:'postgres',port:5432,password:'fixture'},
    {host:`db.${DEV_PROJECT}.supabase.co`,user:DB_ROLE,port:5432,database:'postgres',password:''}]) {
    const f=setup({}, {database:db});await assert.rejects(f.start(),/DEV_DATABASE_CREDENTIAL_REQUIRED/);assert.equal(f.stats.connections,0);
  }
});
test('TLS verification is mandatory and pool configuration cannot inherit connection-string SSL overrides', async () => {
  const f=setup();const runtime=await f.start();
  assert.deepEqual(f.poolConfig().ssl,{rejectUnauthorized:true,minVersion:'TLSv1.2'});
  assert.equal(f.poolConfig().connectionString,undefined);assert.equal(f.poolConfig().max,2);
  assert.equal(runtime.auth.configPayload().rememberDevice,undefined);
  assert.equal(runtime.auth.configPayload().rememberedSessionRoutes,true);
  await runtime.close();assert.equal(f.stats.closed,1);
  const bad=setup();bad.stats.certificate=false;
  await assert.rejects(bad.start(),/DEV_DATABASE_CERTIFICATE_REJECTED/);assert.equal(bad.stats.closed,1);
});
test('Dev bootstrap fails closed for elevated roles, missing guard or deadline write privilege', async () => {
  for(const change of [{superuser:true},{bypass:true},{create_role:true},{create_db:true},{replication:true},
    {store_delete:true},{store_truncate:true},{extend:true},{guard:false},{watchlist_rls:false},{api_private:true},{ssl:false},{store_read:false}]) {
    const f=setup();Object.assign(f.state,change);await assert.rejects(f.start(),/DEV_DATABASE_PRIVILEGES_REJECTED/);
    assert.equal(f.stats.closed,1);
  }
});
test('Remember Me advertises only with both explicit Dev test switches', async () => {
  for(const [enableRemember,guardVerifiedForDevTests]of [[false,false],[true,false],[false,true],[true,true]]) {
    const f=setup({enableRemember,guardVerifiedForDevTests});const runtime=await f.start();
    assert.equal(runtime.auth.configPayload().rememberDevice,enableRemember&&guardVerifiedForDevTests?true:undefined);
    await runtime.close();
  }
});
test('Legacy Bearer works, mapped Bearer is denied and store outage never bypasses guard', async () => {
  const f=setup();const runtime=await f.start();const token=f.token();const req={headers:{authorization:`Bearer ${token}`}};
  assert.equal((await runtime.auth.authorize(req,{})).user.email,email);
  f.stats.mapped.add('fixture');const replay={};assert.equal(await runtime.auth.authorize(req,replay),false);assert.equal(replay.status,401);
  f.stats.outage=true;const outage={};assert.equal(await runtime.auth.authorize(req,outage),false);assert.equal(outage.status,503);
  assert.ok(!JSON.stringify(outage).includes('synthetic database details'));
  await runtime.close();
});
test('Dev account filter rejects another account and blocks unlisted password login before upstream', async () => {
  const f=setup({enableRemember:true,guardVerifiedForDevTests:true});const runtime=await f.start();
  f.stats.userEmail='outside@example.test';const denied={};await runtime.auth.authorize({headers:{authorization:`Bearer ${f.token()}`}},denied);
  assert.equal(denied.status,401);
  const before=f.stats.requests,res={};
  await runtime.auth.handleSession({method:'POST',headers:{origin,'x-setscope-request':'1','content-type':'application/json'}},res,'login',async()=>({email:'outside@example.test',password:'fixture',rememberDevice:true}));
  assert.equal(res.status,401);assert.equal(f.stats.requests,before);
  await runtime.close();
});
test('vault reader rejects another Git checkout before decrypting or starting a shell', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'setscope-v165-vault-boundary-'));
  const marker=path.join(root,'.git'),file=path.join(root,'empty-fixture.dpapi');
  try {
    fs.writeFileSync(marker,'gitdir: synthetic');fs.writeFileSync(file,'');
    assert.throws(()=>readVault(file),/DEV_EXTERNAL_VAULT_REQUIRED/);
  } finally { fs.unlinkSync(file);fs.unlinkSync(marker);fs.rmdirSync(root); }
});
