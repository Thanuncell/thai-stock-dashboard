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

async function createHarness({ initialSession = { access_token: 'token-a', refresh_token: 'refresh-a', expires_at: Date.now() + 3_600_000 }, holds = [], protectedStatuses = [] } = {}) {
  const nodes = new Map();
  const getNode = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode());
    return nodes.get(selector);
  };
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
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
      const token = String(init.headers?.Authorization || init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      return `user:${token}`;
    }
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) return `refresh:${JSON.parse(init.body).refresh_token}`;
    if (url.includes('/auth/v1/token?grant_type=password')) return `login:${JSON.parse(init.body).email}`;
    if (url.includes('/auth/v1/signup?')) return `signup:${JSON.parse(init.body).email}`;
    if (url.endsWith('/auth/v1/logout')) return 'logout';
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
    if (key === 'logout') return new Response('', { status: 204 });
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
  const location = { pathname: '/', search: '', hash: '#watchlist' };
  const window = {
    location: { origin: 'https://setscope.example', reload: () => { window.reloadCount += 1; } },
    reloadCount: 0,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { events.push(event); },
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
    calls, currentSession, document, events, getNode, holdKeys, listeners, pending,
    resolvePending, sessionStorage, settle, submit, timers, waitForPending, window
  };
}

test('stale refresh success and failure cannot replace or clear a newer account session', async () => {
  for (const failure of [false, true]) {
    const harness = await createHarness({ holds: ['refresh:refresh-a'] });
    assert.equal(harness.window.setscopeAuth.user.id, 'user-a');
    const refresh = harness.window.setscopeAuth.refresh();
    await harness.waitForPending('refresh:refresh-a');

    await harness.getNode('#logout-button').listeners.get('click')();
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

    await harness.getNode('#logout-button').listeners.get('click')();
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
  const logout = harness.getNode('#logout-button').listeners.get('click')();
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
  await harness.getNode('#logout-button').listeners.get('click')();
  await harness.settle();
  assert.equal(harness.window.setscopeAuth.user, null);
  assert.equal(harness.currentSession(), null);
  assert.equal(harness.document.body.classList.contains('authenticated'), false);
  assert.equal(harness.window.reloadCount, 1);
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
