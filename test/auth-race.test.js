'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const authSource = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...values) { values.forEach(value => this.values.add(value)); }
  remove(...values) { values.forEach(value => this.values.delete(value)); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value); else this.values.delete(value);
    return enabled;
  }
}

class FakeNode {
  constructor() {
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.attributes = new Map();
    this.fields = {};
    this.submit = { disabled: false };
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === '[type=submit]' ? this.submit : null; }
  reset() { this.resetCalled = true; }
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ownerFor(value) {
  return String(value).toLowerCase().includes('user-b') || String(value).toLowerCase().includes('b@')
    || String(value).toLowerCase().includes('token-b') || String(value).toLowerCase().includes('refresh-b') ? 'user-b' : 'user-a';
}

async function createHarness({ initialSession = { access_token: 'token-a', refresh_token: 'refresh-a', expires_at: Date.now() + 3_600_000 }, holds = [], protectedStatuses = [], initialLocation = {}, initialReturn = '', initialReturnIntent = '' } = {}) {
  const nodes = new Map();
  const getNode = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode());
    return nodes.get(selector);
  };
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  if(initialReturn)sessionStorage.setItem('setscope-auth-return-v1',initialReturn);
  if(initialReturnIntent)sessionStorage.setItem('setscope-auth-return-intent-v1',initialReturnIntent);
  if (initialSession) sessionStorage.setItem('setscope-auth-session-v1', JSON.stringify(initialSession));
  const holdKeys = new Set(holds);
  const pending = new Map();
  const calls = [];
  const timers = new Map();
  let timerId = 0;

  function requestKey(input, init) {
    const url = String(input);
    if (url === '/api/auth-config') return 'config';
    if (url.endsWith('/auth/v1/user')) {
      if (init.method === 'PUT') return 'password-update';
      const token = String(init.headers?.Authorization || init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      return `user:${token}`;
    }
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) return `refresh:${JSON.parse(init.body).refresh_token}`;
    if (url.includes('/auth/v1/token?grant_type=password')) return `login:${JSON.parse(init.body).email}`;
    if (url.includes('/auth/v1/signup?')) return `signup:${JSON.parse(init.body).email}`;
    if (url.endsWith('/auth/v1/logout?scope=local')) return 'logout';
    if (url.includes('/auth/v1/recover?')) return 'recover';
    if (url.includes('/auth/v1/resend?')) return 'resend';
    if (url === '/api/protected') return 'protected';
    return url;
  }

  function defaultResponse(key) {
    if (key === 'config') return jsonResponse({ configured: true, url: 'https://project.supabase.co', anonKey: 'publishable-test' });
    if (key.startsWith('user:')) {
      const owner = ownerFor(key);
      return jsonResponse({ id: owner, email: `${owner}@example.test` });
    }
    if (key.startsWith('refresh:')) {
      const owner = ownerFor(key);
      return jsonResponse({ access_token: `token-${owner}-refreshed`, refresh_token: `refresh-${owner}-next`, expires_in: 3600 });
    }
    if (key.startsWith('login:')) {
      const owner = ownerFor(key);
      return jsonResponse({ access_token: `token-${owner}`, refresh_token: `refresh-${owner}`, expires_in: 3600, user: { id: owner, email: `${owner}@example.test` } });
    }
    if (key.startsWith('signup:')) {
      const owner = ownerFor(key);
      return jsonResponse({ access_token: `token-${owner}`, refresh_token: `refresh-${owner}`, expires_in: 3600, user: { id: owner, email: `${owner}@example.test` } });
    }
    if (key === 'logout') return new Response(null, { status: 204 });
    if (['recover', 'resend', 'password-update'].includes(key)) return jsonResponse({});
    if (key === 'protected') return new Response('', { status: protectedStatuses.shift() ?? 200 });
    throw new Error(`Unexpected request ${key}`);
  }

  const fetch = async (input, init = {}) => {
    const key = requestKey(input, init);
    calls.push({ key, input: String(input), init });
    if (!holdKeys.has(key)) return defaultResponse(key);
    const wait = deferred();
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(wait);
    return wait.promise;
  };

  const events = [];
  const listeners = new Map();
  const location = { pathname: '/', search: '', hash: '#watchlist', ...initialLocation };
  const window = {
    location: { origin: 'https://setscope.example', reload: () => { window.reloadCount += 1; } },
    reloadCount: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { events.push(event); listeners.get(event.type)?.(event); },
    setscopeAuth: null
  };
  const document = {
    body: getNode('body'), documentElement: { dataset: {} }, title: '',
    querySelector: getNode, querySelectorAll: () => []
  };
  const applyHistoryUrl = value => {
    const url = new URL(String(value), 'https://setscope.example');
    Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash });
  };
  const history = {
    replaceState(_state, _title, value) { applyHistoryUrl(value); },
    pushState(_state, _title, value) { applyHistoryUrl(value); }
  };
  class FakeFormData {
    constructor(form) { this.fields = { ...form.fields }; }
    get(key) { return this.fields[key]; }
  }
  class FakeCustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const context = vm.createContext({
    AbortController, AbortSignal, console, CustomEvent: FakeCustomEvent, document, fetch,
    FormData: FakeFormData, Headers, history, localStorage, location, Math, Response,
    sessionStorage,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay, cancelled: false }); return id; },
    clearTimeout(id) { if (timers.has(id)) timers.get(id).cancelled = true; },
    URL, URLSearchParams, window
  });
  vm.runInContext(authSource, context, { filename: 'auth.js' });
  window.addEventListener('setscope:authenticated', event => window.setscopeAuth.markPrivateUiReady({
    ownerId: event.detail.userId, generation: event.detail.generation
  }));

  async function settle(turns = 8) { for (let index = 0; index < turns; index++) await flush(); }
  async function waitForPending(key, count = 1) {
    for (let index = 0; index < 40; index++) {
      if ((pending.get(key) || []).length >= count) return;
      await flush();
    }
    throw new Error(`Pending request not observed: ${key}`);
  }
  function resolvePending(key, body, status = 200, index = 0) {
    const wait = pending.get(key)?.[index];
    if (!wait) throw new Error(`No pending request: ${key}[${index}]`);
    wait.resolve(jsonResponse(body, status));
  }
  function currentSession() {
    const value = sessionStorage.getItem('setscope-auth-session-v1');
    return value ? JSON.parse(value) : null;
  }
  function submit(selector, fields) {
    const form = getNode(selector); form.fields = fields;
    return form.listeners.get('submit')({ preventDefault() {}, currentTarget: form });
  }

  await settle();
  return {
    calls, currentSession, document, events, getNode, holdKeys, listeners, pending, location,
    resolvePending, sessionStorage, settle, submit, timers, waitForPending, window
  };
}

