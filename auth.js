(() => {
  const STORAGE_KEY = 'setscope-auth-session-v1';
  const AUTH_BOUNDARY_KEY = 'setscope-auth-boundary-v1';
  const THEME_KEY = 'setscope-theme';
  const APP_TITLE = 'SETscope — หุ้นไทยและกราฟเทคนิค';
  const APP_RETURN_KEY = 'setscope-auth-return-v1';
  let config = null;
  let session = readSession();
  let user = null;
  let refreshTimer;
  let authGeneration = 0;
  let sessionGeneration = session ? 1 : 0;
  let authOperationGeneration = 0;
  let activeOwnerId = '';
  let refreshInFlight = null;
  const pendingRequests = new Set();
  const AUTH_ROUTES = { login: '/login', signup: '/register' };
  const $ = selector => document.querySelector(selector);
  function appRouteFromLocation() {
    if (location.hash.includes('access_token=')) return '';
    const route = location.hash.replace(/^#/, '');
    if (!['overview', 'chart', 'news', 'watchlist'].includes(route)) return '';
    const pathname = location.pathname === AUTH_ROUTES.login || location.pathname === AUTH_ROUTES.signup ? '/' : location.pathname;
    return `${pathname || '/'}${location.search}${location.hash}`;
  }
  function rememberAppRoute() {
    const route = appRouteFromLocation();
    if (route) sessionStorage.setItem(APP_RETURN_KEY, route);
  }
  function restoreAppRoute() {
    const route = sessionStorage.getItem(APP_RETURN_KEY);
    if (!route || !/^\/(?:\?[^#]*)?#(?:overview|chart|news|watchlist)$/.test(route)) return false;
    sessionStorage.removeItem(APP_RETURN_KEY);
    history.replaceState(null, '', route);
    return true;
  }
  function setAuthTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    const icon = $('#auth-theme-icon'); if (icon) icon.textContent = next === 'dark' ? '☀' : '☾';
    const label = $('#auth-theme-label'); if (label) label.textContent = next === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด';
    const button = $('#auth-theme-toggle'); if (button) button.setAttribute('aria-label', next === 'dark' ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด');
    const themeColor = $('meta[name="theme-color"]'); if (themeColor) themeColor.content = next === 'dark' ? '#0b1118' : '#f6f7f9';
  }
  const message = (text, type = '') => { const box = $('#auth-message'); box.textContent = text; box.className = `auth-message ${type}`.trim(); };
  async function fetchWithWake(url, options = {}, tries = 3) {
    let lastError;
    for (let i = 0; i < tries; i++) {
      try {
        const response = await fetch(url, { ...options, signal: AbortSignal.timeout(45000) });
        if (response.status !== 503) return response;
        lastError = new Error('ระบบกำลังเริ่มทำงาน');
      } catch (error) {
        lastError = error;
      }
      if (i < tries - 1) await new Promise(resolve => setTimeout(resolve, 3000 * (i + 1)));
    }
    throw lastError;
  }
  function readSession() { try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; } }
  function writeSession(value) { session = value; if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else sessionStorage.removeItem(STORAGE_KEY); }
  function replaceSession(value) { sessionGeneration += 1; writeSession(value); }
  function sessionFrom(payload) { return { ...payload, expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000 }; }
  function captureSession() {
    return Object.freeze({
      generation: sessionGeneration,
      operationGeneration: authOperationGeneration,
      accessToken: session?.access_token || '',
      refreshToken: session?.refresh_token || ''
    });
  }
  function isCurrentSession(original, { requireRefreshToken = false } = {}) {
    return Boolean(original && original.generation === sessionGeneration
      && original.operationGeneration === authOperationGeneration
      && session?.access_token
      && (!requireRefreshToken || original.refreshToken === session?.refresh_token));
  }
  function beginAuthOperation() {
    authOperationGeneration += 1;
    clearTimeout(refreshTimer);
    abortPendingRequests();
    return authOperationGeneration;
  }
  function isCurrentAuthOperation(generation) { return generation === authOperationGeneration; }
  function captureIdentity() { return Object.freeze({ ownerId: activeOwnerId, generation: authGeneration }); }
  function isCurrentIdentity(identity) {
    return Boolean(identity?.ownerId && session?.access_token
      && identity.ownerId === activeOwnerId && identity.generation === authGeneration);
  }
  function staleSessionError() {
    const error = new Error('เซสชันเปลี่ยนระหว่างดำเนินการ');
    error.code = 'STALE_SESSION';
    return error;
  }
  function abortPendingRequests() {
    for (const controller of pendingRequests) controller.abort();
    pendingRequests.clear();
  }
  function publishAuthBoundary(ownerId, reason) {
    if (!ownerId) return;
    try {
      localStorage.setItem(AUTH_BOUNDARY_KEY, JSON.stringify({ ownerId, reason, nonce: `${Date.now()}-${Math.random()}` }));
    } catch (_) {}
  }
  function endPrivateSession(reason, { broadcast = false, reload = false, text = 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง' } = {}) {
    const previousOwnerId = activeOwnerId || String(user?.id || '');
    if (broadcast) publishAuthBoundary(previousOwnerId, reason);
    beginAuthOperation();
    refreshInFlight = null;
    authGeneration += 1;
    activeOwnerId = '';
    replaceSession(null);
    user = null;
    window.dispatchEvent(new CustomEvent('setscope:session-boundary', {
      detail: { ownerId: previousOwnerId, generation: authGeneration, reason }
    }));
    showLogin(text, reason === 'logout' ? '' : 'error');
    if (reload) window.location.reload();
  }
  async function authRequest(path, options = {}) {
    const response = await fetch(`${config.url}/auth/v1/${path}`, { ...options, headers: { apikey: config.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || payload.error || 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง');
    return payload;
  }
  async function refreshSession() {
    if (!config?.configured || !session?.refresh_token) return false;
    const original = captureSession();
    if (refreshInFlight?.generation === original.generation
      && refreshInFlight.operationGeneration === original.operationGeneration
      && refreshInFlight.refreshToken === original.refreshToken) return refreshInFlight.promise;
    const promise = (async () => {
      try {
        const refreshed = await authRequest('token?grant_type=refresh_token', {
          method: 'POST', body: JSON.stringify({ refresh_token: original.refreshToken })
        });
        if (!isCurrentSession(original, { requireRefreshToken: true })) return false;
        writeSession(sessionFrom(refreshed));
        scheduleRefresh();
        return true;
      } catch (_) {
        return false;
      }
    })();
    refreshInFlight = {
      generation: original.generation,
      operationGeneration: original.operationGeneration,
      refreshToken: original.refreshToken,
      promise
    };
    try { return await promise; }
    finally { if (refreshInFlight?.promise === promise) refreshInFlight = null; }
  }
  async function ensureFresh() {
    if (!session?.access_token) return false;
    if (Number(session.expires_at) < Date.now() + 60_000 && !await refreshSession()) return false;
    return true;
  }
  async function validateSession(operationGeneration = authOperationGeneration) {
    const beforeRefresh = captureSession();
    if (!isCurrentAuthOperation(operationGeneration) || !await ensureFresh() || !isCurrentAuthOperation(operationGeneration)) {
      if (isCurrentSession(beforeRefresh)) { replaceSession(null); user = null; }
      return null;
    }
    const original = captureSession();
    try {
      const validatedUser = await authRequest('user', { headers: { Authorization: `Bearer ${original.accessToken}` } });
      if (!isCurrentSession(original)) return null;
      user = validatedUser;
      return user;
    } catch (_) {
      if (isCurrentSession(original)) { replaceSession(null); user = null; }
      return null;
    }
  }
  function showDashboard() {
    const nextOwnerId = String(user?.id || '');
    if (!nextOwnerId) { showLogin('ไม่สามารถยืนยันเจ้าของบัญชีได้', 'error'); return; }
    if (activeOwnerId !== nextOwnerId) {
      authGeneration += 1;
      activeOwnerId = nextOwnerId;
    }
    document.body.classList.remove('auth-checking');
    $('#auth-gate').removeAttribute('aria-busy');
    const pathname = location.pathname.replace(/\/+$/, '') || '/';
    if (pathname === AUTH_ROUTES.login || pathname === AUTH_ROUTES.signup) {
      if (!restoreAppRoute()) history.replaceState(null, '', '/#overview');
    }
    document.body.classList.add('authenticated');
    $('#auth-gate').hidden = true;
    $('#app-shell').setAttribute('aria-hidden', 'false');
    document.title = APP_TITLE;
    const email = user?.email || '';
    const avatar = $('#user-avatar'); if (avatar) { avatar.textContent = email.slice(0, 1).toUpperCase() || 'ก'; avatar.title = email; }
    message('');
    window.dispatchEvent(new CustomEvent('setscope:authenticated', {
      detail: { email, userId: activeOwnerId, generation: authGeneration }
    }));
  }
  function showLogin(text = '', type = '') {
    document.body.classList.remove('auth-checking');
    $('#auth-gate').removeAttribute('aria-busy');
    document.body.classList.remove('authenticated');
    $('#auth-gate').hidden = false;
    $('#app-shell')?.setAttribute('aria-hidden', 'true');
    const pathname = location.pathname.replace(/\/+$/, '') || '/';
    const onAuthRoute = pathname === AUTH_ROUTES.login || pathname === AUTH_ROUTES.signup;
    if (!onAuthRoute) rememberAppRoute();
    setMode(onAuthRoute ? modeFromPath() : 'login', { updateUrl: !onAuthRoute, replace: true });
    message(text, type);
  }
  function modeFromPath() {
    return (location.pathname.replace(/\/+$/, '') || '/') === AUTH_ROUTES.signup ? 'signup' : 'login';
  }
  function setMode(mode, { updateUrl = true, replace = false } = {}) {
    const signup = mode === 'signup';
    $('#login-form').hidden = signup; $('#signup-form').hidden = !signup;
    $('#auth-login-tab').classList.toggle('selected', !signup); $('#auth-signup-tab').classList.toggle('selected', signup);
    $('#auth-login-tab').setAttribute('aria-selected', String(!signup)); $('#auth-signup-tab').setAttribute('aria-selected', String(signup));
    $('#auth-title').textContent = signup ? 'สร้างบัญชี SETscope' : 'เข้าสู่ระบบ SETscope';
    document.title = signup ? 'สมัครสมาชิก — SETscope' : 'เข้าสู่ระบบ — SETscope';
    if (updateUrl) {
      const route = signup ? AUTH_ROUTES.signup : AUTH_ROUTES.login;
      if (location.pathname !== route || location.search || location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', route);
    }
    message('');
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session?.expires_at) return;
    const scheduled = captureSession();
    refreshTimer = setTimeout(async () => {
      if (!isCurrentSession(scheduled)) return;
      const refreshed = await refreshSession();
      if (!isCurrentAuthOperation(scheduled.operationGeneration) || scheduled.generation !== sessionGeneration) return;
      if (!refreshed) endPrivateSession('expiry', { broadcast: true, reload: true });
    }, Math.max(15_000, Number(session.expires_at) - Date.now() - 60_000));
  }
  async function openDashboardIfValid(operationGeneration = authOperationGeneration) {
    const valid = await validateSession(operationGeneration);
    if (!valid || !isCurrentAuthOperation(operationGeneration) || user !== valid) return false;
    scheduleRefresh(); showDashboard(); return true;
  }
  async function onLogin(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const submit = event.currentTarget.querySelector('[type=submit]');
    const operationGeneration = beginAuthOperation();
    submit.disabled = true; message('กำลังตรวจสอบบัญชี…');
    try {
      const result = await authRequest('token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      if (!isCurrentAuthOperation(operationGeneration)) return;
      replaceSession(sessionFrom(result));
      const original = captureSession();
      const authenticatedUser = result.user || await authRequest('user', { headers: { Authorization: `Bearer ${original.accessToken}` } });
      if (!isCurrentSession(original)) return;
      user = authenticatedUser;
      scheduleRefresh(); showDashboard();
    } catch (error) {
      if (isCurrentAuthOperation(operationGeneration)) message(error.message, 'error');
    } finally {
      if (isCurrentAuthOperation(operationGeneration)) submit.disabled = false;
    }
  }
  async function onSignup(event) {
    event.preventDefault(); const signupForm = event.currentTarget; const form = new FormData(signupForm); const password = String(form.get('password') || ''); const submit = signupForm.querySelector('[type=submit]');
    if (password !== form.get('confirmPassword')) { message('รหัสผ่านที่กรอกไม่ตรงกัน', 'error'); return; }
    const operationGeneration = beginAuthOperation();
    submit.disabled = true; message('กำลังสร้างบัญชี…');
    try {
      const result = await authRequest(`signup?redirect_to=${encodeURIComponent(window.location.origin)}`, { method: 'POST', body: JSON.stringify({ email: form.get('email'), password, data: { terms_accepted_at: new Date().toISOString(), terms_version: '2026-10-13' } }) });
      if (!isCurrentAuthOperation(operationGeneration)) return;
      if (result.access_token) {
        replaceSession(sessionFrom(result));
        const original = captureSession();
        const authenticatedUser = result.user || await authRequest('user', { headers: { Authorization: `Bearer ${original.accessToken}` } });
        if (!isCurrentSession(original)) return;
        user = authenticatedUser;
        scheduleRefresh(); showDashboard();
      } else {
        signupForm.reset(); setMode('login', { replace: true });
        message('สมัครสมาชิกแล้ว กรุณากดยืนยันจากอีเมลก่อน แล้วกลับมาเข้าสู่ระบบ', 'success');
      }
    } catch (error) {
      if (isCurrentAuthOperation(operationGeneration)) message(error.message, 'error');
    } finally {
      if (isCurrentAuthOperation(operationGeneration)) submit.disabled = false;
    }
  }
  async function logout() {
    rememberAppRoute();
    const accessToken = session?.access_token || '';
    endPrivateSession('logout', { broadcast: true, text: '' });
    try { if (accessToken) await authRequest('logout', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }); } catch (_) {}
    setMode('login', { replace: true }); window.location.reload();
  }
  async function authorizedFetch(url, options = {}) {
    const operationGeneration = authOperationGeneration;
    const sessionState = captureSession();
    if (!await ensureFresh()) {
      if (!isCurrentAuthOperation(operationGeneration) || sessionState.generation !== sessionGeneration) throw staleSessionError();
      const wasAuthenticated = document.body.classList.contains('authenticated');
      endPrivateSession('expiry', { broadcast: true, reload: wasAuthenticated });
      throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
    }
    const identity = captureIdentity();
    if (!isCurrentIdentity(identity)) throw staleSessionError();
    const controller = new AbortController();
    const externalSignal = options.signal;
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', () => controller.abort(), { once: true });
    pendingRequests.add(controller);
    const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${session.access_token}`);
    try {
      let response = await fetch(url, { ...options, headers, signal: controller.signal });
      if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
      if (response.status === 401) {
        const refreshed = await refreshSession();
        if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
        if (refreshed) {
          headers.set('Authorization', `Bearer ${session.access_token}`);
          response = await fetch(url, { ...options, headers, signal: controller.signal });
          if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
        } else {
          endPrivateSession('expiry', { broadcast: true, reload: true });
          throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
        }
      }
      return response;
    } catch (error) {
      if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
      throw error;
    } finally {
      pendingRequests.delete(controller);
    }
  }
  window.setscopeAuth = {
    get accessToken() { return session?.access_token || ''; },
    get user() { return user; },
    captureIdentity,
    isCurrentIdentity,
    refresh: refreshSession,
    authorizedFetch
  };
  setAuthTheme(localStorage.getItem(THEME_KEY) || 'light');
  $('#auth-theme-toggle').addEventListener('click', () => setAuthTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#auth-login-tab').addEventListener('click', () => setMode('login'));
  $('#auth-signup-tab').addEventListener('click', () => setMode('signup'));
  $('#login-form').addEventListener('submit', onLogin);
  $('#signup-form').addEventListener('submit', onSignup);
  $('#logout-button').addEventListener('click', logout);
  window.addEventListener('storage', event => {
    if (event.key !== AUTH_BOUNDARY_KEY || !event.newValue || !activeOwnerId) return;
    try {
      const boundary = JSON.parse(event.newValue);
      if (boundary?.ownerId === activeOwnerId) endPrivateSession('remote-logout', { reload: true, text: '' });
    } catch (_) {}
  });
  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('authenticated')) showDashboard();
    else setMode(modeFromPath(), { updateUrl: false });
  });
  const isAuthCallback = location.hash.includes('access_token=');
  if (session?.access_token || isAuthCallback) {
    document.body.classList.add('auth-checking');
    $('#auth-gate').setAttribute('aria-busy', 'true');
  } else {
    rememberAppRoute();
    setMode(modeFromPath(), { replace: true });
  }

  (async () => {
    try {
      message('กำลังเริ่มระบบ อาจใช้เวลาประมาณ 1 นาที');
      const response = await fetchWithWake('/api/auth-config', { cache: 'no-store' }); config = await response.json();
      if (!config.configured) {
        document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = true; });
        showLogin('ระบบสมาชิกยังไม่ได้ตั้งค่าใน Render (SUPABASE_URL และ SUPABASE_ANON_KEY)', 'error'); return;
      }
      document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = false; });
      if (location.hash.includes('access_token=')) {
        const params = new URLSearchParams(location.hash.slice(1));
        if (params.get('access_token')) {
          beginAuthOperation();
          replaceSession(sessionFrom({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') }));
          history.replaceState(null, '', location.pathname + location.search);
        }
      }
      const operationGeneration = authOperationGeneration;
      if (!await openDashboardIfValid(operationGeneration) && isCurrentAuthOperation(operationGeneration)) showLogin();
    } catch (_) { showLogin('เชื่อมต่อระบบสมาชิกไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ', 'error'); }
  })();
})();
