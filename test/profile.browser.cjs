'use strict';

// Offline browser acceptance. All accounts and responses are synthetic.
delete process.env.DEBUG; delete process.env.PWDEBUG;
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { chromium } = require(process.env.SETSCOPE_PLAYWRIGHT_MODULE || 'playwright');
const ROOT = path.resolve(__dirname, '..');
const authOrigin = 'https://profile-fixture.supabase.co';
const token = randomBytes(32).toString('base64url');
const password = randomBytes(32).toString('base64url');
let phase = 'setup', server, browser, base, checks = 0;
const pageErrors = [], requests = [];
const check = (value, expected, description) => { assert.deepEqual(value, expected, description); checks++; };
const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const historyRows = (symbol, timestamp = Date.now()) => Array.from({ length: 30 }, (_, i) => ({ title: `${symbol} ข่าวทดสอบ ${i + 1}`,
  url: `https://www.infoquest.co.th/2026/profile-history-${symbol}-${i + 1}`, pubDate: new Date(timestamp - i * 1000).toISOString(),
  source: 'infoquest', matchedSymbols: [symbol], verification: { status: 'VERIFIED', basis: 'metadata' } }));

async function makeContext(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width <= 790, hasTouch: width <= 790 });
  const state = { owner: 'a', verified: true, expired: false, recoverStatus: 200, updateStatus: 200, holdEmail: null, releaseEmail: null,
    archiveGate: null, archiveMode: 'unavailable', watchRows: [], watchGate: null };
  const user = () => ({ id: `user-${state.owner}`, email: `${state.owner}@example.test`, email_confirmed_at: state.verified ? '2026-01-01T00:00:00Z' : null });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === authOrigin) {
      // Record only operation metadata, never credentials or body/password values.
      requests.push({ path: url.pathname, method: request.method(), redirect: url.searchParams.get('redirect_to'), scope: url.searchParams.get('scope') });
      if (url.pathname.endsWith('/token')) {
        if (url.searchParams.get('grant_type') === 'password') state.owner = request.postDataJSON().email.startsWith('b@') ? 'b' : 'a';
        return reply(route, { access_token: token, refresh_token: token, expires_in: 3600, user: user() });
      }
      if (url.pathname.endsWith('/user')) {
        if (state.expired) return reply(route, { error: 'expired' }, 401);
        if (request.method() === 'PUT') return reply(route, state.updateStatus === 200 ? user() : { error: 'fixture-policy' }, state.updateStatus);
        return reply(route, user());
      }
      if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, body: '' });
      if (/\/(recover|resend)$/.test(url.pathname)) {
        check(url.searchParams.get('redirect_to'), base, 'email redirects stay on this app origin');
        check(request.postDataJSON().email, `${state.owner}@example.test`, 'current account email only');
        if (state.holdEmail) await new Promise(resolve => { state.releaseEmail = resolve; });
        return reply(route, {}, state.recoverStatus);
      }
      throw Error('Unexpected fixture Auth operation');
    }
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/auth-config') return reply(route, { configured: true, url: authOrigin, anonKey: 'public-profile-fixture' });
    if (url.pathname === '/api/watchlists') return reply(route, { record: { watchlists: [
      { id: 'list-1', name: `${state.owner.toUpperCase()} WATCHLIST`, items: [{ symbol: 'PTT', name: 'Fixture Stock' }] },
      { id: 'list-2', name: `${state.owner.toUpperCase()} SECOND`, items: [{ symbol: 'CPALL', name: 'Fixture Stock' }] }
    ], active_watchlist_id: 'list-1' } });
    if (url.pathname === '/api/market') return reply(route, { stocks: [], indices: [], history: [], indicatorHistory: [], levelsHistory: [], errors: [], dataState: 'unavailable' });
    if (url.pathname === '/api/market-overview') return reply(route, { indices: [], breadth: [], fieldStatus: {}, sourceStatus: {}, links: {}, dataState: 'unavailable' });
    if (url.pathname === '/api/news-archive') {
      if (state.archiveGate) await state.archiveGate;
      if (state.archiveMode !== 'unavailable') {
        const rows = state.archiveMode === 'available' ? historyRows('PTT') : [], page = Number(url.searchParams.get('page') || 1);
        return reply(route, { configured: true, items: rows.slice((page - 1) * 10, page * 10), featured: [],
          total: rows.length, page, countExact: true, dataState: 'fresh' });
      }
      return reply(route, { configured: false, items: [], featured: [], total: 0, dataState: 'unavailable' });
    }
    if (url.pathname === '/api/watchlist-news') {
      if(state.watchGate)await state.watchGate;
      return reply(route, { items: state.watchRows, dataState: 'fresh' });
    }
    return reply(route, { items: [], dataState: 'unavailable' });
  });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.name));
  async function login(owner = 'a') {
    await page.locator('#login-form input[name="email"]').fill(`${owner}@example.test`);
    await page.locator('#login-form input[name="password"]').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.waitForSelector('body.authenticated');
  }
  return { context, page, state, login };
}