test('normal login ignores legacy Profile return state but retains explicit protected-route intent',async()=>{
  for(const route of ['/#profile','/?tab=old#profile','https://untrusted.invalid/#profile']){
    const h=await createHarness({initialSession:null,initialLocation:{pathname:'/login',search:'',hash:''},initialReturn:route});
    await h.submit('#login-form',{email:'a@example.test',password:'fixture'});
    assert.equal(h.location.hash,'#overview');assert.equal(h.sessionStorage.getItem('setscope-auth-return-v1'),null);
  }
  for(const [hash,search] of [['#profile',''],['#news','?source=infoquest&query=PTT&page=2'],['#chart','?symbol=CPALL&range=1y'],['#watchlist','?watchPage=2']]){
    const h=await createHarness({initialSession:null,initialLocation:{pathname:'/',hash,search}});
    assert.equal(h.location.pathname,'/login');
    await h.submit('#login-form',{email:'a@example.test',password:'fixture'});
    assert.equal(h.location.hash,hash);assert.equal(h.location.search,search);
  }
});

test('intent survives login-page reload while explicit Profile logout starts the next account at Overview',async()=>{
  const route='/?source=infoquest&query=PTT&page=2#news';
  const resumed=await createHarness({initialSession:null,initialLocation:{pathname:'/login',search:'',hash:''},initialReturn:route,initialReturnIntent:route});
  await resumed.submit('#login-form',{email:'a@example.test',password:'fixture'});
  assert.equal(resumed.location.hash,'#news');assert.equal(resumed.location.search,'?source=infoquest&query=PTT&page=2');
  const h=await createHarness({initialLocation:{hash:'#profile'}});
  assert.equal(h.location.hash,'#profile','validated active session keeps the explicitly opened Profile');
  await h.getNode('#profile-logout-button').listeners.get('click')();
  assert.equal(h.sessionStorage.getItem('setscope-auth-return-v1'),null);
  assert.equal(h.sessionStorage.getItem('setscope-auth-return-intent-v1'),null);
  await h.submit('#login-form',{email:'b@example.test',password:'fixture'});
  assert.equal(h.location.hash,'#overview');assert.equal(h.window.setscopeAuth.user.id,'user-b');
});

