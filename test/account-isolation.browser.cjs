'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const playwrightModule = process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);
const ROOT = path.join(__dirname, '..');

function json(route, body, status = 200, headers = {}) {
  return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Local server did not start: ${url}`);
}

function ownerFromRequest(request) {
  const token = String(request.headers().authorization || '').replace(/^Bearer\s+/i, '');
  return token === 'token-b' ? 'user-b' : token === 'token-a' ? 'user-a' : '';
}

async function mockRequest(route, baseUrl, state) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === 'https://isolation-test.supabase.co') {
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const email = String(request.postDataJSON()?.email || '');
      const owner = email.startsWith('b@') ? 'user-b' : 'user-a';
      const token = owner === 'user-b' ? 'token-b' : 'token-a';
      return json(route, { access_token: token, refresh_token: `refresh-${token}`, expires_in: 3600, user: { id: owner, email } });
    }
    if (url.pathname === '/auth/v1/user') {
      const owner = ownerFromRequest(request);
      return json(route, { id: owner, email: `${owner}@example.test` }, owner ? 200 : 401);
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
    return json(route, { error: 'unexpected auth request' }, 400);
  }
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/')) return route.continue();
  if (url.pathname === '/api/auth-config') {
    return json(route, { configured: true, url: 'https://isolation-test.supabase.co', anonKey: 'public-browser-fixture' });
  }
  const owner = ownerFromRequest(request);
  if (url.pathname === '/api/watchlists') {
    if (request.method() === 'PUT') {
      state.putOwners.push(owner);
      if (owner === 'user-a' && state.holdNextAPut) {
        state.holdNextAPut = false;
        await new Promise(resolve => { state.releaseAPut = resolve; });
      }
      return json(route, { ok: true, syncedAt: new Date().toISOString() });
    }
    state.getOwners.push(owner);
    if (owner === 'user-b') return json(route, { record: null }, 200, { 'cache-control': 'no-store' });
    return json(route, {
      record: {
        watchlists: [{ id: 'list-1', name: 'A Cloud', items: [{ symbol: 'PTT', name: 'A Private Stock' }] }],
        active_watchlist_id: 'list-1'
      }
    }, 200, { 'cache-control': 'no-store' });
  }
  if (url.pathname === '/api/market') {
    return json(route, {
      stocks: [], indices: [], history: [], indicatorHistory: [], levelsHistory: [], errors: [],
      fetchedAt: new Date().toISOString(), asOf: new Date().toISOString(), source: 'fixture',
      stale: false, partial: false, delayed: true, delayMinutes: 15, dataState: 'delayed', provider: 'fixture'
    });
  }
  if (url.pathname === '/api/market-overview' || url.pathname === '/api/settrade-overview') {
    return json(route, { indices: [], breadth: {}, closeSummary: {}, activeValue: [], nvdr: {}, foreign: {}, tfex: {}, errors: [], fieldStatus: {}, sourceStatus: {}, links: {}, fetchedAt: new Date().toISOString(), asOf: null, marketDate: null, source: 'fixture', stale: false, partial: true, delayed: true, dataState: 'partial' });
  }
  if (url.pathname === '/api/coverage') return json(route, { configured: false, universe: null, currentVerified: null, provider: null, dataState: 'unavailable' });
  if (url.pathname === '/api/news') return json(route, { items: [], errors: [], fetchedAt: new Date().toISOString(), asOf: null, source: 'fixture', stale: false, partial: false, dataState: 'unavailable', maxAgeDays: 30 });
  if (url.pathname === '/api/watchlist-news') return json(route, { items: [], fetchedAt: new Date().toISOString(), asOf: null, source: 'fixture', stale: false, partial: false, dataState: 'fresh', maxAgeDays: 30 });
  if (url.pathname === '/api/news-archive') return json(route, { configured: false, featured: [], items: [], total: 0, page: 1, pageSize: 10, maxAgeDays: 365, stale: false, dataState: 'unavailable' });
  if (url.pathname === '/api/news-analysis') return json(route, { items: [], mode: 'rules', aiConfigured: false });
  if (url.pathname === '/api/search') return json(route, { items: [], provider: 'fixture' });
  return json(route, { error: 'not mocked' }, 404);
}

async function seedPage(page, token) {
  await page.addInitScript(value => {
    if (!sessionStorage.getItem('setscope-test-auth-seeded')) {
      sessionStorage.setItem('setscope-test-auth-seeded', '1');
      sessionStorage.setItem('setscope-auth-session-v1', JSON.stringify({
        access_token: value, refresh_token: `refresh-${value}`, expires_at: Date.now() + 3_600_000
      }));
    }
    localStorage.setItem('setscope-watchlists-v2', JSON.stringify([{ id: 'legacy', name: 'LEGACY PRIVATE', items: [{ symbol: 'BAD', name: 'Legacy' }] }]));
    localStorage.setItem('setscope-watchlists-v2:user-a', JSON.stringify([{ id: 'list-1', name: 'A Local', items: [{ symbol: 'PTT', name: 'A Private Stock' }] }]));
  }, token);
}

(async () => {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SUPABASE_URL: 'https://isolation-test.supabase.co', SUPABASE_ANON_KEY: 'public-browser-fixture' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let browser;
  try {
    await waitForServer(`${baseUrl}/healthz`);
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    const context = await browser.newContext({ viewport: { width: 1000, height: 760 } });
    const state = { getOwners: [], putOwners: [], holdNextAPut: true, releaseAPut: null };
    await context.route('**/*', route => mockRequest(route, baseUrl, state));

    const pageA1 = await context.newPage();
    const pageA2 = await context.newPage();
    const pageB = await context.newPage();
    await seedPage(pageA1, 'token-a');
    await seedPage(pageA2, 'token-a');
    await seedPage(pageB, 'token-b');

    await Promise.all([
      pageA1.goto(`${baseUrl}/#watchlist`, { waitUntil: 'domcontentloaded' }),
      pageA2.goto(`${baseUrl}/#watchlist`, { waitUntil: 'domcontentloaded' }),
      pageB.goto(`${baseUrl}/#watchlist`, { waitUntil: 'domcontentloaded' })
    ]);
    await Promise.all([
      pageA1.waitForSelector('body.authenticated #watchlist-mobile .watch-item'),
      pageA2.waitForSelector('body.authenticated #watchlist-mobile .watch-item'),
      pageB.waitForSelector('body.authenticated #watchlist-mobile')
    ]);

    assert.match(await pageA1.locator('#watchlist-page').textContent(), /A Private Stock/);
    const recovery = await pageA1.evaluate(() => JSON.parse(localStorage.getItem('setscope-watchlists-recovery-v1:user-a')));
    assert.equal(recovery.ownerId, 'user-a');
    assert.equal(recovery.itemCount, 1);
    assert.match(recovery.checksum, /^[0-9a-f]{8}$/);
    const bText = await pageB.locator('#app-shell').textContent();
    assert.doesNotMatch(bText, /A Private Stock|LEGACY PRIVATE/);
    assert.equal(state.putOwners.length, 0, 'B no-record without owner cache must not first-sync defaults');

    await pageA1.locator('#watchlist-create').click();
    await pageA1.waitForFunction(() => document.querySelector('#watchlist-sync-status')?.dataset.state === 'pending');
    for (let attempt = 0; attempt < 30 && !state.releaseAPut; attempt++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(state.releaseAPut, 'fixture must observe the pending A PUT');

    await pageA1.locator('#logout-button').click();
    await pageA2.waitForFunction(() => !document.body.classList.contains('authenticated'));
    state.releaseAPut();
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(await pageA2.locator('#app-shell').getAttribute('aria-hidden'), 'true');
    assert.equal(await pageB.evaluate(() => document.body.classList.contains('authenticated')), true, 'B tab must ignore A logout boundary');
    assert.doesNotMatch(await pageB.locator('#app-shell').textContent(), /A Private Stock|LEGACY PRIVATE/);
    assert.deepEqual([...new Set(state.putOwners)], ['user-a'], 'pending writes must retain the captured A bearer identity');
    assert.ok(state.getOwners.includes('user-a') && state.getOwners.includes('user-b'));

    await pageA1.waitForSelector('#login-form:not([hidden])');
    await pageA1.locator('#login-form input[name="email"]').fill('b@example.test');
    await pageA1.locator('#login-form input[name="password"]').fill('fixture-password');
    await pageA1.locator('#login-form button[type="submit"]').click();
    await pageA1.waitForSelector('body.authenticated');
    await pageA1.waitForFunction(() => document.querySelector('#watchlist-sync-status')?.dataset.state === 'empty');
    assert.doesNotMatch(await pageA1.locator('#app-shell').textContent(), /A Private Stock|LEGACY PRIVATE/);

    await pageA1.locator('#logout-button').click();
    await pageB.waitForFunction(() => !document.body.classList.contains('authenticated'));
    await pageA1.waitForSelector('#login-form:not([hidden])');
    await pageA1.locator('#login-form input[name="email"]').fill('a@example.test');
    await pageA1.locator('#login-form input[name="password"]').fill('fixture-password');
    await pageA1.locator('#login-form button[type="submit"]').click();
    await pageA1.waitForSelector('body.authenticated');
    await pageA1.waitForFunction(() => document.querySelectorAll('#watchlist-mobile .watch-item').length > 0);
    assert.match(await pageA1.locator('#watchlist-page').textContent(), /A Private Stock/);

    console.log(JSON.stringify({
      secureInitialAndNoRecord: 'PASS', accountSequenceABBA: 'PASS', crossAccountDisplay: 'PASS', sameOwnerMultiTabLogout: 'PASS',
      differentOwnerTabPreserved: 'PASS', pendingWriteOwners: state.putOwners, getOwners: state.getOwners
    }));
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
