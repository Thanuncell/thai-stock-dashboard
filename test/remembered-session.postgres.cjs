'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { createPostgresRememberedSessionStore } = require('../server/remembered-session-postgres');
const { fixture, login, requestSession, browserHeaders, upstream, lifetime, owners } = require('./fixtures/remembered-session.cjs');
const { createHttpVerifier } = require('./fixtures/remembered-session-http.cjs');

const root = path.join(__dirname, '..');
const up = 'supabase/proposals/v165_remembered_sessions.sql';
const down = 'supabase/proposals/v165_remembered_sessions_rollback.sql';
const registry = 'setscope_private.remembered_sessions';
const sessionId = jwt => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url')).session_id;
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
const digestOf = cookie => createHash('sha256').update(cookie.split('=')[1]).digest('hex');
const run = promisify(execFile);

// Run against a freshly initialized, disposable loopback cluster.
test('PostgreSQL 17 remembered sessions and Data API role model', { skip: !process.env.SETSCOPE_V165_LOCAL_PG }, async t => {
  const { port, dataDir, pgCtl } = JSON.parse(process.env.SETSCOPE_V165_LOCAL_PG);
  assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535);
  assert.equal(path.basename(path.dirname(dataDir)), 'v165-pg-verification');
  assert.equal(path.basename(dataDir), 'data');
  assert.match(path.basename(pgCtl), /^pg_ctl(?:\.exe)?$/);
  const makePool = (user, max = 2) => new Pool({
    host: '127.0.0.1', port, user, database: 'postgres', ssl: false, max,
    connectionTimeoutMillis: 1500, statement_timeout: 5000
  });
  let admin, bff, api;
  function openPools() {
    admin = makePool('setscope_test_admin');
    bff = makePool('setscope_test_bff', 4);
    api = makePool('authenticator');
  }
  async function closePools() {
    await Promise.all([admin?.end(), bff?.end(), api?.end()]);
    admin = bff = api = null;
  }
  async function script(file) {
    const client = await admin.connect();
    try { await client.query(await readFile(path.join(root, file), 'utf8')); }
    catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async function asApi(claims, sql, params = []) {
    const client = await api.connect();
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const result = await client.query(sql, params);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
  }
  const http = process.env.SETSCOPE_V165_LOCAL_HTTP
    ? createHttpVerifier(JSON.parse(process.env.SETSCOPE_V165_LOCAL_HTTP)) : null;
  const f = fixture({ initialTime: Date.now(), signClaims: http?.signClaims });
  // Model PostgREST's verified claims and SET LOCAL ROLE. SQL uses actual
  // PostgreSQL privileges and RLS. There is no hosted Auth or HTTP Data API.
  async function dataApi(token, sql, params) {
    const verified = await f.fetchProvider(`${upstream}/auth/v1/user`, { headers: bearer(token).headers });
    if (!verified.ok) return { status: 401, rows: [] };
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    assert.equal(claims.sub, (await verified.json()).id);
    try { return { status: 200, rows: (await asApi(claims, sql, params)).rows }; }
    catch (error) {
      if (error.code === '42501') return { status: 403, rows: [] };
      throw error;
    }
  }
  const rows = 'select user_id, watchlists from public.user_watchlists order by user_id';
  const insert = 'insert into public.user_watchlists (user_id) values ($1) returning user_id';
  const upsert = `insert into public.user_watchlists (user_id, watchlists) values ($1, $2)
    on conflict (user_id) do update set watchlists = excluded.watchlists returning user_id`;
  const update = "update public.user_watchlists set watchlists = '[1]' where user_id = $1 returning user_id";
  const remove = 'delete from public.user_watchlists where user_id = $1 returning user_id';

  openPools();
  try {
    const { rows: [marker] } = await admin.query(`select current_user as role,
      current_setting('data_directory') as data_dir, current_setting('server_version') as version,
      inet_server_addr()::text as address, inet_server_port() as port`);
    assert.equal(marker.role, 'setscope_test_admin');
    assert.match(marker.version, /^17\./);
    assert.equal(path.resolve(marker.data_dir).toLowerCase(), path.resolve(dataDir).toLowerCase());
    assert.equal(marker.address, '127.0.0.1/32');
    assert.equal(marker.port, port);
    console.log(`Local PostgreSQL ${marker.version}`);
    await admin.query(`
      create role anon nologin;
      create role authenticated nologin nobypassrls;
      create role service_role nologin bypassrls;
      create role authenticator login noinherit nobypassrls;
      grant authenticated, anon to authenticator;
      create role setscope_test_bff login inherit nobypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
      create function auth.uid() returns uuid language sql stable as
        $$ select (auth.jwt() ->> 'sub')::uuid $$;
      grant usage on schema auth to authenticated;
    `);
    await script('supabase/watchlists.sql');
    await admin.query('insert into auth.users values ($1), ($2)', [owners.a, owners.b]);
    await admin.query("insert into public.user_watchlists(user_id, watchlists) values ($1, '[1]'), ($2, '[2]')", [owners.a, owners.b]);
    async function memberData() {
      const members = await admin.query('select * from auth.users order by id');
      const lists = await admin.query('select * from public.user_watchlists order by user_id');
      return { members: members.rows, lists: lists.rows };
    }
    const baseline = await memberData();
    const legacy = f.legacy('a').access_token;

    await t.test('up, safe down, and reapply preserve member rows, Watchlist rows and owner policies', async () => {
      await script(up);
      assert.deepEqual(await memberData(), baseline);
      assert.deepEqual((await dataApi(legacy, rows)).rows.map(row => row.user_id), [owners.a]);
      await script(down);
      assert.deepEqual(await memberData(), baseline);
      assert.deepEqual((await dataApi(legacy, rows)).rows.map(row => row.user_id), [owners.a]);
      assert.equal((await admin.query("select to_regnamespace('setscope_private') as private")).rows[0].private, null);
      await script(up);
      await admin.query('grant setscope_session_store to setscope_test_bff');
    });

    const makeApp = () => f.app({ store: createPostgresRememberedSessionStore(bff) });
    let app = makeApp();
    const store = () => createPostgresRememberedSessionStore(bff);
    let remembered, rememberedToken, digest;

    await t.test('effective grants, RPC visibility and bypass roles do not expand Watchlist access', async () => {
      const { rows: [grants] } = await admin.query(`select
        has_schema_privilege('authenticated', 'setscope_private', 'usage') as api_schema,
        has_table_privilege('authenticated', '${registry}', 'select') as api_read,
        has_table_privilege('anon', 'public.user_watchlists', 'select') as anon_read,
        has_table_privilege('authenticated', 'public.user_watchlists', 'select,insert,update') as api_watchlist,
        has_table_privilege('authenticated', 'public.user_watchlists', 'delete') as api_delete,
        has_table_privilege('setscope_session_store', '${registry}', 'delete,truncate') as store_delete,
        has_column_privilege('setscope_session_store', '${registry}', 'expires_at_ms', 'update') as store_deadline,
        has_column_privilege('setscope_session_guard', '${registry}', 'encrypted', 'select') as guard_ciphertext,
        has_function_privilege('anon', 'setscope_private.watchlist_session_allowed(text,uuid)', 'execute') as anon_rpc,
        has_table_privilege('service_role', '${registry}', 'select') as service_read,
        has_table_privilege('setscope_session_store', 'public.user_watchlists', 'select') as store_watchlist,
        pg_has_role('authenticator', 'service_role', 'member') as api_bypass,
        pg_has_role('setscope_test_bff', 'service_role', 'member') as bff_bypass`);
      assert.deepEqual(grants, {
        api_schema: false, api_read: false, anon_read: false, api_watchlist: true, api_delete: false,
        store_delete: false, store_deadline: false, guard_ciphertext: false, anon_rpc: false,
        service_read: false, store_watchlist: false, api_bypass: false, bff_bypass: false
      });
      const acl = await admin.query(`select privilege_type from information_schema.role_table_grants
        where grantee='authenticated' and table_schema='public' and table_name='user_watchlists'`);
      assert.deepEqual(acl.rows.map(row => row.privilege_type).sort(), ['INSERT', 'SELECT', 'UPDATE']);
      const claims = { sub: owners.a, session_id: sessionId(legacy) };
      await assert.rejects(asApi(claims, 'select setscope_private.watchlist_session_allowed($1,$2)', [claims.session_id, claims.sub]), { code: '42501' });
      await assert.rejects(asApi(claims, 'set local role service_role'), { code: '42501' });
      assert.deepEqual((await asApi({ ...claims, session_id: 'invalid' }, rows)).rows, []);
      assert.deepEqual((await asApi({ sub: claims.sub }, rows)).rows, []);
      assert.equal((await dataApi(legacy, insert, [owners.b])).status, 403);
      assert.equal((await dataApi(legacy, upsert, [owners.a, '[]'])).status, 200);
      assert.deepEqual((await dataApi(legacy, update, [owners.b])).rows, []);
      assert.equal((await dataApi(legacy, remove, [owners.a])).status, 403);
      await admin.query(`revoke select (provider_session_id) on ${registry} from setscope_session_guard`);
      try { assert.equal((await dataApi(legacy, rows)).status, 403); }
      finally { await admin.query(`grant select (provider_session_id) on ${registry} to setscope_session_guard`); }

      // A synthetic bypass role demonstrates why a service key must not be the
      // user Data API credential, even when the restrictive policy is installed.
      await admin.query('grant select on public.user_watchlists to service_role');
      try {
        const bypass = await admin.connect();
        try {
          await bypass.query('begin');
          await bypass.query('set local role service_role');
          assert.equal((await bypass.query(rows)).rowCount, 2);
        } finally { await bypass.query('rollback'); bypass.release(); }
      } finally { await admin.query('revoke select on public.user_watchlists from service_role'); }
    });

    await t.test('same JWT is denied by Node and PostgreSQL after revoke, and rotation cannot resurrect it', async () => {
      remembered = await login(app);
      assert.equal(remembered.response.status, 200);
      digest = digestOf(remembered.cookie);
      const issued = await store().find(digest);
      const provider = f.sessions.get(issued.providerSessionId);
      const firstToken = provider.accessToken;
      assert.equal((await dataApi(firstToken, rows)).rows[0].user_id, owners.a);
      assert.equal((await app('/api/screener', bearer(firstToken))).status, 401);
      assert.deepEqual((await dataApi(firstToken, update, [owners.b])).rows, []);
      assert.equal((await dataApi(firstToken, remove, [owners.a])).status, 403);
      assert.equal(await store().issue({ ...issued, digest: 'f'.repeat(64) }, digest), false);
      assert.equal((await store().find(digest)).revokedAt, null, 'duplicate insert rolls back predecessor revocation');

      f.advance(3_600_000);
      let started, release;
      const reached = new Promise(resolve => { started = resolve; });
      const pending = new Promise(resolve => { release = resolve; });
      f.control.pauseRefresh = () => { started(); return pending; };
      const refreshing = requestSession(app, 'refresh', remembered);
      try {
        assert.equal(await Promise.race([reached.then(() => 'lease'), refreshing.then(r => r.status)]), 'lease');
        assert.equal((await requestSession(makeApp(), 'refresh', remembered)).status, 503);
        assert.equal(f.stats.refresh, 1);
        rememberedToken = provider.accessToken;
        assert.equal((await dataApi(rememberedToken, rows)).rows.length, 1);
        assert.equal((await requestSession(makeApp(), 'logout', remembered)).status, 200);
      } finally { release(); }
      assert.equal((await refreshing).status, 401);
      const retired = await store().find(digest);
      assert.ok(retired.revokedAt && retired.encrypted === null && retired.user === null);
      assert.equal(retired.expiresAt, issued.expiresAt);
      await assert.rejects(bff.query(`update ${registry} set revoked_at_ms=null where digest=$1`, [digest]), { code: '23514' });
      assert.equal((await app('/api/watchlists', bearer(rememberedToken))).status, 401);
      assert.equal((await app('/api/watchlists', { method: 'PUT', ...bearer(rememberedToken) })).status, 401);
      assert.deepEqual((await dataApi(rememberedToken, rows)).rows, []);
      assert.equal((await dataApi(rememberedToken, insert, [owners.a])).status, 403);
      assert.equal((await dataApi(rememberedToken, upsert, [owners.a, '[]'])).status, 403);
      assert.deepEqual((await dataApi(rememberedToken, update, [owners.a])).rows, []);
      assert.equal((await dataApi(rememberedToken, remove, [owners.a])).status, 403);
      assert.equal((await dataApi(f.legacy('b').access_token, rows)).rows[0].user_id, owners.b);
    });

    await t.test('168-hour deadline rejects cookie and a still-valid JWT without extending retention', async () => {
      f.control.pauseRefresh = undefined;
      const expiring = await login(app);
      assert.equal(expiring.response.status, 200);
      const row = await store().find(digestOf(expiring.cookie));
      const before = f.now();
      try {
        f.advance(lifetime - 1000);
        assert.equal((await requestSession(app, 'restore', expiring)).body.remainingMs, 1000);
        assert.equal((await store().find(row.digest)).version, row.version + 1);
        f.advance(1000);
        assert.equal((await requestSession(app, 'restore', expiring)).status, 401);
        f.advance(1000);
        assert.equal((await requestSession(app, 'refresh', expiring)).status, 401);
      } finally { f.advance(before - f.now()); }
      assert.equal((await store().find(row.digest)).expiresAt, row.issuedAt + lifetime);

      const stillValid = f.legacy('a').access_token;
      const nowMs = Date.now();
      const handle = randomBytes(32).toString('base64url');
      const cookie = '__Host-setscope-remember=' + handle;
      const older = {
        ...row, digest: digestOf(cookie), providerSessionId: sessionId(stillValid),
        issuedAt: nowMs - lifetime + 700, expiresAt: nowMs + 700
      };
      assert.equal(await store().issue(older), true);
      assert.equal((await dataApi(stillValid, rows)).rows.length, 1);
      await admin.query('select pg_sleep(0.8)');
      assert.deepEqual((await dataApi(stillValid, rows)).rows, []);
      assert.equal((await dataApi(stillValid, upsert, [owners.a, '[]'])).status, 403);
      f.advance(-3_605_000);
      try {
        assert.ok(f.now() < older.expiresAt);
        assert.equal((await requestSession(app, 'restore', { cookie })).status, 401);
      } finally { f.advance(3_605_000); }
    });

    await t.test('real database stop and restart fail closed, retain tombstones and block unsafe rollback', async () => {
      const before = (await admin.query('select pg_postmaster_start_time() as time')).rows[0].time;
      const retained = await memberData();
      await assert.rejects(script(down), /registry is not empty/);
      assert.deepEqual(await memberData(), retained);
      await closePools();
      const options = { windowsHide: true, timeout: 45000 };
      await run(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], options);
      openPools();
      try {
        const validLegacy = f.legacy('a').access_token;
        assert.equal((await makeApp()('/api/watchlists', bearer(validLegacy))).status, 503);
      } finally {
        await closePools();
        await run(pgCtl, ['-D', dataDir, '-l', path.join(path.dirname(dataDir), 'postgres.log'),
          '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], options);
        openPools();
      }
      const after = (await admin.query('select pg_postmaster_start_time() as time')).rows[0].time;
      assert.ok(after > before);
      app = makeApp();
      assert.ok((await store().find(digest)).revokedAt);
      assert.equal((await requestSession(app, 'restore', remembered)).status, 401);
      assert.equal((await f.fetchProvider(`${upstream}/auth/v1/user`, { headers: bearer(rememberedToken).headers })).status, 200);
      assert.equal((await app('/api/watchlists', bearer(rememberedToken))).status, 401);
      assert.deepEqual((await dataApi(rememberedToken, rows)).rows, []);
      assert.equal((await app('/api/screener', bearer(f.legacy('a').access_token))).status, 410);
      assert.deepEqual(await memberData(), retained);
    });
    await t.test('real PostgREST HTTP JWT authentication and replay protection', { skip: !http }, async t => {
      await http.verify(t, {
        f, port, dataDir, pgCtl, makeApp, store, script, closePools, openPools,
        admin: () => admin
      });
    });
  } finally { await closePools(); }
});