test('stale refresh success and failure cannot replace or clear a newer account session', async () => {
  for (const failure of [false, true]) {
    const harness = await createHarness({ holds: ['refresh:refresh-a'] });
    assert.equal(harness.window.setscopeAuth.user.id, 'user-a');
    const refresh = harness.window.setscopeAuth.refresh();
    await harness.waitForPending('refresh:refresh-a');

    await harness.getNode('#profile-logout-button').listeners.get('click')();
    await harness.submit('#login-form', { email: 'b@example.test', password: 'secret' });
    assert.equal(harness.window.setscopeAuth.user.id, 'user-b');

    harness.resolvePending('refresh:refresh-a', failure
      ? { error: 'invalid refresh token' }
      : { access_token: 'stale-a-access', refresh_token: 'stale-a-refresh', expires_in: 3600 }, failure ? 400 : 200);
    assert.equal(await refresh, false);
    await harness.settle();
    assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
    assert.equal(harness.currentSession().access_token, 'token-user-b');
    assert.equal(harness.document.body.classList.contains('authenticated'), true);
  }
});

test('startup validation response from A is discarded once B login begins', async () => {
  const harness = await createHarness({ holds: ['user:token-a'] });
  await harness.waitForPending('user:token-a');
  await harness.submit('#login-form', { email: 'b@example.test', password: 'secret' });
  assert.equal(harness.window.setscopeAuth.user.id, 'user-b');

  harness.resolvePending('user:token-a', { id: 'user-a', email: 'a@example.test' });
  await harness.settle();
  assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
  assert.equal(harness.currentSession().access_token, 'token-user-b');
  assert.equal(harness.events.filter(event => event.type === 'setscope:authenticated').at(-1).detail.userId, 'user-b');
});

test('older login and signup responses cannot win over a newer login', async () => {
  for (const pendingKind of ['login:a@example.test', 'signup:a@example.test']) {
    const harness = await createHarness({ initialSession: null, holds: [pendingKind] });
    const pendingAuth = pendingKind.startsWith('login:')
      ? harness.submit('#login-form', { email: 'a@example.test', password: 'secret' })
      : harness.submit('#signup-form', { email: 'a@example.test', password: 'secret', confirmPassword: 'secret' });
    await harness.waitForPending(pendingKind);

    await harness.submit('#login-form', { email: 'b@example.test', password: 'secret' });
    harness.resolvePending(pendingKind, { access_token: 'stale-a-access', refresh_token: 'stale-a-refresh', expires_in: 3600, user: { id: 'user-a', email: 'a@example.test' } });
    await pendingAuth;
    await harness.settle();

    assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
    assert.equal(harness.currentSession().access_token, 'token-user-b');
  }
});

