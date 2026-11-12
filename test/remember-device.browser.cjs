'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');

const widths = [320, 375, 390, 768, 1024, 1440];
const rememberLifetime = 168 * 60 * 60 * 1000;
const origin = 'http://setscope.test';
const provider = 'https://fixture.supabase.co';
const owner = { id: 'fixture-owner', email: 'a@example.test' };
const read = name => readFileSync(path.join(__dirname, '..', name), 'utf8');
const auth = read('auth.js');
const fixtureAuth = auth.replace(/\}\)\(\);\s*$/, '})(window.fixtureSessionLogin);');
const assets = {
  '/index.html': { contentType: 'text/html', body: read('index.html') },
  '/style.css': { contentType: 'text/css', body: read('style.css') },
  '/analysis.css': { contentType: 'text/css', body: read('analysis.css') },
  '/app.js': { contentType: 'text/javascript', body: `
    window.addEventListener('setscope:authenticated', event => {
      window.setscopeAuth.markPrivateUiReady({ ownerId: event.detail.userId, generation: event.detail.generation });
    });
  ` }
};

async function fixturePage(browser, withAdapter) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const calls = [];
  let now = Date.UTC(2026, 10, 8), session, rotation = 0;
  const tokens = () => ({
    access_token: `fixture-access-${rotation}`, refresh_token: `fixture-refresh-${rotation}`,
    expires_in: 3600, user: owner
  });
  const valid = () => session && !session.revoked && (session.expiresAt === null || now < session.expiresAt);
  const login = (credentials, options) => {
    const fields = Object.keys(credentials).sort().join(',');
    assert.equal(fields, 'email,password');
    if (credentials.email !== owner.email) throw Error('Invalid fixture login');
    const rememberDevice = options?.rememberDevice;
    calls.push(rememberDevice);
    session = { expiresAt: rememberDevice ? now + rememberLifetime : null, revoked: false };
    rotation++;
    return tokens();
  };

  if (withAdapter) await page.exposeFunction('fixtureSessionLogin', login);
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === '/api/auth-config') {
        return route.fulfill({ json: { configured: true, url: provider, anonKey: 'public-fixture' } });
      }
      if (url.pathname === '/auth.js') {
        return route.fulfill({ contentType: 'text/javascript', body: withAdapter ? fixtureAuth : auth });
      }
      const asset = assets[url.pathname] || (['/', '/login', '/register'].includes(url.pathname) && assets['/index.html']);
      return asset ? route.fulfill(asset) : route.abort();
    }
    if (url.origin !== provider) return route.abort();
    if (url.pathname === '/auth/v1/token') {
      if (url.searchParams.get('grant_type') === 'password') {
        return route.fulfill({ json: login(request.postDataJSON()) });
      }
      if (url.searchParams.get('grant_type') === 'refresh_token' && valid()
        && request.postDataJSON().refresh_token === tokens().refresh_token) {
        rotation++;
        return route.fulfill({ json: tokens() });
      }
    }
    const authenticated = valid() && request.headers().authorization === `Bearer ${tokens().access_token}`;
    if (url.pathname === '/auth/v1/user' && authenticated) return route.fulfill({ json: owner });
    if (url.pathname === '/auth/v1/logout' && authenticated) {
      assert.equal(url.searchParams.get('scope'), 'local');
      session.revoked = true;
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 401, json: { error: 'Unauthorized fixture session' } });
  });
  await page.goto(`${origin}/login`);
  await page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled);
  return { context, page, calls, session: () => session, setClock: time => { now = time; } };
}

async function fillLogin(page, email = owner.email) {
  await page.locator('#login-form [name=email]').fill(email);
  await page.locator('#login-form [name=password]').fill('fixture-password');
}

