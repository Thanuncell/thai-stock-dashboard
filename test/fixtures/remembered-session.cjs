'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { createAuthService } = require('../../server/auth-service');
const { handle } = require('../../server');

const origin = 'https://setscope.test';
const upstream = 'https://fixture.supabase.test';
const owners = { a: randomUUID(), b: randomUUID() };
const lifetime = 604_800_000;
const browserHeaders = { origin, 'x-setscope-request': '1' };

function fixtureStore(state) {
  const active = (row, now) => row?.revokedAt === null && row.expiresAt > now;
  function available() {
    if (state.offline) throw Error('Fixture store unavailable');
  }
  return {
    find(digest) { available(); return structuredClone(state.rows[digest] || null); },
    hasProviderSession(sessionId) {
      available();
      return Object.values(state.rows).some(row => row.providerSessionId === sessionId);
    },
    issue(record, predecessor) {
      available();
      if (this.hasProviderSession(record.providerSessionId)) return false;
      if (predecessor && !active(state.rows[predecessor], record.issuedAt)) return false;
      if (predecessor) this.revoke(predecessor, record.issuedAt);
      state.rows[record.digest] = structuredClone(record);
      return true;
    },
    acquireRefresh(digest, version, lease, now) {
      available();
      const row = state.rows[digest];
      if (!active(row, now) || row.version !== version || row.lease) return false;
      row.lease = lease;
      return true;
    },
    finishRefresh(digest, version, leaseId, update, now) {
      available();
      if (state.failFinish) throw Error('Fixture rotation write unavailable');
      const row = state.rows[digest];
      if (!active(row, now) || row.version !== version || row.lease?.id !== leaseId || row.lease.until <= now) return false;
      Object.assign(row, update, { version: version + 1, lease: null });
      return true;
    },
    revoke(digest, now, leaseId) {
      available();
      const row = state.rows[digest];
      if (!row || row.revokedAt !== null || (leaseId && row.lease?.id !== leaseId)) return false;
      Object.assign(row, { revokedAt: now, lease: null, encrypted: null, version: row.version + 1 });
      return true;
    }
  };
}

function fixture({ initialTime = Date.UTC(2026, 10, 8), signClaims } = {}) {
  let time = initialTime;
  const key = randomBytes(32);
  const state = { rows: {}, offline: false };
  const sessions = new Map(), access = new Map(), refresh = new Map();
  const stats = { refresh: 0, logout: 0, login: 0 };
  const control = {};
  const json = (body, status = 200) => Response.json(body, { status });
  function issueTokens(session, overrides) {
    const claims = { sub: owners[session.owner], session_id: session.id, exp: Math.floor(time / 1000) + 3600, ...overrides };
    const token = signClaims ? signClaims(claims)
      : ['fixture', Buffer.from(JSON.stringify(claims)).toString('base64url'), randomUUID()].join('.');
    const refreshToken = randomUUID();
    access.set(token, { session, exp: claims.exp });
    refresh.set(refreshToken, session);
    session.accessToken = token;
    session.refreshToken = refreshToken;
    return { access_token: token, refresh_token: refreshToken, expires_in: 3600 };
  }

  function legacy(owner) {
    const session = { id: randomUUID(), owner, revoked: false };
    sessions.set(session.id, session);
    return issueTokens(session);
  }

  async function fetchProvider(input, init) {
    const url = new URL(input);
    if (url.origin !== upstream) throw Error('Unexpected fixture upstream');
    const body = init.body && JSON.parse(init.body);
    const authorization = new Headers(init.headers).get('authorization') || '';
    const token = authorization.replace(/^Bearer /, '');
    const credential = access.get(token);
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const owner = body.email.split('@')[0];
      if (!owners[owner] || body.password !== 'fixture-password') return json({ error: 'denied' }, 400);
      stats.login++;
      return json(legacy(owner));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      stats.refresh++;
      const session = refresh.get(body.refresh_token);
      if (!session || session.revoked) return json({ error: 'denied' }, 400);
      refresh.delete(body.refresh_token);
      const result = issueTokens(session, control.rotationClaims);
      if (control.pauseRefresh) await control.pauseRefresh();
      return json(result);
    }
    if (url.pathname === '/auth/v1/logout' && credential) {
      if (url.searchParams.get('scope') !== 'local') throw Error('Unexpected logout scope');
      stats.logout++;
      credential.session.revoked = true;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/auth/v1/user' && credential?.exp > time / 1000) {
      return json({ id: owners[credential.session.owner], email: `${credential.session.owner}@example.test` });
    }
    return json({ error: 'denied' }, 401);
  }

  function app({ issue = true, verified = true, records = state, wireStore = true, store = fixtureStore(records) } = {}) {
    const auth = createAuthService({
      env: { SUPABASE_URL: upstream, SUPABASE_ANON_KEY: 'fixture-public' },
      fetchImpl: fetchProvider,
      remembered: wireStore ? { store, key, origin, now: () => time, allowIssue: issue, dataApiGuardVerified: verified } : undefined,
      send: (res, status, body, headers) => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
        res.end(JSON.stringify(body));
      }
    });
    return async function request(path, { method = 'GET', headers = {}, body } = {}) {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(req, { url: path, method, headers, socket: { remoteAddress: '127.0.0.1' } });
      const result = { headers: {} };
      const res = {
        setHeader(name, value) { result.headers[name] = value; },
        getHeader(name) { return result.headers[name]; },
        writeHead(status, values) { result.status = status; Object.assign(result.headers, values); },
        once() {},
        end(data) {
          try { result.body = JSON.parse(data); } catch (_) { result.body = data; }
        }
      };
      await handle(req, res, auth);
      return result;
    };
  }

  return {
    app, state, control, stats, legacy, sessions, fetchProvider,
    now: () => time, advance: amount => { time += amount; },
    snapshot: () => JSON.parse(JSON.stringify(state))
  };
}

function requestSession(request, action, { cookie, generation, body, headers = {} } = {}) {
  return request(`/api/auth/session/${action}`, {
    method: 'POST', body,
    headers: {
      ...browserHeaders, ...(cookie ? { cookie } : {}),
      ...(generation ? { 'x-setscope-session': generation } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers
    }
  });
}

async function login(request, owner = 'a', previous = {}) {
  const response = await requestSession(request, 'login', {
    ...previous, body: { email: `${owner}@example.test`, password: 'fixture-password', rememberDevice: true }
  });
  return { response, cookie: response.headers['set-cookie']?.split(';')[0], generation: response.body?.generation };
}

module.exports = { fixture, login, requestSession, browserHeaders, origin, upstream, lifetime, owners };