test('pending login and signup responses cannot restore a session after logout', async () => {
  for (const pendingKind of ['login:a@example.test', 'signup:a@example.test']) {
    const harness = await createHarness({ initialSession: null, holds: [pendingKind] });
    const pendingAuth = pendingKind.startsWith('login:')
      ? harness.submit('#login-form', { email: 'a@example.test', password: 'secret' })
      : harness.submit('#signup-form', { email: 'a@example.test', password: 'secret', confirmPassword: 'secret' });
    await harness.waitForPending(pendingKind);

    await harness.getNode('#profile-logout-button').listeners.get('click')();
    harness.resolvePending(pendingKind, { access_token: 'stale-a-access', refresh_token: 'stale-a-refresh', expires_in: 3600, user: { id: 'user-a', email: 'a@example.test' } });
    await pendingAuth;
    await harness.settle();

    assert.equal(harness.window.setscopeAuth.user, null);
    assert.equal(harness.currentSession(), null);
    assert.equal(harness.document.body.classList.contains('authenticated'), false);
  }
});

test('stale logout completion cannot replace or reload a newer account session', async () => {
  const harness = await createHarness({ holds: ['logout'] });
  const logout = harness.getNode('#profile-logout-button').listeners.get('click')();
  await harness.waitForPending('logout');
  assert.equal(harness.currentSession(), null);
  assert.equal(harness.window.reloadCount, 0);

  await harness.submit('#login-form', { email: 'b@example.test', password: 'secret' });
  assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
  assert.equal(harness.currentSession().access_token, 'token-user-b');

  harness.resolvePending('logout', {});
  await logout;
  await harness.settle();
  assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
  assert.equal(harness.currentSession().access_token, 'token-user-b');
  assert.equal(harness.document.body.classList.contains('authenticated'), true);
  assert.equal(harness.window.reloadCount, 0);
});

test('ordinary logout still clears the active session and reloads the login route', async () => {
  const harness = await createHarness();
  await harness.getNode('#profile-logout-button').listeners.get('click')();
  await harness.settle();
  assert.equal(harness.window.setscopeAuth.user, null);
  assert.equal(harness.currentSession(), null);
  assert.equal(harness.document.body.classList.contains('authenticated'), false);
  assert.equal(harness.window.reloadCount, 1);
});

test('logout is scoped to this device and preserves an independent device session', async () => {
  const firstDevice = await createHarness();
  const secondDevice = await createHarness({ protectedStatuses: [401, 200] });
  await firstDevice.getNode('#profile-logout-button').listeners.get('click')();
  await firstDevice.settle();

  const revoke = firstDevice.calls.find(call => call.key === 'logout');
  assert.ok(revoke, 'Supabase logout endpoint must be called');
  assert.equal(new URL(revoke.input).searchParams.get('scope'), 'local');
  assert.equal(firstDevice.currentSession(), null);
  assert.equal(secondDevice.window.setscopeAuth.user.id, 'user-a');
  assert.equal(secondDevice.currentSession().access_token, 'token-a');
  const identity = secondDevice.window.setscopeAuth.captureIdentity();
  const protectedResult = await secondDevice.window.setscopeAuth.authorizedFetch('/api/protected');
  assert.equal(protectedResult.status, 200);
  assert.equal(secondDevice.calls.filter(call => call.key === 'refresh:refresh-a').length, 1);
  assert.equal(secondDevice.currentSession().access_token, 'token-user-a-refreshed');
  assert.deepEqual(secondDevice.window.setscopeAuth.captureIdentity(), identity);
});

test('401 refresh and an old refresh timer cannot expire a newer login', async () => {
  const harness = await createHarness({ holds: ['refresh:refresh-a'], protectedStatuses: [401] });
  const oldTimer = [...harness.timers.values()].find(timer => timer.delay >= 15_000)?.callback;
  assert.equal(typeof oldTimer, 'function');

  const request = harness.window.setscopeAuth.authorizedFetch('/api/protected');
  await harness.waitForPending('refresh:refresh-a');
  await harness.submit('#login-form', { email: 'b@example.test', password: 'secret' });
  harness.resolvePending('refresh:refresh-a', { error: 'expired A refresh' }, 400);
  await assert.rejects(request, error => error?.code === 'STALE_SESSION');

  await oldTimer();
  await harness.settle();
  assert.equal(harness.calls.filter(call => call.key === 'refresh:refresh-a').length, 1);
  assert.equal(harness.window.setscopeAuth.user.id, 'user-b');
  assert.equal(harness.currentSession().access_token, 'token-user-b');
  assert.equal(harness.window.reloadCount, 0);
});

