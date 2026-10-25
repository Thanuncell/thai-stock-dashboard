'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const authSource = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'server', 'watchlist-service.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  querySelector() { return { disabled: false }; }
  reset() {}
}

class FakeStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function createAuthHarness() {
  const nodes = new Map();
  const getNode = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new FakeNode());
    return nodes.get(selector);
  };
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  sessionStorage.setItem('setscope-auth-session-v1', JSON.stringify({
    access_token: 'token-a', refresh_token: 'refresh-a', expires_at: Date.now() + 3_600_000
  }));
  let delayedSignal;
  const fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === '/api/auth-config') return Response.json({ configured: true, url: 'https://project.example', anonKey: 'public-test-key' });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-a', email: 'a@example.test' });
    if (url === '/api/delayed') {
      delayedSignal = init.signal;
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
        }, { once: true });
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const listeners = new Map();
  const location = { pathname: '/', search: '', hash: '#watchlist' };
  const window = {
    location: { origin: 'https://setscope.example', reload: () => { window.reloadCalled = true; } },
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { window.lastEvent = event; },
    setscopeAuth: null
  };
  const document = {
    body: getNode('body'), documentElement: { dataset: {} }, title: '',
    querySelector: getNode, querySelectorAll: () => []
  };
  const history = {
    replaceState(_state, _title, value) { const url = new URL(value, 'https://setscope.example'); Object.assign(location, { pathname: url.pathname, search: url.search, hash: url.hash }); },
    pushState(_state, _title, value) { this.replaceState(_state, _title, value); }
  };
  class FakeFormData { get() { return ''; } }
  class FakeCustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const context = vm.createContext({
    AbortController, AbortSignal, console, CustomEvent: FakeCustomEvent, document, fetch,
    FormData: FakeFormData, Headers, history, localStorage, location, Math,
    sessionStorage, setTimeout: () => 1, clearTimeout: () => {}, URL, URLSearchParams, window
  });
  vm.runInContext(authSource, context, { filename: 'auth.js' });
  for (let index = 0; index < 6; index++) await flush();
  return { document, get delayedSignal() { return delayedSignal; }, listeners, localStorage, window };
}

