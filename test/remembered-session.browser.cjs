'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, origin, upstream, owners } = require('./fixtures/remembered-session.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const files = {
  '/login': [read('index.html'), 'text/html'],
  '/': [read('index.html'), 'text/html'],
  '/auth.js': [read('auth.js'), 'text/javascript'],
  '/style.css': [read('style.css'), 'text/css'],
  '/analysis.css': [read('analysis.css'), 'text/css'],
  '/app.js': [`addEventListener('setscope:authenticated', ({detail}) => {
    setscopeAuth.markPrivateUiReady({ownerId: detail.userId, generation: detail.generation});
  });`, 'text/javascript']
};

async function installRoutes(context, f) {
  const app = f.app();
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === upstream) {
      const response = await f.fetchProvider(url, { headers: await request.allHeaders(), body: request.postData() });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith('/api/')) {
      const response = await app(url.pathname + url.search, {
        method: request.method(), headers: await request.allHeaders(), body: request.postDataJSON() ?? undefined
      });
      if (url.searchParams.has('hold') && f.control.holdResponse) await f.control.holdResponse();
      return route.fulfill({ status: response.status, headers: response.headers, body: JSON.stringify(response.body) });
    }
    const file = files[url.pathname];
    return file ? route.fulfill({ body: file[0], contentType: file[1] }) : route.abort();
  });
}

async function signIn(page, owner, remember) {
  await page.locator('#login-form [name=email]').fill(`${owner}@example.test`);
  await page.locator('#login-form [name=password]').fill('fixture-password');
  if (remember) await page.locator('#remember-device').check();
  await page.locator('#login-form [type=submit]').click();
  await page.waitForFunction(id => window.setscopeAuth?.user?.id === id, owners[owner]);
  await page.locator('#app-shell').waitFor({ state: 'visible' });
}

async function signOut(page) {
  await page.locator('#profile-logout-button').evaluate(button => button.click());
  await page.locator('#login-form').waitFor({ state: 'visible' });
}

async function assertRemembered(page, owner) {
  await page.waitForFunction(id => window.setscopeAuth?.user?.id === id, owners[owner]);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('setscope-auth-session-v1')), null);
  assert.equal(await page.evaluate(() => document.cookie.includes('setscope-remember')), false);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => /access_token|refresh_token|__Host-setscope-remember/.test(value))), false);
  assert.equal(await page.evaluate(async () => (await setscopeAuth.authorizedFetch('/api/screener')).status), 410);
}

(async () => {
  const f = fixture();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
  try {
    const device = await browser.newContext(), otherDevice = await browser.newContext();
    await Promise.all([installRoutes(device, f), installRoutes(otherDevice, f)]);
    const page = await device.newPage(), other = await otherDevice.newPage();
    await Promise.all([page.goto(`${origin}/login`), other.goto(`${origin}/login`)]);
    await signIn(page, 'a', true);
    await signIn(other, 'a', true);
    await assertRemembered(page, 'a');
    const cookies = await device.cookies(origin);
    assert.equal(cookies.length, 1);
    assert.ok(cookies[0].secure && cookies[0].httpOnly && cookies[0].sameSite === 'Lax');
    const secondTab = await device.newPage();
    await secondTab.goto(`${origin}/login`);
    await assertRemembered(secondTab, 'a');
    await page.close();
    const reopened = await device.newPage();
    await reopened.goto(`${origin}/login`);
    await assertRemembered(reopened, 'a');
    let arrived, release;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    f.control.holdResponse = () => { arrived(); return held; };
    const staleRequest = secondTab.evaluate(() => setscopeAuth.authorizedFetch('/api/screener?hold=1')
      .then(response => response.status, error => error.code));
    await waiting;
    try {
      await signOut(reopened);
      await secondTab.locator('#login-form').waitFor({ state: 'visible' });
    } finally { release(); }
    assert.equal(await staleRequest, 'STALE_SESSION');
    await assertRemembered(other, 'a');
    await signIn(reopened, 'b', true);
    await assertRemembered(reopened, 'b');
    assert.equal(await secondTab.evaluate(() => setscopeAuth.user), null);
    await signOut(reopened);
    await signIn(reopened, 'a', false);
    assert.equal(await reopened.evaluate(() => Boolean(sessionStorage.getItem('setscope-auth-session-v1'))), true);
    assert.equal((await device.cookies(origin)).length, 0);
    assert.equal(await reopened.evaluate(async () => (await setscopeAuth.authorizedFetch('/api/screener')).status), 410);
    await assertRemembered(other, 'a');
    f.state.offline = true;
    await signOut(other);
    await other.locator('#auth-message.error').waitFor();
    f.state.offline = false;
    await other.reload();
    await other.locator('#login-form').waitFor({ state: 'visible' });
    await other.waitForFunction(() => !document.querySelector('#login-form [type=submit]').disabled);
    assert.equal(await other.evaluate(() => setscopeAuth.user), null);
    await signIn(other, 'b', true);
    await assertRemembered(other, 'b');
    console.log('B2 browser fixture PASS: opt-in/out, cookie, tab reopen, cross-tab and cross-device logout, account switch and outage.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