test('concurrent same-session refreshes coalesce and preserve owner generation', async () => {
  const harness = await createHarness({ holds: ['refresh:refresh-a'] });
  const identity = harness.window.setscopeAuth.captureIdentity();
  const first = harness.window.setscopeAuth.refresh();
  const second = harness.window.setscopeAuth.refresh();
  await harness.waitForPending('refresh:refresh-a');
  assert.equal(harness.calls.filter(call => call.key === 'refresh:refresh-a').length, 1);

  harness.resolvePending('refresh:refresh-a', { access_token: 'token-a-new', refresh_token: 'refresh-a-new', expires_in: 3600 });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(harness.currentSession().access_token, 'token-a-new');
  assert.deepEqual(harness.window.setscopeAuth.captureIdentity(), identity);
});

test('active refresh failure expires private UI without retrying private requests or deleting owner data', async () => {
  const harness = await createHarness({ holds: ['refresh:refresh-a'], protectedStatuses: [401] });
  const savedWatchlist = JSON.stringify({ ownerId: 'user-a', items: [{ symbol: 'PTT' }] });
  harness.sessionStorage.setItem('fixture-owner-watchlist', savedWatchlist);
  const request = harness.window.setscopeAuth.authorizedFetch('/api/protected');
  const rejected = assert.rejects(request);
  await harness.waitForPending('refresh:refresh-a');
  harness.resolvePending('refresh:refresh-a', { error: 'fixture expired refresh' }, 400);
  await rejected;
  assert.equal(harness.currentSession(), null);
  assert.equal(harness.document.body.classList.contains('authenticated'), false);
  assert.equal(harness.getNode('#app-shell').attributes.get('aria-hidden'), 'true');
  assert.equal(harness.sessionStorage.getItem('fixture-owner-watchlist'), savedWatchlist);
  assert.equal(harness.calls.filter(call => call.key === 'protected').length, 1);
  await assert.rejects(harness.window.setscopeAuth.authorizedFetch('/api/protected'));
  assert.equal(harness.calls.filter(call => call.key === 'protected').length, 1);
});

test('callback credentials leave the URL before auth config completes and persist only session fields', async () => {
  const harness = await createHarness({ initialSession: null, holds: ['config'], initialLocation: {
    pathname: '/login', hash: '#access_token=token-a&refresh_token=refresh-a&expires_in=3600&provider_token=fixture-provider'
  } });
  assert.equal(harness.location.hash, '');
  assert.equal(harness.currentSession(), null);
  harness.resolvePending('config', { configured: true, url: 'https://project.supabase.co', anonKey: 'publishable-test' });
  await harness.settle();
  assert.equal(harness.window.setscopeAuth.user.id, 'user-a');
  assert.deepEqual(Object.keys(harness.currentSession()).sort(), ['access_token', 'expires_at', 'refresh_token']);
  assert.equal(harness.window.setscopeAuth.accessToken, undefined);
});

