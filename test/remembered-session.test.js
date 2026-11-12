'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { allowsWatchlistAccess } = require('../server/remembered-session');
const { fixture, login, requestSession, browserHeaders, lifetime, owners } = require('./fixtures/remembered-session.cjs');

const routes = [
  '/api/watchlists', '/api/watchlist-news', '/api/news-analysis', '/api/coverage', '/api/search',
  '/api/market-overview', '/api/settrade-overview', '/api/market', '/api/news', '/api/news-archive',
  '/api/screener', '/api/screener/coverage', '/api/unknown'
];
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
const privateRequest = (request, { cookie, generation }, headers = {}) => request('/api/screener', {
  headers: { ...browserHeaders, cookie, 'x-setscope-session': generation, ...headers }
});

function holdRefresh(f) {
  let started, release;
  const pending = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.control.pauseRefresh = () => { started(); return held; };
  return { pending, release };
}

test('production-shaped bootstrap, unverified Data API and explicit OFF cannot issue a remembered cookie', async () => {
  const f = fixture();
  const legacy = f.legacy('a').access_token;
  for (const request of [f.app({ wireStore: false }), f.app({ verified: false }), f.app({ issue: false })]) {
    assert.equal((await request('/api/auth-config')).body.rememberDevice, undefined);
    assert.equal((await login(request)).response.status, 404);
    assert.equal((await request('/api/screener', bearer(legacy))).status, 410);
  }
  const off = await requestSession(f.app(), 'login', { body: { email: 'a@example.test', password: 'fixture-password', rememberDevice: false } });
  assert.equal(off.status, 400);
  assert.equal(off.headers['set-cookie'], undefined);
  assert.equal(f.stats.login, 0);
});

test('issues a fresh opaque cookie after verified login and retains only encrypted tokens', async () => {
  const f = fixture(), request = f.app();
  const denied = await login(request, 'wrong');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.cookie, undefined);
  const a = await login(request);
  assert.equal(a.response.status, 200);
  assert.match(a.response.headers['set-cookie'], /^__Host-setscope-remember=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800$/);
  assert.equal(a.response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(a.response.body).sort(), ['generation', 'remainingMs', 'user']);
  const row = Object.values(f.state.rows)[0];
  const upstream = f.sessions.get(row.providerSessionId);
  assert.ok(row.encrypted && !JSON.stringify(row).includes(upstream.refreshToken) && !JSON.stringify(row).includes(upstream.accessToken));
  assert.equal(a.cookie.includes(row.digest), false);
  assert.equal((await privateRequest(request, a)).status, 410);
  assert.equal((await requestSession(request, 'restore', { cookie: a.cookie })).body.user.id, owners.a);
});

test('expiry at −1/0/+1 second is enforced through the router and survives rehydration', async () => {
  const f = fixture(), a = await login(f.app());
  f.advance(lifetime - 1000);
  const rehydrated = f.app({ records: f.snapshot() });
  assert.equal((await requestSession(rehydrated, 'restore', a)).body.remainingMs, 1000);
  const upstream = [...f.sessions.values()][0];
  for (const offset of [0, 1000]) {
    f.advance(1000);
    assert.equal((await privateRequest(rehydrated, a)).status, 401, `expiry +${offset}`);
    assert.equal((await requestSession(rehydrated, 'refresh', a)).status, 401);
    assert.equal((await rehydrated('/api/screener', bearer(upstream.accessToken))).status, 401);
  }
  assert.equal(f.stats.refresh, 1);
});

test('two server instances share the refresh lease and only one rotation advances the version', async () => {
  const f = fixture(), first = f.app(), second = f.app(), a = await login(first);
  const row = Object.values(f.state.rows)[0], expiresAt = row.expiresAt;
  f.advance(3_600_000);
  const gate = holdRefresh(f);
  const updating = requestSession(first, 'refresh', a);
  await gate.pending;
  try { assert.equal((await requestSession(second, 'refresh', a)).status, 503); }
  finally { gate.release(); }
  assert.equal((await updating).status, 200);
  assert.equal(f.stats.refresh, 1);
  assert.equal(row.version, 1);
  assert.equal(row.expiresAt, expiresAt);
  assert.equal((await privateRequest(second, a)).status, 410);
});

test('logout wins a pending refresh and Bearer replay is denied across all private routes', async () => {
  const f = fixture(), first = f.app(), second = f.app(), a = await login(first);
  const other = await login(second);
  f.advance(3_600_000);
  const gate = holdRefresh(f);
  const updating = requestSession(first, 'refresh', a);
  await gate.pending;
  const rotated = [...f.sessions.values()][0].accessToken;
  try {
    const loggedOut = await requestSession(second, 'logout', a);
    assert.equal(loggedOut.status, 200);
    assert.match(loggedOut.headers['set-cookie'], /Max-Age=0$/);
    for (const route of routes) assert.equal((await second(route, bearer(rotated))).status, 401, route);
    assert.equal((await second('/api/watchlists', { method: 'PUT', ...bearer(rotated) })).status, 401);
  } finally { gate.release(); }
  assert.equal((await updating).status, 401);
  assert.equal((await requestSession(second, 'restore', a)).status, 401);
  assert.equal((await privateRequest(second, other)).status, 410);
  assert.equal(f.stats.logout, 1);
});

