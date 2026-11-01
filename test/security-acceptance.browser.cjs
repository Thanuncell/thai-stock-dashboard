'use strict';

// Simulated devices only. Credentials are generated in memory; no storageState,
// tracing, video, screenshots, credential dumps or live Supabase calls.
delete process.env.DEBUG;
delete process.env.PWDEBUG;
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
let phase = 'setup';
const secret = () => randomBytes(32).toString('base64url');
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

(async () => {
  const nativeFetch = globalThis.fetch, originalInfo = console.info;
  const logs = [], sessions = [], access = new Map(), refresh = new Map();
  const credentials = new Map(['a', 'b'].map(owner => [owner, { email: `${owner}@example.test`, password: secret() }]));
  const allSecrets = new Set([...credentials.values()].map(value => value.password));
  const injection = '<img src=x onerror="globalThis.__phaseBInjected=1">';
  const records = new Map(['a', 'b'].map(owner => [owner, {
    watchlists: [{ id: 'list-1', name: `${owner.toUpperCase()} PRIVATE`, items: [{
      symbol: owner === 'a' ? 'PTT' : 'CPALL', name: `${owner.toUpperCase()} PRIVATE STOCK${owner === 'b' ? injection : ''}`
    }] }], active_watchlist_id: 'list-1'
  }]));
  const metrics = { logins: { a: 0, b: 0 }, refreshes: 0, writes: [], newsCalls: [], logoutScopes: [], unexpectedUpstream: 0 };
  const newsRequests = [];
  let server, browser, base, watchlistFailure = false;
  const issue = session => {
    const accessToken = secret(), refreshToken = secret();
    allSecrets.add(accessToken); allSecrets.add(refreshToken);
    if (session.refreshToken) refresh.delete(session.refreshToken);
    session.refreshToken = refreshToken;
    access.set(accessToken, { session, expired: false }); refresh.set(refreshToken, session);
    return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600,
      user: { id: `user-${session.owner}`, email: credentials.get(session.owner).email } };
  };
  const authenticated = headers => {
    const value = new Headers(headers).get('authorization')?.replace(/^Bearer\s+/i, '');
    const entry = access.get(value);
    return entry && !entry.expired ? entry.session : null;
  };
  const expire = session => { for (const entry of access.values()) if (entry.session === session) entry.expired = true; };
  const modelAuth = async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = request.postDataJSON();
      const owner = [...credentials].find(([, item]) => item.email === body.email && item.password === body.password)?.[0];
      if (!owner) return reply(route, { error: 'Invalid fixture login' }, 400);
      const session = { owner, refreshActive: true }; sessions.push(session); metrics.logins[owner]++;
      return reply(route, issue(session));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const session = refresh.get(request.postDataJSON().refresh_token);
      if (!session?.refreshActive) return reply(route, { error: 'Invalid fixture refresh' }, 400);
      metrics.refreshes++; return reply(route, issue(session));
    }
    const session = authenticated(request.headers());
    if (url.pathname === '/auth/v1/user') return session
      ? reply(route, { id: `user-${session.owner}`, email: credentials.get(session.owner).email })
      : reply(route, { error: 'Unauthorized' }, 401);
    if (url.pathname === '/auth/v1/logout' && session) {
      const scope = url.searchParams.get('scope') || 'global'; metrics.logoutScopes.push(scope);
      for (const candidate of sessions) if (candidate.owner === session.owner && (scope === 'global' || candidate === session)) candidate.refreshActive = false;
      return route.fulfill({ status: 204, body: '' });
    }
    return reply(route, { error: 'Unauthorized' }, 401);
  };
  const publicNews = owner => ({
    items: [{ title: `${owner.toUpperCase()} NEWS ${injection}`, source: 'kaohoon', sourceName: 'Fixture',
      url: `https://www.kaohoon.com/news/simulated-${owner}`, pubDate: new Date().toISOString(),
      matchedSymbols: [owner === 'a' ? 'PTT' : 'CPALL'], verification: { status: 'VERIFIED', basis: 'metadata' } }],
    fetchedAt: new Date().toISOString(), asOf: null, dataState: 'fresh', source: 'Fixture', total: 1, stockStatus: []
  });
  const restores = [];
  try {
    process.env.SUPABASE_URL = 'https://isolation-test.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'public-browser-fixture';
    process.env.SUPABASE_SECRET_KEY = ''; process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.OPENAI_API_KEY = ''; process.env.SETSCOPE_NEWS_WORK_QUEUE = 'off';
    console.info = line => logs.push(String(line));
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin === base) return nativeFetch(input, init);
      if (url.origin !== process.env.SUPABASE_URL) { metrics.unexpectedUpstream++; throw Error('Unexpected fixture upstream'); }
      const session = authenticated(init.headers);
      if (url.pathname === '/auth/v1/user') return session
        ? Response.json({ id: `user-${session.owner}`, email: credentials.get(session.owner).email })
        : Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (url.pathname === '/rest/v1/user_watchlists' && session) {
        if (watchlistFailure) return new Response('fixture-private-provider-detail', { status: 503 });
        if (init.method === 'POST') {
          const body = JSON.parse(init.body);
          assert.equal(body.user_id === `user-${session.owner}`, true, 'write owner must come from validated auth');
          records.set(session.owner, { watchlists: body.watchlists, active_watchlist_id: body.active_watchlist_id });
          metrics.writes.push(session.owner); return new Response(null, { status: 201 });
        }
        assert.equal(url.searchParams.get('user_id') === `eq.user-${session.owner}`, true, 'read owner must come from validated auth');
        return Response.json([structuredClone(records.get(session.owner))]);
      }
      throw Error('Unexpected fixture operation');
    };
    for (const [file, factory, create] of [
      ['../server/news-service', 'createNewsService', () => ({
        getWatchlistNews: async (_stocks, { ownerId }) => { const owner = ownerId === 'user-b' ? 'b' : 'a'; metrics.newsCalls.push(owner); return publicNews(owner); },
        filterForDisplay: payload => payload, reviewDiscovered: async () => []
      })],
      ['../server/news-link-review', 'createNewsLinkReview', () => ({
        review: async items => items, project: item => item, revision: 0, withheldUrls: [], queryOverlays: new Map()
      })]
    ]) {
      const module = require(file), original = module[factory]; module[factory] = create;
      restores.push(() => { module[factory] = original; });
    }
    ({ server } = require('../server')); restores.splice(0).forEach(restore => restore());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1280, height: 800 } }),
      browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    ]);
    for (const context of contexts) await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === process.env.SUPABASE_URL) return modelAuth(route);
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/api/watchlist-news') {
        if (request.method() === 'POST' && request.headers().authorization) {
          const body = request.postDataJSON();
          newsRequests.push({ cleanUrl: url.search === '', fields: Object.keys(body).sort(),
            symbolsOnly: body.stocks.every(stock => Object.keys(stock).join(',') === 'symbol'), noReferrer: !request.headers().referer });
        }
        return route.continue();
      }
      if (['/api/auth-config', '/api/watchlists'].includes(url.pathname) || !url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/market') return reply(route, { stocks: [], indices: [], history: [], indicatorHistory: [], levelsHistory: [], errors: [], dataState: 'unavailable' });
      if (url.pathname === '/api/market-overview') return reply(route, { indices: [], breadth: [], fieldStatus: {}, sourceStatus: {}, links: {}, dataState: 'unavailable' });
      if (url.pathname === '/api/news-archive') return reply(route, { configured: false, items: [], featured: [], total: 0, dataState: 'unavailable' });
      return reply(route, { items: [], dataState: 'unavailable' });
    });
    const [first, second] = await Promise.all(contexts.map(context => context.newPage()));
    async function login(page, owner) {
      if (!page.url().startsWith(base)) await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#login-form:not([hidden])');
      await page.locator('#login-form input[name="email"]').fill(credentials.get(owner).email);
      await page.locator('#login-form input[name="password"]').fill(credentials.get(owner).password);
      await page.locator('#login-form button[type="submit"]').click();
      await page.waitForSelector('body.authenticated');
      await page.locator('.nav-item[data-workspace-route="watchlist"]').click();
      await page.waitForFunction(() => document.querySelector('#watchlist-sync-status')?.dataset.state === 'synced');
    }
    phase = 'independent-logins';
    await login(first, 'a'); await login(second, 'a');
    assert.equal(metrics.logins.a, 2); assert.equal(sessions[0] !== sessions[1], true);
    const secondSession = sessions[1], originalA = JSON.stringify(records.get('a'));
    phase = 'logout-reload-refresh';
    await first.locator('#logout-button').click();
    await first.waitForSelector('#login-form:not([hidden])');
    assert.equal(metrics.logoutScopes.at(-1), 'local');
    await first.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await first.evaluate(() => Boolean(sessionStorage.getItem('setscope-auth-session-v1'))), false);
    await second.reload({ waitUntil: 'domcontentloaded' }); await second.waitForSelector('body.authenticated');
    assert.equal(metrics.logins.a, 2, 'reload must reuse this context session without a new login');
    expire(secondSession);
    const rotation = await second.evaluate(async () => {
      const before = JSON.parse(sessionStorage.getItem('setscope-auth-session-v1'));
      const response = await window.setscopeAuth.authorizedFetch('/api/watchlists');
      const after = JSON.parse(sessionStorage.getItem('setscope-auth-session-v1'));
      return { status: response.status, accessRotated: before.access_token !== after.access_token,
        refreshRotated: before.refresh_token !== after.refresh_token, owner: window.setscopeAuth.user.id };
    });
    assert.deepEqual(rotation, { status: 200, accessRotated: true, refreshRotated: true, owner: 'user-a' });
    assert.equal(metrics.refreshes, 1);
    await second.reload({ waitUntil: 'domcontentloaded' }); await second.waitForSelector('body.authenticated');
    phase = 'account-isolation-and-xss';
    await login(first, 'b');
    assert.doesNotMatch(await first.locator('#app-shell').textContent(), /A PRIVATE/);
    assert.doesNotMatch(await second.locator('#app-shell').textContent(), /B PRIVATE/);
    await first.waitForFunction(() => document.querySelector('#watchlist-news-list')?.textContent.includes('B NEWS'));
    assert.equal(await first.locator('#app-shell img').count(), 0);
    assert.equal(await first.evaluate(() => globalThis.__phaseBInjected === undefined), true);
    assert.equal(new URL(first.url()).searchParams.has('watchlist'), false);
    phase = 'private-api-authorization';
    const write = await first.evaluate(async () => {
      const response = await window.setscopeAuth.authorizedFetch('/api/watchlists', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'user-a', watchlists: [{ id: 'list-1', name: 'B PRIVATE UPDATED', items: [{ symbol: 'CPALL', name: 'B PRIVATE STOCK' }] }], activeWatchlistId: 'list-1' })
      }); return response.status;
    });
    assert.equal(write, 200); assert.deepEqual(metrics.writes, ['b']);
    assert.equal(JSON.stringify(records.get('a')) === originalA, true, 'A data must remain unchanged');
    const unauthorized = await second.evaluate(async () => {
      const response = await fetch('/api/watchlist-news', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stocks: [{ symbol: 'PTT' }] }) });
      return response.status;
    });
    assert.equal(unauthorized, 401);
    phase = 'client-safe-provider-errors';
    watchlistFailure = true;
    const safeError = await first.evaluate(async () => {
      const response = await window.setscopeAuth.authorizedFetch('/api/watchlists');
      const body = await response.json();
      return { status: response.status, noStore: response.headers.get('cache-control') === 'no-store',
        safe: Object.keys(body).join(',') === 'error' && !JSON.stringify(body).includes('fixture-private-provider-detail') };
    });
    watchlistFailure = false;
    assert.deepEqual(safeError, { status: 502, noStore: true, safe: true });
    phase = 'post-legacy-get-cache-privacy';
    const beforeNews = metrics.newsCalls.length;
    const compatible = await second.evaluate(async () => {
      const post = await window.setscopeAuth.authorizedFetch('/api/watchlist-news', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stocks: [{ symbol: 'PTT' }], refresh: false }) });
      const get = await window.setscopeAuth.authorizedFetch('/api/watchlist-news?symbols=PTT');
      return { post: post.status, get: get.status, equal: JSON.stringify(await post.json()) === JSON.stringify(await get.json()), noStore: post.headers.get('cache-control') === 'no-store' };
    });
    assert.deepEqual(compatible, { post: 200, get: 200, equal: true, noStore: true });
    assert.equal(metrics.newsCalls.length, beforeNews, 'GET/POST reuse the same owner cache');
    assert.equal(newsRequests.length >= 3, true);
    assert.equal(newsRequests.every(row => row.cleanUrl && row.symbolsOnly && row.noReferrer && row.fields.every(field => ['stocks', 'refresh'].includes(field))), true);
    phase = 'relogin-and-refresh-failure';
    await first.locator('#logout-button').click(); await first.waitForSelector('#login-form:not([hidden])');
    await login(first, 'a');
    assert.doesNotMatch(await first.locator('#app-shell').textContent(), /B PRIVATE/);
    assert.equal(JSON.stringify(records.get('a')) === originalA, true);
    secondSession.refreshActive = false; expire(secondSession);
    assert.equal(await second.evaluate(async () => { try { await window.setscopeAuth.authorizedFetch('/api/watchlists'); return false; } catch { return true; } }), true);
    await second.waitForSelector('#login-form:not([hidden])');
    assert.equal(await second.locator('#app-shell').getAttribute('aria-hidden'), 'true');
    assert.equal(await first.evaluate(() => document.body.classList.contains('authenticated')), true);
    assert.equal(logs.some(line => [...allSecrets].some(value => line.includes(value))), false, 'runtime logs must not contain generated credentials');
    assert.equal(metrics.unexpectedUpstream, 0);
    console.log(JSON.stringify({ mockE2E: 'PASS', simulatedContexts: contexts.length, independentLogins: 'PASS',
      sameAccountLogoutReloadRefresh: 'PASS', accessAndRefreshRotation: 'PASS', accountABAndForgedOwner: 'PASS',
      postLegacyGetCachePrivacy: 'PASS', clientSafeProviderErrors: 'PASS', xssRendering: 'PASS', refreshFailureClosed: 'PASS', watchlistPreserved: 'PASS',
      realSupabaseE2E: 'NOT RUN', physicalDevices: 'NOT RUN', credentialArtifacts: 0 }));
  } finally {
    await browser?.close().catch(() => {});
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    restores.forEach(restore => restore()); globalThis.fetch = nativeFetch; console.info = originalInfo;
  }
})().catch(() => { console.error(JSON.stringify({ mockE2E: 'FAIL', phase, details: 'Suppressed to protect in-memory credentials' })); process.exitCode = 1; });