test('authenticated fetch rejects non-API or foreign destinations before making any request', async () => {
  const harness = await createHarness();
  const before = harness.calls.length;
  for (const url of ['https://external.example/api/news', '//external.example/api/news', 'https://other.supabase.co/auth/v1/user', '/login', '/api/../outside']) {
    await assert.rejects(harness.window.setscopeAuth.authorizedFetch(url), error => error.code === 'UNSAFE_AUTH_TARGET');
  }
  assert.equal(harness.calls.length, before);
  const response = await harness.window.setscopeAuth.authorizedFetch('/api/protected');
  assert.equal(response.status, 200);
  assert.equal(harness.calls.at(-1).init.redirect, 'error');
  assert.equal(harness.calls.at(-1).init.referrerPolicy, 'no-referrer');
  let conversions = 0;
  const changingTarget = { toString() { return ++conversions === 1 ? '/api/protected' : 'https://external.example/api/news'; } };
  assert.equal((await harness.window.setscopeAuth.authorizedFetch(changingTarget)).status, 200);
  assert.equal(conversions, 1);
  assert.equal(harness.calls.at(-1).input, '/api/protected');
});

test('rejected rotated token fails closed after one refresh retry', async () => {
  const harness = await createHarness({ protectedStatuses: [401, 401] });
  await assert.rejects(harness.window.setscopeAuth.authorizedFetch('/api/protected'));
  assert.equal(harness.currentSession(), null);
  assert.equal(harness.document.body.classList.contains('authenticated'), false);
  assert.equal(harness.calls.filter(call => call.key === 'protected').length, 2);
  assert.equal(harness.calls.filter(call => call.key === 'refresh:refresh-a').length, 1);
});

test('login response metadata is not retained in session storage', async () => {
  const harness = await createHarness({ initialSession: null });
  await harness.submit('#login-form', { email: 'a@example.test', password: 'fixture' });
  assert.deepEqual(Object.keys(harness.currentSession()).sort(), ['access_token', 'expires_at', 'refresh_token']);
});

test('invalid stored expiry never initializes a private session', async () => {
  for (const expires_at of [null, 'invalid', -1]) {
    const harness = await createHarness({ initialSession: { access_token: 'token-a', refresh_token: 'refresh-a', expires_at } });
    assert.equal(harness.currentSession(), null);
    assert.equal(harness.window.setscopeAuth.user, null);
    assert.equal(harness.document.body.classList.contains('authenticated'), false);
    assert.equal(harness.calls.filter(call => call.key.startsWith('user:')).length, 0);
  }
});

test('malformed refresh expiry cannot overwrite valid stored tokens', async () => {
  for (const expires_in of ['invalid', 0, 1e308]) {
    const harness = await createHarness({ holds: ['refresh:refresh-a'] });
    const before = harness.currentSession();
    const refresh = harness.window.setscopeAuth.refresh();
    await harness.waitForPending('refresh:refresh-a');
    harness.resolvePending('refresh:refresh-a', { access_token: 'fixture-invalid-new', refresh_token: 'fixture-invalid-refresh', expires_in });
    assert.equal(await refresh, false);
    assert.deepEqual(harness.currentSession(), before);
  }
});

test('Profile renders only current validated email and email verification, then clears on logout', async () => {
  const h = await createHarness({ holds: ['user:token-a'] });
  assert.equal(h.getNode('#profile-email').textContent, '');
  h.resolvePending('user:token-a', { id: 'user-a', email: '<a>@example.test', confirmed_at: '2026-01-01T00:00:00Z' });
  await h.settle();
  assert.equal(h.getNode('#profile-email').textContent, '<a>@example.test');
  assert.equal(h.getNode('#profile-verification').textContent, 'ยังไม่ยืนยันอีเมล');
  assert.equal(h.getNode('#profile-verification-button').hidden, false);
  await h.getNode('#profile-logout-button').listeners.get('click')();
  assert.equal(h.getNode('#profile-email').textContent, '—');
  assert.equal(h.getNode('#profile-verification').textContent, '—');
  assert.equal(h.getNode('#user-avatar').title, '');
  await h.submit('#login-form', { email: 'b@example.test', password: 'fixture' });
  assert.equal(h.getNode('#profile-email').textContent, 'user-b@example.test');
});