test('T01/T03/T04/T08/T15 user-owned state is gated before render and legacy keys remain unowned', () => {
  assert.match(appSource, /identity\.ownerId !== authenticatedUserId/);
  assert.match(appSource, /userStorageScope = identity\.ownerId/);
  assert.match(appSource, /return \{ watchlists: fallback, owned: false \}/);
  assert.doesNotMatch(appSource, /localStorage\.(?:getItem|setItem|removeItem)\('setscope-(?:watchlists-v2|active-watchlist|alert-)/);
  assert.match(styleSource, /body:not\(\.authenticated\) \.app-shell\{display:none\}/);
  assert.match(appSource, /window\.addEventListener\('setscope:session-boundary', clearPrivateState\)/);
});

test('T02/T05/T18 cloud no-record, empty, malformed and failure paths cannot issue an unowned empty write', () => {
  const initialize = appSource.match(/async function initializeWatchlistCloudSync[\s\S]*?\n}\r?\n\r?\nfunction readLocal/)?.[0] || '';
  assert.match(initialize, /const localOwned = hasOwnedWatchlistData/);
  assert.match(initialize, /if \(record && !Array\.isArray\(record\.watchlists\)\) throw/);
  assert.match(initialize, /if \(record \|\| localOwned\) persistWatchlistsLocal\(identity\)/);
  assert.match(initialize, /if \(localOwned && \(!record \|\| record\.watchlists\.length === 0\)\) scheduleWatchlistCloudSync\(\)/);
  assert.match(initialize, /catch \(error\)[\s\S]*?if \(!isCurrentPrivateIdentity\(identity\)\) return/);
  assert.doesNotMatch(initialize.match(/catch \(error\)[\s\S]*$/)?.[0] || '', /scheduleWatchlistCloudSync/);
  assert.match(appSource, /writeScopedLocal\('setscope-watchlists-recovery-v1'/);
  assert.match(appSource, /checksum: watchlistSnapshotChecksum\(normalized, selectedId\)/);
  assert.doesNotMatch(appSource, /localStorage\.clear\(|removeItem\(scopedStorageKey\('setscope-watchlists-recovery-v1'/);
});

test('T06/T13/T14/T16 pending requests are fenced by owner generation and matching cross-tab logout only', async () => {
  const harness = await createAuthHarness();
  assert.equal(harness.document.body.classList.contains('authenticated'), true);
  const identity = harness.window.setscopeAuth.captureIdentity();
  assert.equal(identity.ownerId, 'user-a');

  const pending = harness.window.setscopeAuth.authorizedFetch('/api/delayed');
  await flush();
  assert.equal(harness.delayedSignal.aborted, false);

  harness.listeners.get('storage')({
    key: 'setscope-auth-boundary-v1', newValue: JSON.stringify({ ownerId: 'user-b', nonce: 'different-owner' })
  });
  assert.equal(harness.delayedSignal.aborted, false);
  assert.equal(harness.window.setscopeAuth.isCurrentIdentity(identity), true);

  harness.listeners.get('storage')({
    key: 'setscope-auth-boundary-v1', newValue: JSON.stringify({ ownerId: 'user-a', nonce: 'same-owner' })
  });
  await assert.rejects(pending, error => error?.code === 'STALE_SESSION');
  assert.equal(harness.window.setscopeAuth.isCurrentIdentity(identity), false);
  assert.equal(harness.document.body.classList.contains('authenticated'), false);
  assert.equal(harness.window.reloadCalled, true);
  assert.match(appSource, /function recordAlert[\s\S]*?if \(!isCurrentPrivateIdentity\(\)\) return/);
});

test('T07 same-user refresh preserves owner generation while logout and expiry create a boundary', () => {
  assert.doesNotMatch(authSource.match(/async function refreshSession[\s\S]*?\n  }/)?.[0] || '', /authGeneration \+= 1/);
  assert.match(authSource, /endPrivateSession\('logout', \{ broadcast: true/);
  assert.match(authSource, /endPrivateSession\('expiry', \{ broadcast: true/);
});

test('T09/T17 private Watchlist API is no-store and trusts validated auth identity, not payload user_id', () => {
  const handler = serverSource.match(/async function handleWatchlists[\s\S]*?\n}\r?\n\r?\nasync function handleNewsAnalysis/)?.[0] || '';
  assert.match(handler, /res\.setHeader\('cache-control', 'no-store'\)/);
  assert.match(handler, /watchlistService\.load\(user\.id, req\.headers\.authorization\)/);
  assert.match(handler, /watchlistService\.save\(user\.id, req\.headers\.authorization, normalized\)/);
  assert.match(serviceSource, /url\.searchParams\.set\('user_id', `eq\.\$\{userId\}`\)/);
  assert.match(serviceSource, /user_id: userId/);
  assert.doesNotMatch(serviceSource, /normalized\.user_id/);
});

test('T10 Watchlist News and alert evaluation discard stale owner state', () => {
  const watchlistNews = appSource.match(/async function getWatchlistNews[\s\S]*?\n}\r?\nasync function analyzeNewsBriefs/)?.[0] || '';
  assert.match(watchlistNews, /const identity = capturePrivateIdentity\(\)/);
  assert.match(watchlistNews, /!isCurrentPrivateIdentity\(identity\) \|\| requestId !== watchlistNewsRequestId/);
  assert.match(appSource, /function evaluateWatchlistAlerts\(rows\) \{\r?\n  if \(!isCurrentPrivateIdentity\(\)\) return/);
});

test('T11 network budget adds no scheduler, polling interval or provider request', () => {
  assert.equal((appSource.match(/setInterval\(/g) || []).length, 4);
  assert.equal((appSource.match(/apiFetch\('\/api\/watchlists'\)/g) || []).length, 1);
  assert.equal((appSource.match(/apiFetch\('\/api\/watchlists', \{ method: 'PUT'/g) || []).length, 1);
  assert.doesNotMatch([authSource, appSource].join('\n'), /WebSocket|EventSource/);
});

test('T12 account isolation suite is part of full regression and syntax verification', () => {
  assert.match(packageJson.scripts.test, /test\/account-isolation\.test\.js/);
  assert.match(packageJson.scripts.check, /node --check test\/account-isolation\.test\.js/);
});
