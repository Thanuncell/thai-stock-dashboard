'use strict';

// Local HTTP integration only. Signing keys stay in memory; configuration
// contains a public verification key and a disposable loopback database URI.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } = require('node:crypto');
const { writeFile, unlink } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { login, requestSession, browserHeaders, owners, lifetime } = require('./remembered-session.cjs');

const run = promisify(execFile);
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
const digestOf = cookie => createHash('sha256').update(cookie.split('=')[1]).digest('hex');
const registry = 'setscope_private.remembered_sessions';
const down = 'supabase/proposals/v165_remembered_sessions_rollback.sql';

function createHttpVerifier({ executable }) {
  assert.match(path.basename(executable), /^postgrest(?:\.exe)?$/);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const audience = 'setscope-local-http';
  function signClaims(claims) {
    const content = encode({ alg: 'RS256', typ: 'JWT', kid: 'local-only' }) + '.' + encode({
      role: 'authenticated', aud: audience, jti: randomUUID(), ...claims
    });
    return content + '.' + sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
  }

  async function verify(t, context) {
    const { f, port, dataDir, pgCtl, makeApp, store, script, closePools, openPools, admin } = context;
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const httpPort = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const base = `http://127.0.0.1:${httpPort}`;
    const config = path.join(path.dirname(dataDir), 'postgrest.conf');
    const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'local-only', alg: 'RS256', use: 'sig' }] };
    await writeFile(config, [
      `db-uri = "postgresql://authenticator@127.0.0.1:${port}/postgres"`,
      'db-schemas = "public"', 'db-anon-role = "anon"', 'db-config = false',
      'db-pool = 3', 'db-pool-acquisition-timeout = 1',
      `jwt-secret = ${JSON.stringify(JSON.stringify(jwks))}`, `jwt-aud = "${audience}"`,
      'server-host = "127.0.0.1"', `server-port = ${httpPort}`, 'log-level = "error"'
    ].join('\n'));
    const childEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^PGRST_|^PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE)|SUPABASE|RENDER|TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY/i.test(key)));
    // The official Windows executable dynamically loads libpq from the
    // already-approved local PostgreSQL runtime. Do not change machine PATH.
    const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
    childEnv[pathKey] = path.dirname(pgCtl) + path.delimiter + (childEnv[pathKey] || '');
    const child = spawn(executable, [config], { windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let startupError, startupLog = '';
    child.stderr.on('data', data => { startupLog = (startupLog + data).slice(-1500); });
    child.stdout.on('data', data => { startupLog = (startupLog + data).slice(-1500); });
    child.on('error', error => { startupError = error; });
    const trace = [];
    async function request(label, token, route = '/user_watchlists?select=user_id,watchlists', { method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(base + route, {
        method, headers: {
          // Keep restart checks independent of idle HTTP connection reuse.
          connection: 'close',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          prefer: 'return=representation', ...headers
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000)
      });
      const responseText = await response.text();
      let value;
      try { value = JSON.parse(responseText); } catch (_) { value = null; }
      // Never retain raw Authorization headers, JWTs or arbitrary response text.
      trace.push({ label, request: { method, path: route, authorization: token ? 'Bearer <redacted>' : '(absent)' },
        response: { status: response.status, rows: Array.isArray(value) ? value.length : null, code: value?.code || null } });
      return { status: response.status, value, responseText };
    }
    async function waitReady() {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (startupError) throw Error('Local PostgREST process could not start');
        if (child.exitCode !== null) {
          const code = startupLog.match(/\bPGRST\d{3}\b/)?.[0] || 'details suppressed';
          throw Error(`Local PostgREST exited before readiness (${child.exitCode}; ${code})`);
        }
        try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).status === 200) return; } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Local PostgREST readiness timed out');
    }
    function own(result, owner = owners.a) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.value.map(row => row.user_id), [owner]);
    }
    function hidden(result) {
      assert.equal(result.status, 200);
      assert.deepEqual(result.value, []);
    }
    const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
    let remembered, replay, rotated, pendingToken, rememberedRow;
    try {
      await waitReady();
      f.advance(Date.now() - f.now());
      const legacy = f.legacy('a').access_token;
      const claims = claimsOf(legacy);
      await t.test('HTTP verifies signature, expiry, audience, nbf, claims and permitted role', async () => {
        own(await request('legacy authenticated role', legacy));
        assert.equal((await request('anonymous denied', null)).status, 401);
        const parts = legacy.split('.');
        const badSignature = parts.slice(0, 2).join('.') + '.' + Buffer.alloc(256).toString('base64url');
        assert.equal((await request('invalid signature', badSignature)).status, 401);
        assert.equal((await request('tampered subject', parts[0] + '.' + encode({ ...claims, sub: owners.b }) + '.' + parts[2])).status, 401);
        assert.equal((await request('unsigned JWT', encode({ alg: 'none' }) + '.' + parts[1] + '.')).status, 401);
        for (const [label, override] of [
          ['expired JWT', { exp: Math.floor(Date.now() / 1000) - 60 }],
          ['wrong audience', { aud: 'another-audience' }],
          ['future nbf', { nbf: Math.floor(Date.now() / 1000) + 3600 }]
        ]) assert.equal((await request(label, signClaims({ ...claims, ...override }))).status, 401);
        assert.equal((await request('unauthorized bypass role', signClaims({ ...claims, role: 'service_role' }))).status, 403);
        assert.equal((await request('missing role selects anon', signClaims({ ...claims, role: undefined }))).status, 401);
        hidden(await request('missing session_id', signClaims({ ...claims, session_id: undefined })));
        hidden(await request('invalid session_id', signClaims({ ...claims, session_id: 'invalid' })));
        hidden(await request('missing subject', signClaims({ ...claims, sub: undefined })));
      });

      await t.test('HTTP CRUD and UPSERT enforce owner RLS and existing effective grants', async () => {
        own(await request('GET owner A', legacy));
        own(await request('GET owner B', f.legacy('b').access_token), owners.b);
        hidden(await request('GET A cannot read B', legacy, `/user_watchlists?user_id=eq.${owners.b}&select=user_id`));
        hidden(await request('PATCH A cannot update B', legacy, `/user_watchlists?user_id=eq.${owners.b}`, { method: 'PATCH', body: { watchlists: ['denied'] } }));
        assert.equal((await request('POST A cannot insert B', legacy, '/user_watchlists', { method: 'POST', body: { user_id: owners.b } })).status, 403);
        await admin().query('delete from public.user_watchlists where user_id=$1', [owners.a]);
        const inserted = await request('POST own row', legacy, '/user_watchlists', { method: 'POST', body: { user_id: owners.a, watchlists: ['inserted'] } });
        assert.equal(inserted.status, 201);
        assert.equal(inserted.value[0].user_id, owners.a);
        own(await request('PATCH own row', legacy, `/user_watchlists?user_id=eq.${owners.a}`, { method: 'PATCH', body: { watchlists: ['updated'] } }));
        const upsert = owner => request(owner === owners.a ? 'UPSERT own row' : 'UPSERT A cannot write B', legacy,
          '/user_watchlists?on_conflict=user_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: { user_id: owner, watchlists: ['upserted'] } });
        // PostgREST 16 returns 200 when merge-duplicates updates an existing row.
        const merged = await upsert(owners.a);
        assert.equal(merged.status, 200);
        assert.deepEqual(merged.value[0].watchlists, ['upserted']);
        assert.equal((await upsert(owners.b)).status, 403);
        assert.equal((await request('PATCH cannot reassign owner', legacy, `/user_watchlists?user_id=eq.${owners.a}`, {
          method: 'PATCH', body: { user_id: owners.b }
        })).status, 403);
        assert.equal((await request('DELETE denied by existing grant', legacy, `/user_watchlists?user_id=eq.${owners.a}`, { method: 'DELETE' })).status, 403);
        assert.deepEqual((await admin().query('select watchlists from public.user_watchlists where user_id=$1', [owners.b])).rows[0].watchlists, [2]);
      });

      await admin().query(`
        create view public.v165_watchlist_invoker with (security_invoker=true) as select user_id,watchlists from public.user_watchlists;
        grant select on public.v165_watchlist_invoker to authenticated;
        create view public.v165_watchlist_ungranted as select user_id,watchlists from public.user_watchlists;
        revoke all on public.v165_watchlist_ungranted from public,anon,authenticated;
        notify pgrst, 'reload schema';
      `);
      // Schema-cache notification is asynchronous; wait for the fixture view.
      for (let i = 0; i < 100; i++) {
        const result = await fetch(base + '/v165_watchlist_invoker', { headers: bearer(legacy).headers });
        if (result.status === 200) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await t.test('HTTP private schemas, RPC and views cannot bypass the guard', async () => {
        own(await request('security invoker view', legacy, '/v165_watchlist_invoker'));
        const unsafe = await request('ungranted definer view denied', legacy, '/v165_watchlist_ungranted');
        assert.ok([403, 404].includes(unsafe.status));
        assert.equal((await request('private schema unexposed', legacy, '/remembered_sessions', { headers: { 'accept-profile': 'setscope_private' } })).status, 406);
        assert.equal((await request('private table not in public schema', legacy, '/remembered_sessions')).status, 404);
        assert.equal((await request('private definer helper not an exposed RPC', legacy, '/rpc/watchlist_session_allowed', { method: 'POST', body: { sid: claims.session_id, subject: owners.a } })).status, 404);
        assert.equal((await request('trigger function not an RPC', legacy, '/rpc/set_user_watchlists_updated_at', { method: 'POST', body: {} })).status, 404);
        const functions = await admin().query(`select n.nspname,p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
          where n.nspname in ('public','setscope_private') and p.prosecdef`);
        assert.equal(functions.rowCount, 1);
        assert.equal(functions.rows[0].nspname, 'setscope_private');
        assert.deepEqual(functions.rows[0].proconfig, ['search_path=pg_catalog']);
      });

      await t.test('real HTTP JWTs stay denied after atomic rotation, logout race and revocation', async () => {
        const app = makeApp();
        remembered = await login(app);
        assert.equal(remembered.response.status, 200);
        rememberedRow = await store().find(digestOf(remembered.cookie));
        const provider = f.sessions.get(rememberedRow.providerSessionId);
        replay = provider.accessToken;
        own(await request('remembered before revocation', replay));
        assert.equal((await app('/api/watchlists', bearer(replay))).status, 401);
        hidden(await request('mapped SID cannot claim another owner', signClaims({ ...claimsOf(replay), sub: owners.b })));
        f.advance(3_600_000);
        assert.equal((await requestSession(app, 'refresh', remembered)).status, 200);
        rotated = provider.accessToken;
        assert.ok(rotated !== replay);
        assert.equal(claimsOf(rotated).session_id, claimsOf(replay).session_id);
        assert.equal((await store().find(rememberedRow.digest)).expiresAt, rememberedRow.expiresAt);
        own(await request('rotated JWT before revocation', rotated));
        f.advance(3_600_000);
        let reached, release;
        const started = new Promise(resolve => { reached = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        f.control.pauseRefresh = () => { reached(); return pending; };
        const refreshing = requestSession(app, 'refresh', remembered);
        try {
          assert.equal(await Promise.race([started.then(() => 'lease'), refreshing.then(r => r.status)]), 'lease');
          pendingToken = provider.accessToken;
          assert.equal((await requestSession(makeApp(), 'refresh', remembered)).status, 503);
          assert.equal((await requestSession(makeApp(), 'logout', remembered)).status, 200);
        } finally { release(); f.control.pauseRefresh = undefined; }
        assert.equal((await refreshing).status, 401);
        f.advance(Date.now() - f.now());
        for (const [label, token] of [['original', replay], ['rotated', rotated], ['inflight', pendingToken]]) {
          hidden(await request(`${label} JWT after logout`, token));
          assert.equal((await app('/api/watchlists', bearer(token))).status, 401);
        }
        hidden(await request('revoked view access', replay, '/v165_watchlist_invoker'));
        hidden(await request('revoked PATCH', replay, `/user_watchlists?user_id=eq.${owners.a}`, { method: 'PATCH', body: { watchlists: ['denied'] } }));
        assert.equal((await request('revoked POST', replay, '/user_watchlists', { method: 'POST', body: { user_id: owners.a } })).status, 403);
        assert.equal((await request('revoked UPSERT', replay, '/user_watchlists?on_conflict=user_id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=representation' }, body: { user_id: owners.a } })).status, 403);
        assert.equal((await request('revoked DELETE', replay, `/user_watchlists?user_id=eq.${owners.a}`, { method: 'DELETE' })).status, 403);
        own(await request('independent legacy remains valid', legacy));
      });

      await t.test('database-enforced 168-hour deadline rejects a cryptographically valid JWT', async () => {
        const validJwt = f.legacy('a').access_token;
        const cookie = '__Host-setscope-remember=' + randomBytes(32).toString('base64url');
        const at = Date.now();
        const record = { ...rememberedRow, digest: digestOf(cookie), providerSessionId: claimsOf(validJwt).session_id,
          issuedAt: at - lifetime + 1500, expiresAt: at + 1500 };
        assert.equal(await store().issue(record), true);
        own(await request('168h deadline before boundary', validJwt));
        await admin().query('select pg_sleep(1.6)');
        assert.ok(claimsOf(validJwt).exp * 1000 > Date.now());
        hidden(await request('168h deadline after boundary', validJwt));
        assert.equal((await request('expired remembered INSERT', validJwt, '/user_watchlists', { method: 'POST', body: { user_id: owners.a } })).status, 403);
        assert.equal((await requestSession(makeApp(), 'restore', { cookie })).status, 401);
        own(await request('legacy after remembered expiry', legacy));
      });

      await t.test('guard lookup failure fails closed over HTTP', async () => {
        await admin().query(`revoke select(provider_session_id) on ${registry} from setscope_session_guard`);
        try {
          assert.equal((await request('guard store permission outage legacy', legacy)).status, 403);
          assert.equal((await request('guard store permission outage remembered', replay)).status, 403);
        } finally { await admin().query(`grant select(provider_session_id) on ${registry} to setscope_session_guard`); }
        own(await request('guard permission recovery legacy', legacy));
        hidden(await request('guard recovery retains revocation', replay));
      });

      await t.test('database outage, restart and blocked rollback retain HTTP tombstone denial', async () => {
        const before = (await admin().query('select pg_postmaster_start_time() as time')).rows[0].time;
        const snapshot = (await admin().query('select * from public.user_watchlists order by user_id')).rows;
        await assert.rejects(script(down), /registry is not empty/);
        hidden(await request('blocked rollback retains denial', replay));
        await closePools();
        const options = { windowsHide: true, timeout: 45000 };
        await run(pgCtl, ['-D', dataDir, '-m', 'fast', '-w', 'stop'], options);
        openPools();
        try {
          await assert.rejects(run(pgCtl, ['-D', dataDir, 'status'], options), { code: 3 });
          assert.equal((await makeApp()('/api/watchlists', bearer(legacy))).status, 503);
          for (let attempt = 0; attempt < 2; attempt++) {
            const outage = await request(`database offline HTTP fails closed ${attempt + 1}`, legacy);
            assert.ok([400, 503, 504].includes(outage.status));
            assert.ok(!Array.isArray(outage.value), 'outage cannot return Watchlist rows');
            if (outage.status === 400) {
              // Observed Windows runtime limitation: disconnected libpq can
              // produce this empty, escaped error instead of a normal 503 JSON
              // error. Recognize only that exact shape; never accept arbitrary
              // 400s as evidence of a database outage. Record, do not hide it.
              assert.deepEqual(JSON.parse(outage.responseText.replaceAll('\\"', '"')),
                { code: '', details: null, hint: null, message: '' });
              console.log('LOCAL_OUTAGE_LIMITATION: PostgREST Windows returned 400 with an empty error; no rows returned.');
            }
          }
        } finally {
          await closePools();
          await run(pgCtl, ['-D', dataDir, '-l', path.join(path.dirname(dataDir), 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], options);
          openPools();
        }
        await waitReady();
        own(await request('legacy after database restart', legacy));
        hidden(await request('revoked JWT after database restart', replay));
        assert.equal((await makeApp()('/api/watchlists', bearer(replay))).status, 401);
        assert.equal((await requestSession(makeApp(), 'restore', remembered)).status, 401);
        assert.ok((await store().find(rememberedRow.digest)).revokedAt);
        assert.ok((await admin().query('select pg_postmaster_start_time() as time')).rows[0].time > before);
        assert.deepEqual((await admin().query('select * from public.user_watchlists order by user_id')).rows, snapshot);
        const graphql = await admin().query("select extname from pg_extension where extname='pg_graphql'");
        assert.equal(graphql.rowCount, 0);
        console.log('GraphQL NOT RUN: standalone local PostgreSQL has no pg_graphql extension');
      });
    } finally {
      if (child.exitCode === null) await new Promise(resolve => { child.once('close', resolve); child.kill(); });
      await unlink(config).catch(() => {});
      // Only redacted evidence is printed. No private key, JWT, cookie or token.
      console.log('LOCAL_HTTP_TRACE ' + JSON.stringify(trace));
    }
  }
  return { signClaims, verify };
}

module.exports = { createHttpVerifier };