(async () => {
  try {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const filename = ['/', '/login', '/register'].includes(pathname) ? 'index.html' : pathname.slice(1);
      const file = path.resolve(ROOT, filename);
      if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType }); res.end(data);
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, executablePath: process.env.SETSCOPE_BROWSER_EXECUTABLE || undefined });
    for (const width of [320, 375, 390, 768, 1024, 1440]) {
      phase = `responsive-${width}`;
      const { context, page, login } = await makeContext(width);
      await page.goto(`${base}/#profile`);
      await page.waitForSelector('#login-form:not([hidden])');
      check(await page.locator('#app-shell').isVisible(), false, 'mandatory login');
      check(await page.locator('.auth-eyebrow').textContent(), 'พื้นที่ส่วนตัวสำหรับติดตามตลาด');
      check(await page.locator('.auth-lead').textContent(), 'ลงชื่อเข้าใช้เพื่อดูกราฟ ข่าว และ Watchlist ของคุณ');
      await login();
      check(await page.locator('header .logout-button, header #logout-button, header #profile-logout-button').count(), 0, 'Header has no Logout');
      check(await page.locator('#logout-button').count(), 0, 'removed Header Logout is absent from DOM');
      check(await page.locator('#profile-logout-button').count(), 1, 'single Profile Logout');
      check(new URL(page.url()).hash, '#profile');
      check(await page.locator('#profile-email').textContent(), 'a@example.test');
      check(await page.locator('#profile-verification').textContent(), 'ยืนยันอีเมลแล้ว');
      check(await page.locator('.side-nav .nav-item').count(), 5);
      check(await page.locator('.side-nav [aria-current="page"]').getAttribute('data-workspace-route'), 'profile');
      check(await page.locator('#market-overview').isVisible(), false);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
      const avatar = await page.locator('#user-avatar').boundingBox();
      check(Boolean(avatar && avatar.width === 29 && avatar.height === 29 && avatar.x + avatar.width <= width), true, '29px avatar remains reachable');
      check(await page.locator('#user-avatar').evaluate(node => ({ radius: getComputedStyle(node).borderRadius, font: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight })), { radius: '50%', font: '12px', weight: '600' }, 'original avatar shape and type');
      const headerLayout = () => page.locator('.topbar').evaluate(header => {
        const selectors = ['#theme-toggle', '#alerts-toggle', '#user-avatar'];
        return { height: header.getBoundingClientRect().height, controls: selectors.map(selector => {
          const box = header.querySelector(selector).getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }) };
      });
      const originalHeader = await headerLayout();
      check(originalHeader.controls.every((box, i, boxes) => box.x >= 0 && box.x + box.width <= width && (i === 0 || box.x >= boxes[i - 1].x + boxes[i - 1].width)), true, 'header controls do not overlap');
      await page.locator('#theme-toggle').click();
      check(await page.locator('html').getAttribute('data-theme'), 'dark');
      const darkHeader = await headerLayout();
      check({ height: darkHeader.height, controls: darkHeader.controls.slice(1) }, { height: originalHeader.height, controls: originalHeader.controls.slice(1) }, 'theme preserves notification and avatar positions');
      check(darkHeader.controls[0].x + darkHeader.controls[0].width <= darkHeader.controls[1].x, true, 'theme label fits without overlap');
      await page.locator('#theme-toggle').click();
      await page.locator('#alerts-toggle').click();
      check(await page.locator('#alerts-panel').isVisible(), true, 'header notification button works');
      check(await headerLayout(), originalHeader, 'notification preserves header positions');
      await page.keyboard.press('Escape');
      check(await page.locator('#profile-recovery-button').textContent(), 'รับรหัสผ่านใหม่');
      if (width <= 790) {
        const nav = await page.locator('.sidebar').boundingBox();
        check(Math.round(nav.width), width, 'bottom navigation fills viewport');
        check(nav.y >= 770, true, 'navigation stays at bottom');
      }
      for (const route of ['overview', 'chart', 'news', 'watchlist', 'profile']) {
        await page.locator(`.side-nav [data-workspace-route="${route}"]`).click();
        check(await page.locator('body').getAttribute('data-workspace-page'), route);
      }
      await page.locator('#profile-theme-toggle').click();
      check(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.locator('#profile-theme-toggle').click();
      check(await page.locator('html').getAttribute('data-theme'), 'light');
      await page.locator('#profile-alerts-button').click();
      check(await page.locator('#alerts-panel').isVisible(), true);
      await page.keyboard.press('Escape');
      check(await page.locator('#alerts-panel').isVisible(), false);
      check(await page.locator('#profile-alerts-button').evaluate(node => node === document.activeElement), true);
      check(await page.locator('.profile-legal a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))), ['/privacy.html', '/terms.html']);
      await page.locator('.side-nav [data-workspace-route="overview"]').click();
      await page.locator('#user-avatar').click();
      check(await page.locator('body').getAttribute('data-workspace-page'), 'profile', 'avatar click opens Profile');
      await page.locator('.side-nav [data-workspace-route="overview"]').click();
      await page.keyboard.press('Tab');
      await page.locator('#user-avatar').focus();
      check(await page.locator('#user-avatar').evaluate(node => node.matches(':focus-visible')), true, 'keyboard focus is visible');
      await page.keyboard.press('Enter');
      check(await page.locator('body').getAttribute('data-workspace-page'), 'profile');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('#profile-logout-button').evaluate(node => node.scrollIntoView({ block: 'center' }));
      const logout = await page.locator('#profile-logout-button').boundingBox();
      const bottom = width <= 790 ? (await page.locator('.sidebar').boundingBox()).y : 844;
      check(logout.y + logout.height <= bottom, true, 'content clears navigation');
      if (process.env.SETSCOPE_PROFILE_SCREENSHOT_DIR && [390, 1440].includes(width)) {
        fs.mkdirSync(process.env.SETSCOPE_PROFILE_SCREENSHOT_DIR, { recursive: true });
        await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(process.env.SETSCOPE_PROFILE_SCREENSHOT_DIR, `profile-${width}.png`), fullPage: true });
      }
      await Promise.all([page.waitForEvent('load'), page.locator('#profile-logout-button').click()]);
      await page.waitForSelector('#login-form:not([hidden])');
      check(requests.at(-1).scope, 'local', 'Profile Logout revokes only the current device');
      check(await page.evaluate(() => sessionStorage.getItem('setscope-auth-session-v1')), null);
      check(await page.locator('#app-shell').isVisible(), false);
      check(await page.locator('#login-form').isVisible(), true);
      await context.close();
    }
    phase = 'history-and-account-switch';
    const { context, page, state, login } = await makeContext(390);
    const expectNavigation = async (url, route) => {
      await page.waitForURL(url);
      await page.waitForFunction(route => document.body.dataset.workspacePage === route, route);
      check(page.url(), url, 'exact history URL');
      check(await page.locator('body').getAttribute('data-workspace-page'), route, 'restored workspace');
    };
    const expectNews = async url => {
      await expectNavigation(url, 'news');
      check(await page.locator('#news-search').inputValue(), 'PTT', 'restored News query');
      check(await page.locator('.source-chip[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.source)), ['infoquest'], 'restored News source');
    };
    const newsSettled = () => page.waitForFunction(() => !document.querySelector('#refresh-news').disabled && document.querySelector('#news-list').getAttribute('aria-busy') === 'false');
    await page.goto(`${base}/?symbol=CPALL&range=1M#chart`); await login();
    const chartUrl = page.url();
    const expectChart = async (url, range) => {
      await expectNavigation(url, 'chart');
      check(await page.locator('#stock-search').inputValue(), 'CPALL', 'restored chart symbol');
      check(await page.locator('.range-tabs .selected').getAttribute('data-range'), range, 'restored chart range');
    };
    await expectChart(chartUrl, '1M');
    await page.locator('.range-tabs [data-range="3M"]').click();
    const changedChartUrl = `${base}/?symbol=CPALL&range=3M#chart`;
    await expectChart(changedChartUrl, '3M');
    await page.locator('#user-avatar').click();
    check(new URL(page.url()).search, '');
    await page.goBack(); await expectChart(changedChartUrl, '3M');
    await page.goBack(); await expectChart(chartUrl, '1M');
    await page.goForward(); await expectChart(changedChartUrl, '3M');
    await page.goForward(); await expectNavigation(`${base}/#profile`, 'profile');
    let releaseArchive;
    state.archiveGate = new Promise(resolve => { releaseArchive = resolve; });
    const archiveRequested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/news-archive');
    await page.goto(`${base}/?s=PTT&source=infoquest&newsPage=3#news`); await page.waitForSelector('body.authenticated');
    await archiveRequested;
    const newsUrl = page.url();
    await page.locator('#user-avatar').click(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goBack(); await expectNews(newsUrl);
    releaseArchive(); state.archiveGate = null;
    await newsSettled();
    await expectNews(newsUrl); // Unavailable is not evidence that page 3 is out of range.
    await page.goForward(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goBack(); await expectNews(newsUrl);
    state.archiveMode = 'available';
    await page.reload(); await page.waitForSelector('body.authenticated'); await newsSettled();
    const expectThirdPage = async () => {
      await expectNews(newsUrl);
      await page.waitForFunction(() => document.querySelector('#news-pager .active')?.textContent === '3' && document.querySelector('#news-list')?.getAttribute('aria-busy') === 'false');
      check(await page.locator('#news-list .news-title-link').allTextContents(), historyRows('PTT').slice(20).map(row => row.title), 'restored News page 3 content');
    };
    await expectThirdPage();
    await page.locator('#user-avatar').click(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goBack(); await expectThirdPage();
    await page.goForward(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goBack(); await expectThirdPage();
    await page.goBack(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goForward(); await expectThirdPage();
    state.archiveMode = 'empty';
    await page.reload(); await page.waitForSelector('body.authenticated'); await newsSettled();
    await expectNews(`${base}/?s=PTT&source=infoquest#news`);
    check(await page.locator('#news-list .news-title-link').count(), 0, 'confirmed empty archive still clamps an out-of-range page');
    state.watchRows = historyRows('CPALL');
    await page.locator('.side-nav [data-workspace-route="watchlist"]').click();
    await page.locator('#watchlist-select-mobile').selectOption('list-2');
    await page.waitForFunction(() => document.querySelector('#watchlist-news-list')?.textContent.includes('CPALL'));
    await page.locator('#watchlist-news-pager').getByRole('button', { name: '2', exact: true }).click();
    const watchlistUrl = page.url();
    const expectWatchlist = async () => {
      await expectNavigation(watchlistUrl, 'watchlist');
      await page.waitForFunction(() => document.querySelector('#watchlist-news-pager .active')?.textContent === '2');
      await page.waitForFunction(expected => document.querySelector('#watchlist-news-list')?.getAttribute('aria-busy') === 'false'
        && JSON.stringify([...document.querySelectorAll('#watchlist-news-list .news-title-link')].map(node=>node.textContent)) === JSON.stringify(expected), state.watchRows.slice(10,20).map(row=>row.title));
      check(await page.locator('#watchlist-select-mobile').inputValue(), 'list-2', 'restored owner watchlist');
      check(new URL(page.url()).search, '?watchPage=2', 'private watchlist identity stays out of URL');
      check(await page.locator('#watchlist-news-list .news-title-link').allTextContents(), state.watchRows.slice(10, 20).map(row => row.title), 'restored Watchlist page 2 content');
    };
    await page.locator('#user-avatar').click(); await expectNavigation(`${base}/#profile`, 'profile');
    const cachedWatchRows=state.watchRows;
    state.watchRows=cachedWatchRows.map(row=>({...row,title:row.title+' อัปเดต'}));
    let releaseWatch;
    state.watchGate=new Promise(resolve=>{releaseWatch=resolve;});
    const watchRequested=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/watchlist-news');
    await page.goBack();await watchRequested;
    await page.waitForFunction(()=>document.querySelector('#watchlist-news-list').getAttribute('aria-busy')==='true');
    check(await page.locator('#watchlist-news-pager .active').textContent(),'2','pager can restore before the fresh response');
    check(await page.locator('#watchlist-news-list .news-title-link').allTextContents(),cachedWatchRows.slice(10,20).map(row=>row.title),'cached rows remain visible while refresh is pending');
    releaseWatch();state.watchGate=null;
    await expectWatchlist();
    await page.goForward(); await expectNavigation(`${base}/#profile`, 'profile');
    await page.goBack(); await expectWatchlist();
    await page.goBack(); await expectNavigation(`${base}/#watchlist`, 'watchlist');
    check(await page.locator('#watchlist-select-mobile').inputValue(), 'list-2', 'Back keeps the selected owner watchlist on page 1');
    await page.goForward(); await expectWatchlist();
    await page.locator('#user-avatar').click();
    await page.locator('#profile-recovery-button').click();
    await page.waitForFunction(() => document.querySelector('#profile-message').textContent === 'โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่');
    check(requests.at(-1).path, '/auth/v1/recover');
    state.verified = false;
    await page.reload(); await page.waitForSelector('body.authenticated');
    check(await page.locator('#profile-verification').textContent(), 'ยังไม่ยืนยันอีเมล');
    await page.locator('#profile-verification-button').click();
    await page.waitForFunction(() => document.querySelector('#profile-message').textContent.includes('หากอีเมลนี้'));
    check(requests.at(-1).path, '/auth/v1/resend');
    state.recoverStatus = 429;
    await page.locator('#profile-recovery-button').click();
    await page.waitForFunction(() => document.querySelector('#profile-message').textContent.includes('ไม่สำเร็จ'));
    check(await page.locator('#profile-recovery-button').isEnabled(), true);
    await Promise.all([page.waitForEvent('load'), page.locator('#profile-logout-button').click()]);
    check(requests.at(-1).scope, 'local');
    check(await page.locator('#profile-email').textContent(), '—');
    await login('b');
    check(await page.locator('#profile-email').textContent(), 'b@example.test');
    check(await page.locator('#profile-message').textContent(), '');
    phase = 'recovery';
    state.owner = 'a'; state.recoverStatus = 200;
    await page.goto(`${base}/#access_token=${token}&refresh_token=${token}&expires_in=3600&type=recovery`);
    await page.waitForSelector('#recovery-form:not([hidden])');
    check(new URL(page.url()).hash, '');
    check(await page.locator('#app-shell').isVisible(), false);
    await page.reload(); await page.waitForSelector('#recovery-form:not([hidden])');
    await page.setViewportSize({ width: 390, height: 450 });
    await page.locator('#recovery-form input[name="password"]').fill(password);
    await page.locator('#recovery-form input[name="confirmPassword"]').fill(password);
    state.updateStatus = 422;
    await page.locator('#recovery-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('ไม่สำเร็จ'));
    check(await page.locator('#app-shell').isVisible(), false);
    state.updateStatus = 200;
    await Promise.all([page.waitForEvent('load'), page.locator('#recovery-form button[type="submit"]').click()]);
    await page.waitForSelector('#login-form:not([hidden])');
    check(await page.evaluate(() => sessionStorage.getItem('setscope-auth-session-v1')), null);
    await page.locator('#forgot-password-button').click();
    await page.locator('#forgot-password-form input').fill('a@example.test');
    await page.locator('#forgot-password-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#auth-message').textContent === 'โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่');
    check(await page.locator('#app-shell').isVisible(), false);
    state.expired = true;
    await page.goto(`${base}/#access_token=${token}&refresh_token=${token}&type=recovery`);
    await page.waitForSelector('#login-form:not([hidden])');
    check(await page.locator('#recovery-form').isVisible(), false);
    await page.goto(`${base}/#error=access_denied&error_description=private-provider-detail&type=recovery`);
    await page.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('หมดอายุ'));
    check(new URL(page.url()).hash, '');
    check(await page.locator('#auth-message').textContent().then(text => text.includes('private-provider-detail')), false);
    check(pageErrors, []);
    await context.close();
    console.log(JSON.stringify({ profileBrowser: 'PASS', checks, widths: [320, 375, 390, 768, 1024, 1440], pageErrors: 0, fixtureOnly: true, realEmailAndPhysicalDevices: 'NOT RUN' }));
  } finally {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(JSON.stringify({ profileBrowser: 'FAIL', phase, name: error.name, assertion: error.code || null,
    frames: String(error.stack).split('\n').filter(line => /^\s+at /.test(line)), details: 'Credential values suppressed' }));
  process.exitCode = 1;
});
