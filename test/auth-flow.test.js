'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

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
    this.submit = new FakeNodeSubmit();
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector(selector) { return selector === '[type=submit]' ? this.submit : null; }
  reset() { this.resetCalled = true; }
}

class FakeNodeSubmit {
  constructor() { this.disabled = false; }
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('login, signup and refresh flows keep session behavior without refresh loops', async () => {
  const nodes = new Map();
  const getNode = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode());
    return nodes.get(selector);
  };
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  sessionStorage.setItem('setscope-auth-session-v1', JSON.stringify({
    access_token: 'old-access',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 1_000
  }));

  const calls = [];
  let protectedCalls = 0;
  let refreshCount = 0;
  const nativeResponse = globalThis.Response;
  const fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/auth-config') {
      return new nativeResponse(JSON.stringify({ configured: true, url: 'https://project.supabase.co', anonKey: 'publishable-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
      refreshCount += 1;
      return new nativeResponse(JSON.stringify({ access_token: `refreshed-${refreshCount}`, refresh_token: `refresh-${refreshCount + 1}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/auth/v1/token?grant_type=password')) {
      return new nativeResponse(JSON.stringify({ access_token: 'login-access', refresh_token: 'login-refresh', expires_in: 3600, user: { id: 'login-user', email: 'login@example.test' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.includes('/auth/v1/signup?')) {
      return new nativeResponse(JSON.stringify({ user: { id: 'new-user' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url.endsWith('/auth/v1/user')) {
      return new nativeResponse(JSON.stringify({ id: 'user-a', email: 'a@example.test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    if (url === '/api/protected') {
      protectedCalls += 1;
      return new nativeResponse('', { status: protectedCalls === 1 ? 401 : 200 });
    }
    if (url.endsWith('/auth/v1/logout')) return new nativeResponse('', { status: 204 });
    throw new Error(`Unexpected fetch ${url}`);
  };

  const windowListeners = new Map();
  const document = {
    body: getNode('body'),
    documentElement: { dataset: {} },
    title: '',
    querySelector: getNode,
    querySelectorAll: () => []
  };
  const window = {
    location: { origin: 'https://setscope.example', reload: () => { window.reloadCalled = true; } },
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    dispatchEvent: event => { window.lastEvent = event; },
    setscopeAuth: null
  };
  const location = { pathname: '/', search: '?s=PTT&source=infoquest&newsPage=12', hash: '#news' };
  const applyHistoryUrl = value => {
    const parsed = new URL(String(value), 'https://setscope.example');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const history = {
    pushState: (_state, _title, url) => applyHistoryUrl(url),
    replaceState: (_state, _title, url) => applyHistoryUrl(url)
  };
  class FakeFormData {
    constructor(form) { this.fields = form.fields || {}; }
    get(key) { return this.fields[key]; }
  }
  class FakeCustomEvent {
    constructor(type, options) { this.type = type; this.detail = options?.detail; }
  }

  const context = vm.createContext({
    AbortController,
    AbortSignal,
    console,
    CustomEvent: FakeCustomEvent,
    document,
    fetch,
    FormData: FakeFormData,
    Headers,
    history,
    localStorage,
    location,
    sessionStorage,
    setTimeout: () => 1,
    clearTimeout: () => {},
    URLSearchParams,
    window
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'auth.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'auth.js' });
  for (let index = 0; index < 8; index++) await flush();

  assert.equal(refreshCount, 1);
  assert.equal(document.body.classList.contains('authenticated'), true);
  assert.equal(window.lastEvent?.type, 'setscope:authenticated');
  assert.equal(`${location.pathname}${location.search}${location.hash}`, '/?s=PTT&source=infoquest&newsPage=12#news');
  assert.equal(JSON.parse(sessionStorage.getItem('setscope-auth-session-v1')).access_token, 'refreshed-1');

  const identityBeforeRefresh = window.setscopeAuth.captureIdentity();
  const protectedResponse = await window.setscopeAuth.authorizedFetch('/api/protected');
  assert.equal(protectedResponse.status, 200);
  assert.equal(protectedCalls, 2);
  assert.equal(refreshCount, 2);
  assert.deepEqual(window.setscopeAuth.captureIdentity(), identityBeforeRefresh);

  await getNode('#logout-button').listeners.get('click')();
  assert.equal(location.pathname, '/login');
  assert.equal(window.reloadCalled, true);

  const loginForm = getNode('#login-form');
  loginForm.fields = { email: 'login@example.test', password: 'correct-horse' };
  await loginForm.listeners.get('submit')({ preventDefault() {}, currentTarget: loginForm });
  assert.equal(loginForm.submit.disabled, false);
  assert.equal(`${location.pathname}${location.search}${location.hash}`, '/?s=PTT&source=infoquest&newsPage=12#news');
  assert.ok(calls.some(call => call.url.includes('grant_type=password')));

  const signupForm = getNode('#signup-form');
  signupForm.fields = { email: 'new@example.test', password: 'passphrase', confirmPassword: 'passphrase' };
  await signupForm.listeners.get('submit')({ preventDefault() {}, currentTarget: signupForm });
  assert.equal(signupForm.resetCalled, true);
  assert.ok(calls.some(call => call.url.includes('/auth/v1/signup?')));
});