test('Profile verification comes from email_confirmed_at, never user metadata', async () => {
  for (const email_confirmed_at of [null, 'invalid', '2026-01-01T00:00:00Z']) {
    const h = await createHarness({ holds: ['user:token-a'] });
    h.resolvePending('user:token-a', { id: 'user-a', email: 'a@example.test', email_confirmed_at, user_metadata: { email_verified: true } });
    await h.settle();
    assert.equal(h.getNode('#profile-verification').textContent, email_confirmed_at?.startsWith('2026') ? 'ยืนยันอีเมลแล้ว' : 'ยังไม่ยืนยันอีเมล');
  }
});

test('Profile and Screener deep links survive mandatory login through the existing safe return route', async () => {
  for (const hash of ['#profile', '#screener']) {
    const h = await createHarness({ initialSession: null, initialLocation: { pathname: '/', search: '', hash } });
    assert.equal(h.document.body.classList.contains('authenticated'), false);
    assert.equal(h.location.pathname, '/login');
    await h.submit('#login-form', { email: 'a@example.test', password: 'fixture' });
    assert.equal(h.location.hash, hash);
  }
});

test('forgot password is bounded, uses same-origin redirect and a generic response', async () => {
  const h = await createHarness({ initialSession: null, holds: ['recover'] });
  const sending = h.submit('#forgot-password-form', { email: 'nobody@example.test' });
  await h.waitForPending('recover');
  await h.submit('#forgot-password-form', { email: 'nobody@example.test' });
  assert.equal(h.calls.filter(c => c.key === 'recover').length, 1);
  const call = h.calls.at(-1);
  assert.equal(new URL(call.input).searchParams.get('redirect_to'), 'https://setscope.example');
  assert.equal(call.init.headers.Authorization, undefined);
  h.resolvePending('recover', {}); await sending;
  assert.equal(h.getNode('#auth-message').textContent, 'โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่');
  assert.equal(h.document.body.classList.contains('authenticated'), false);
});

test('recovery success uses the same approved text for existing and absent accounts without signup or lookup',async()=>{
  const text='โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่';
  for(const profile of [false,true])for(const exists of [false,true]){
    const h=await createHarness({initialSession:profile?{access_token:'token-a',refresh_token:'refresh-a',expires_at:Date.now()+3600000}:null,holds:['recover']});
    const button=h.getNode(profile?'#profile-recovery-button':'#forgot-password-form').querySelector?.('[type=submit]');
    const sending=profile?h.getNode('#profile-recovery-button').listeners.get('click')({currentTarget:h.getNode('#profile-recovery-button')})
      :h.submit('#forgot-password-form',{email:exists?'registered@example.test':'absent@example.test'});
    await h.waitForPending('recover');
    assert.notEqual(h.getNode(profile?'#profile-message':'#auth-message').textContent,text,'success is not displayed before response');
    h.resolvePending('recover',exists?{message:'private-existing-account',user:{id:'synthetic'}}:{});await sending;
    assert.equal(h.getNode(profile?'#profile-message':'#auth-message').textContent,text);
    assert.equal(h.calls.filter(c=>c.key==='recover').length,1);
    assert.equal(h.calls.some(c=>c.key.startsWith('signup:')),false);
    if(!profile){
      assert.equal(h.calls.some(c=>c.key.startsWith('user:')),false,'forgot flow performs no account lookup');
      assert.equal(h.currentSession(),null);assert.equal(h.window.setscopeAuth.user,null,'successful email request never signs in or creates an account');
    }
    assert.equal(profile?h.getNode('#profile-recovery-button').disabled:button.disabled,false);
  }
});

test('recovery network and server failures retain the generic error and never show success or provider details',async()=>{
  for(const profile of [false,true])for(const failure of ['network',429,500]){
    const h=await createHarness({initialSession:profile?{access_token:'token-a',refresh_token:'refresh-a',expires_at:Date.now()+3600000}:null,holds:['recover']});
    const sending=profile?h.getNode('#profile-recovery-button').listeners.get('click')({currentTarget:h.getNode('#profile-recovery-button')})
      :h.submit('#forgot-password-form',{email:'absent@example.test'});
    await h.waitForPending('recover');
    if(failure==='network')h.pending.get('recover')[0].reject(new TypeError('private-network-detail'));
    else h.resolvePending('recover',{msg:'private-account-registration-detail'},failure);
    await sending;
    assert.equal(h.getNode(profile?'#profile-message':'#auth-message').textContent,'ส่งอีเมลไม่สำเร็จ กรุณารอสักครู่แล้วลองอีกครั้ง');
  }
});