test('A → B → A retires each prior handle and stale tab requests cannot act under the new cookie', async () => {
  const f = fixture(), request = f.app();
  const a = await login(request), b = await login(request, 'b', a), nextA = await login(request, 'a', b);
  for (const old of [a, b]) {
    assert.equal((await requestSession(request, 'restore', old)).status, 401);
    const stale = { ...old, cookie: nextA.cookie };
    assert.equal((await privateRequest(request, stale)).status, 401);
    assert.equal((await requestSession(request, 'logout', stale)).headers['set-cookie'], undefined);
  }
  assert.equal((await requestSession(request, 'restore', nextA)).body.user.id, owners.a);
  assert.equal(new Set([a.cookie, b.cookie, nextA.cookie]).size, 3);
});

test('CSRF, cookie ambiguity, and mixed credentials fail before issuing or using a session', async () => {
  const f = fixture(), request = f.app(), a = await login(request);
  assert.equal((await login(request, 'a', { headers: { origin: 'https://attacker.test' } })).response.status, 403);
  assert.equal((await requestSession(request, 'logout', { ...a, headers: { 'x-setscope-request': '' } })).status, 403);
  assert.equal((await privateRequest(request, a, { origin: 'https://attacker.test' })).status, 403);
  assert.equal((await privateRequest(request, { ...a, cookie: `${a.cookie}; ${a.cookie}` })).status, 401);
  assert.equal((await privateRequest(request, a, bearer(f.legacy('a').access_token).headers)).status, 401);
  assert.equal((await privateRequest(request, a, { origin: undefined, 'sec-fetch-site': 'same-origin' })).status, 410);
  assert.equal((await privateRequest(request, a, { origin: undefined, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await privateRequest(request, a, { 'x-setscope-request': '' })).status, 403);
  assert.equal(f.stats.login, 1);
});

test('store outage fails closed and disabling issuance retains replay guards and logout', async () => {
  const f = fixture(), running = f.app(), a = await login(running), stopped = f.app({ issue: false });
  const legacy = f.legacy('a').access_token, remembered = [...f.sessions.values()][0].accessToken;
  f.state.offline = true;
  assert.equal((await requestSession(running, 'restore')).status, 401);
  assert.equal((await privateRequest(running, a)).status, 503);
  assert.equal((await stopped('/api/screener', bearer(legacy))).status, 503);
  assert.equal((await requestSession(stopped, 'logout', a)).headers['set-cookie'], undefined);
  f.state.offline = false;
  assert.equal((await login(stopped)).response.status, 404);
  assert.equal((await requestSession(stopped, 'restore', a)).status, 401);
  assert.equal((await privateRequest(stopped, a)).status, 401);
  assert.equal((await stopped('/api/screener', bearer(remembered))).status, 401);
  assert.equal((await stopped('/api/screener', bearer(legacy))).status, 410);
  assert.equal((await requestSession(stopped, 'logout', a)).status, 200);
  assert.equal((await stopped('/api/screener', bearer(remembered))).status, 401);
});

test('an ambiguous refresh write and mismatched provider session fail closed', async () => {
  for (const invalidClaim of [false, true]) {
    const f = fixture(), request = f.app(), a = await login(request);
    f.advance(3_600_000);
    if (invalidClaim) f.control.rotationClaims = { session_id: randomUUID() };
    else f.state.failFinish = true;
    assert.equal((await requestSession(request, 'refresh', a)).status, invalidClaim ? 401 : 503);
    assert.equal((await privateRequest(request, a)).status, 401);
    assert.equal(Object.values(f.state.rows)[0].encrypted, null);
  }
});

test('the offline Data API contract requires owner, validated session ID and an active registry entry', async () => {
  const f = fixture(), request = f.app(), a = await login(request);
  const row = Object.values(f.state.rows)[0];
  const attempt = { userId: owners.a, rowOwnerId: owners.a, providerSessionId: row.providerSessionId, remembered: row, now: f.now() };
  assert.equal(allowsWatchlistAccess(attempt), true);
  assert.equal(allowsWatchlistAccess({ ...attempt, rowOwnerId: owners.b }), false);
  assert.equal(allowsWatchlistAccess({ ...attempt, providerSessionId: 'unverified' }), false);
  assert.equal(allowsWatchlistAccess({ ...attempt, remembered: undefined }), false);
  assert.equal(allowsWatchlistAccess({ ...attempt, now: row.expiresAt }), false);
  assert.equal((await requestSession(request, 'logout', a)).status, 200);
  assert.equal(allowsWatchlistAccess(attempt), false);
  const legacy = f.legacy('a').access_token;
  const claims = JSON.parse(Buffer.from(legacy.split('.')[1], 'base64url'));
  assert.equal(allowsWatchlistAccess({ ...attempt, providerSessionId: claims.session_id, remembered: null }), true);
});

test('changing a JWT session ID cannot convert a remembered credential into a legacy one', async () => {
  const f = fixture(), request = f.app();
  await login(request);
  const [header, payload, signature] = [...f.sessions.values()][0].accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  claims.session_id = randomUUID();
  const tampered = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
  assert.equal((await request('/api/screener', bearer(tampered))).status, 401);
});