(async () => {
  assert.ok(fixtureAuth !== auth, 'fixture must inject the adapter at the auth bootstrap');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
  try {
    const standard = await fixturePage(browser, false);
    const hidden = standard.page.locator('#remember-device');
    assert.equal(await hidden.isVisible(), false);
    assert.equal(await hidden.isDisabled(), true);
    await hidden.evaluate(input => { input.disabled = false; input.checked = true; });
    await fillLogin(standard.page);
    await standard.page.locator('#login-form button[type=submit]').click();
    await standard.page.locator('#app-shell').waitFor({ state: 'visible' });
    assert.deepEqual(standard.calls, [undefined], 'legacy password request has no remember option');
    assert.deepEqual(await standard.context.cookies(), []);
    await standard.context.close();

    const fixture = await fixturePage(browser, true);
    const { page } = fixture;
    const checkbox = page.getByRole('checkbox', { name: 'จดจำอุปกรณ์นี้' });
    const forgot = page.locator('#forgot-password-button');
    const submit = page.locator('#login-form button[type=submit]');
    assert.equal(await checkbox.isChecked(), false);
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.locator('#auth-theme-toggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      for (const width of widths) {
        await page.setViewportSize({ width, height: 800 });
        const geometry = await page.evaluate(() => {
          const rect = selector => document.querySelector(selector).getBoundingClientRect();
          const label = rect('.remember-device'), link = rect('#forgot-password-button');
          const password = rect('#login-form [name=password]'), submit = rect('#login-form button[type=submit]');
          return {
            fits: document.documentElement.scrollWidth === innerWidth,
            sameRow: label.top < link.bottom && link.top < label.bottom && label.right <= link.left,
            ordered: password.bottom <= Math.min(label.top, link.top) && Math.max(label.bottom, link.bottom) <= submit.top
          };
        });
        assert.deepEqual(geometry, { fits: true, sameRow: true, ordered: true }, `${theme} at ${width}px`);
      }
    }
    await page.setViewportSize({ width: 320, height: 800 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), true);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });

    await page.locator('#login-form [name=password]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await checkbox.evaluate(node => node.matches(':focus-visible')), true);
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), true);
    await page.keyboard.press('Tab');
    assert.equal(await forgot.evaluate(node => node.matches(':focus-visible')), true);
    await page.keyboard.press('Tab');
    assert.equal(await submit.evaluate(node => node.matches(':focus-visible')), true);
    await forgot.click();
    await page.locator('#forgot-password-form').waitFor({ state: 'visible' });
    await page.locator('#recovery-back-button').click();
    assert.equal(await checkbox.isChecked(), false);
    await checkbox.check();
    await page.locator('#auth-signup-tab').click();
    await page.locator('#signup-form').waitFor({ state: 'visible' });
    await page.locator('#auth-login-tab').click();
    assert.equal(await checkbox.isChecked(), false);

    await fillLogin(page);
    await submit.click();
    await page.locator('#app-shell').waitFor({ state: 'visible' });
    assert.deepEqual(fixture.calls, [false]);
    assert.equal(fixture.session().expiresAt, null);
    await Promise.all([
      page.waitForEvent('load'),
      page.locator('#profile-logout-button').evaluate(node => node.click())
    ]);
    await page.waitForURL('**/login');
    await page.waitForFunction(() => !document.querySelector('#login-form button[type=submit]').disabled);
    assert.equal(fixture.session().revoked, true);

    await fillLogin(page, 'invalid@example.test');
    await checkbox.check();
    assert.equal(await submit.evaluate(button => {
      button.form.requestSubmit(button);
      return button.form.elements.rememberDevice.disabled;
    }), true);
    await page.waitForFunction(() => document.querySelector('#auth-message').classList.contains('error'));
    assert.equal(await checkbox.isEnabled(), true);
    assert.deepEqual(fixture.calls, [false]);
    assert.equal(fixture.session().revoked, true);

    await fillLogin(page);
    await submit.click();
    await page.locator('#app-shell').waitFor({ state: 'visible' });
    assert.deepEqual(fixture.calls, [false, true]);
    const deadline = Date.UTC(2026, 10, 15);
    assert.equal(fixture.session().expiresAt, deadline);
    assert.deepEqual(await fixture.context.cookies(), []);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('fixture-access-') || value.includes('fixture-refresh-'))), false);

    fixture.setClock(deadline - 1000);
    assert.equal(await page.evaluate(() => window.setscopeAuth.refresh()), true);
    assert.equal(fixture.session().expiresAt, deadline);
    fixture.setClock(deadline);
    assert.equal(await page.evaluate(() => window.setscopeAuth.refresh()), false);
    fixture.setClock(deadline + 1000);
    assert.equal(await page.evaluate(() => window.setscopeAuth.refresh()), false);
    await page.reload();
    await page.locator('#login-form').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#app-shell').isVisible(), false);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('setscope-auth-session-v1')), null);
    await fixture.context.close();
    console.log(JSON.stringify({ rememberDeviceB1: 'PASS', widths, themes: ['light', 'dark'], mockExpiryOffsetsMs: [-1000, 0, 1000] }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