test('delayed Profile email responses never render into a newer account', async () => {
  for (const [selector, key] of [['#profile-recovery-button', 'recover'], ['#profile-verification-button', 'resend']]) {
    const h = await createHarness({ holds: [key] });
    const button = h.getNode(selector);
    const sending = button.listeners.get('click')({ currentTarget: button });
    await h.waitForPending(key);
    assert.equal(JSON.parse(h.calls.at(-1).init.body).email, 'user-a@example.test');
    await h.getNode('#profile-logout-button').listeners.get('click')();
    await h.submit('#login-form', { email: 'b@example.test', password: 'fixture' });
    h.resolvePending(key, { message: 'private-provider-error' }, 429); await sending;
    assert.equal(h.getNode('#profile-email').textContent, 'user-b@example.test');
    assert.equal(h.getNode('#profile-message').textContent, '');
  }
});

test('recovery callback is scrubbed and validated before accepting a matching password', async () => {
  const h = await createHarness({ initialSession: null, initialLocation: { hash: '#access_token=token-a&refresh_token=refresh-a&type=recovery&expires_in=3600' } });
  assert.equal(h.location.hash, '');
  assert.equal(h.getNode('#recovery-form').hidden, false);
  assert.equal(h.window.setscopeAuth.user, null);
  assert.equal(h.document.body.classList.contains('authenticated'), false);
  assert.equal(h.events.some(e => e.type === 'setscope:authenticated'), false);
  await h.submit('#recovery-form', { password: 'long-fixture-value', confirmPassword: 'different-fixture-value' });
  assert.equal(h.calls.some(c => c.key === 'password-update'), false);
  await h.submit('#recovery-form', { password: 'long-fixture-value', confirmPassword: 'long-fixture-value' });
  assert.equal(h.calls.filter(c => c.key === 'password-update').length, 1);
  assert.equal(h.calls.find(c => c.key === 'password-update').init.method, 'PUT');
  assert.equal(h.calls.filter(c => c.key === 'logout').length, 1);
  assert.equal(h.currentSession(), null);
  assert.equal(h.getNode('#recovery-form').resetCalled, true);
});

test('invalid recovery callback never opens the workspace or permits password updates', async () => {
  const h = await createHarness({ initialSession: null, holds: ['user:token-a'], initialLocation: { hash: '#access_token=token-a&refresh_token=refresh-a&type=recovery' } });
  await h.submit('#recovery-form', { password: 'long-fixture-value', confirmPassword: 'long-fixture-value' });
  assert.equal(h.calls.some(c => c.key === 'password-update'), false);
  h.resolvePending('user:token-a', { error: 'expired' }, 401); await h.settle();
  assert.equal(h.currentSession(), null);
  assert.equal(h.getNode('#recovery-form').hidden, true);
  assert.equal(h.document.body.classList.contains('authenticated'), false);
});

test('delayed password update cannot log out a later login', async () => {
  const h = await createHarness({ initialSession: null, holds: ['password-update'], initialLocation: { hash: '#access_token=token-a&refresh_token=refresh-a&type=recovery' } });
  const updating = h.submit('#recovery-form', { password: 'long-fixture-value', confirmPassword: 'long-fixture-value' });
  await h.waitForPending('password-update');
  await h.getNode('#recovery-cancel-button').listeners.get('click')();
  await h.submit('#login-form', { email: 'b@example.test', password: 'fixture' });
  h.resolvePending('password-update', {}); await updating;
  assert.equal(h.window.setscopeAuth.user.id, 'user-b');
  assert.equal(h.calls.filter(c => c.key === 'logout').length, 1);
});
