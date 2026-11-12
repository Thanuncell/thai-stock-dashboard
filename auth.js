((loginWithSession) => {
  function readAuthCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    if (!['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'error'].some(key => params.has(key))) return null;
    history.replaceState(null, '', location.pathname + location.search);
    return { access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') ?? 3600, type: params.get('type'), error: params.has('error') };
  }
  let authCallback = readAuthCallback();
  const STORAGE_KEY = 'setscope-auth-session-v1';
  const AUTH_BOUNDARY_KEY = 'setscope-auth-boundary-v1';
  const LOGOUT_PENDING_KEY = 'setscope-remembered-logout-pending';
  const THEME_KEY = 'setscope-theme';
  const APP_TITLE = 'SETscope — หุ้นไทยและกราฟเทคนิค';
  const APP_RETURN_KEY = 'setscope-auth-return-v1';
  const APP_RETURN_INTENT_KEY = 'setscope-auth-return-intent-v1';
  const RECOVERY_KEY = 'setscope-auth-recovery-v1';
  let recoveryPending = authCallback?.type === 'recovery' || sessionStorage.getItem(RECOVERY_KEY) === '1';
  let config = null;
  let session = readSession();
  let remembered = null;
  let user = null;
  let refreshTimer;
  let authGeneration = 0;
  let sessionGeneration = session ? 1 : 0;
  let authOperationGeneration = 0;
  let activeOwnerId = '';
  let privateUiReadyGeneration = -1;
  let refreshInFlight = null;
  const pendingRequests = new Set();
  const AUTH_ROUTES = { login: '/login', signup: '/register' };
  const $ = selector => document.querySelector(selector);
  const rememberDevice = $('#remember-device');
  const canRemember = () => config?.rememberDevice === true && Boolean(window.navigator?.locks);
  // The normal bootstrap provides no session adapter. B1 exercises it only in fixtures.
  if (loginWithSession && rememberDevice) {
    rememberDevice.disabled = false;
    rememberDevice.parentElement.hidden = false;
  }
  const rememberAvailable = () => Boolean(loginWithSession || canRemember());
  function appRouteFromLocation() {
    if (location.hash.includes('access_token=')) return '';
    const route = location.hash.replace(/^#/, '');
    const pathname = location.pathname === AUTH_ROUTES.login || location.pathname === AUTH_ROUTES.signup ? '/' : location.pathname;
    if (route === 'screener') return (pathname || '/') + '#overview';
    if (!['overview', 'chart', 'news', 'watchlist', 'profile'].includes(route)) return '';
    return `${pathname || '/'}${location.search}${location.hash}`;
  }
  function rememberAppRoute() {
    const route = appRouteFromLocation();
    if (route) {
      sessionStorage.setItem(APP_RETURN_KEY, route);
      sessionStorage.setItem(APP_RETURN_INTENT_KEY, route);
    }
  }
  function restoreAppRoute() {
    const route = sessionStorage.getItem(APP_RETURN_KEY);
    const intentional = sessionStorage.getItem(APP_RETURN_INTENT_KEY) === route;
    sessionStorage.removeItem(APP_RETURN_KEY);
    sessionStorage.removeItem(APP_RETURN_INTENT_KEY);
    if (route && /^\/(?:\?[^#]*)?#screener$/.test(route)) {
      history.replaceState(null, '', '/#overview');
      return true;
    }
    if (!route || !/^\/(?:\?[^#]*)?#(?:overview|chart|news|watchlist|profile)$/.test(route)
      || !intentional && route.endsWith('#profile')) return false;
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
  function readSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (!value) return null;
      if (typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(Number(value.expires_at)) || Number(value.expires_at) <= 0) {
        sessionStorage.removeItem(STORAGE_KEY); return null;
      }
      return { access_token: value.access_token, refresh_token: typeof value.refresh_token === 'string' ? value.refresh_token : '', expires_at: Number(value.expires_at) };
    } catch (_) { return null; }
  }
  function writeSession(value) { session = value; if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else sessionStorage.removeItem(STORAGE_KEY); }
  function replaceSession(value) { sessionGeneration += 1; writeSession(value); }
  function sessionFrom(payload) {
    const expiresIn = Number(payload.expires_in ?? 3600);
    const expiresAt = Date.now() + expiresIn * 1000;
    if (typeof payload.access_token !== 'string' || !payload.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(expiresAt)) throw Error('ข้อมูลเซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง');
    return { access_token: payload.access_token, refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : '', expires_at: expiresAt };
  }
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
    return Boolean(identity?.ownerId && (session?.access_token || remembered)
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
    privateUiReadyGeneration = -1;
    replaceSession(null);
    remembered = null;
    user = null;
    recoveryPending = false;
    sessionStorage.removeItem(RECOVERY_KEY);
    renderProfile();
    $('#recovery-form')?.reset();
    $('#forgot-password-form')?.reset();
    window.dispatchEvent(new CustomEvent('setscope:session-boundary', {
      detail: { ownerId: previousOwnerId, generation: authGeneration, reason }
    }));
    if (reason === 'logout') {
      sessionStorage.removeItem(APP_RETURN_KEY);
      sessionStorage.removeItem(APP_RETURN_INTENT_KEY);
      history.replaceState(null, '', AUTH_ROUTES.login);
    }
    showLogin(text, reason === 'logout' ? '' : 'error');
    if (reload) window.location.reload();
  }
  async function authRequest(path, options = {}) {
    const response = await fetch(`${config.url}/auth/v1/${path}`, { ...options, redirect: 'error', referrerPolicy: 'no-referrer', headers: { apikey: config.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || payload.error || 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง');
    return payload;
  }
  async function rememberedRequest(action, generation, body) {
    const response = await fetch(`/api/auth/session/${action}`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
      headers: {
        'x-setscope-request': '1',
        ...(generation ? { 'x-setscope-session': generation } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const error = new Error('ดำเนินการเกี่ยวกับเซสชันไม่สำเร็จ กรุณาลองอีกครั้ง');
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  function withSessionCookie(action) {
    return window.navigator.locks.request('setscope-remembered-session', action);
  }

  function markRememberedLogout(ownerId) {
    try {
      if (ownerId) localStorage.setItem(LOGOUT_PENDING_KEY, ownerId);
      else localStorage.removeItem(LOGOUT_PENDING_KEY);
    } catch (_) {}
  }

  async function restoreRemembered() {
    try { return await rememberedRequest('restore'); }
    catch (error) { if (error.status === 401) return null; throw error; }
  }

  function acceptRemembered(result) {
    if (!result?.user?.id || typeof result.generation !== 'string'
      || !Number.isFinite(result.remainingMs) || result.remainingMs <= 0) throw new Error('ข้อมูลเซสชันไม่ถูกต้อง');
    replaceSession(null);
    remembered = { generation: result.generation, remainingMs: result.remainingMs };
    user = result.user;
    scheduleRefresh();
    showDashboard();
  }

  async function refreshSession() {
    if (remembered) {
      const original = remembered;
      const operation = authOperationGeneration;
      try {
        const result = await rememberedRequest('refresh', original.generation);
        if (original !== remembered || !isCurrentAuthOperation(operation)) return false;
        if (result.generation !== original.generation || result.user?.id !== user?.id) {
          endPrivateSession('expiry');
          return false;
        }
        original.remainingMs = result.remainingMs;
        scheduleRefresh();
        return true;
      } catch (error) {
        if (error.status === 401 && original === remembered && isCurrentAuthOperation(operation)) endPrivateSession('expiry');
        return false;
      }
    }
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
    if (recoveryPending) { showRecoveryForm(); return; }
    const nextOwnerId = String(user?.id || '');
    if (!nextOwnerId) { showLogin('ไม่สามารถยืนยันเจ้าของบัญชีได้', 'error'); return; }
    if (activeOwnerId !== nextOwnerId) {
      authGeneration += 1;
      activeOwnerId = nextOwnerId;
      privateUiReadyGeneration = -1;
    }
    const pathname = location.pathname.replace(/\/+$/, '') || '/';
    if (pathname === AUTH_ROUTES.login || pathname === AUTH_ROUTES.signup) {
      if (!restoreAppRoute()) history.replaceState(null, '', '/#overview');
    }
    const identity = captureIdentity();
    renderProfile();
    if (privateUiReadyGeneration === identity.generation && document.body.classList.contains('authenticated')) return;
    document.body.classList.remove('authenticated');
    document.body.classList.add('auth-checking');
    $('#auth-gate').setAttribute('aria-busy', 'true');
    $('#auth-gate').hidden = true;
    $('#app-shell').setAttribute('aria-hidden', 'true');
    window.dispatchEvent(new CustomEvent('setscope:authenticated', {
      detail: { email: user?.email || '', userId: identity.ownerId, generation: identity.generation }
    }));
  }
  function markPrivateUiReady(identity) {
    if (recoveryPending || !isCurrentIdentity(identity)) return false;
    privateUiReadyGeneration = identity.generation;
    document.body.classList.remove('auth-checking');
    $('#auth-gate').removeAttribute('aria-busy');
    document.body.classList.add('authenticated');
    $('#auth-gate').hidden = true;
    $('#app-shell').setAttribute('aria-hidden', 'false');
    document.title = APP_TITLE;
    const email = user?.email || '';
    const avatar = $('#user-avatar'); if (avatar) { avatar.textContent = email.slice(0, 1).toUpperCase() || 'ก'; avatar.title = email; }
    message('');
    return true;
  }
  function showLogin(text = '', type = '') {
    if (!session) { recoveryPending = false; sessionStorage.removeItem(RECOVERY_KEY); }
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
    if (recoveryPending && session?.access_token) { showRecoveryForm(); return; }
    const signup = mode === 'signup';
    const forgot = mode === 'forgot';
    if (rememberDevice) {
      rememberDevice.checked = false;
      rememberDevice.disabled = !rememberAvailable();
    }
    $('#login-form').hidden = signup || forgot; $('#signup-form').hidden = !signup;
    if ($('#forgot-password-form')) $('#forgot-password-form').hidden = !forgot;
    if ($('#recovery-form')) $('#recovery-form').hidden = true;
    $('#auth-login-tab').classList.toggle('selected', !signup); $('#auth-signup-tab').classList.toggle('selected', signup);
    $('#auth-login-tab').setAttribute('aria-selected', String(!signup)); $('#auth-signup-tab').setAttribute('aria-selected', String(signup));
    $('#auth-title').textContent = forgot ? 'ตั้งรหัสผ่านใหม่' : signup ? 'สร้างบัญชี SETscope' : 'เข้าสู่ระบบ SETscope';
    document.title = signup ? 'สมัครสมาชิก — SETscope' : 'เข้าสู่ระบบ — SETscope';
    if (updateUrl) {
      const route = signup ? AUTH_ROUTES.signup : AUTH_ROUTES.login;
      if (location.pathname !== route || location.search || location.hash) history[replace ? 'replaceState' : 'pushState'](null, '', route);
    }
    message('');
  }
  function renderProfile() {
    const email = typeof user?.email === 'string' ? user.email : '';
    const verified = Boolean(email && user?.email_confirmed_at && Number.isFinite(Date.parse(user.email_confirmed_at)));
    const setText = (selector, text) => { const node = $(selector); if (node) node.textContent = text; };
    setText('#profile-email', email || '—');
    setText('#profile-verification', email ? verified ? 'ยืนยันอีเมลแล้ว' : 'ยังไม่ยืนยันอีเมล' : '—');
    setText('#profile-message', '');
    const resend = $('#profile-verification-button');
    if (resend) { resend.hidden = !email || verified; resend.disabled = !email; }
    const recovery = $('#profile-recovery-button'); if (recovery) recovery.disabled = !email;
    const avatar = $('#user-avatar');
    if (avatar) { avatar.textContent = email.slice(0, 1).toUpperCase() || 'ก'; avatar.title = email; }
  }
  function showRecoveryForm() {
    document.body.classList.remove('authenticated', 'auth-checking');
    $('#auth-gate').hidden = false;
    $('#auth-gate').removeAttribute('aria-busy');
    $('#app-shell').setAttribute('aria-hidden', 'true');
    $('#login-form').hidden = true; $('#signup-form').hidden = true;
    if ($('#forgot-password-form')) $('#forgot-password-form').hidden = true;
    if ($('#recovery-form')) $('#recovery-form').hidden = false;
    $('#auth-title').textContent = 'ตั้งรหัสผ่านใหม่';
    document.title = 'ตั้งรหัสผ่านใหม่ — SETscope';
    sessionStorage.setItem(RECOVERY_KEY, '1');
    history.replaceState(null, '', '/login');
    message('');
  }
  async function sendAccountEmail(kind, button, email) {
    if (!config?.configured || !email || button.disabled) return;
    const original = captureSession();
    button.disabled = true;
    const profile = kind !== 'forgot';
    const report = text => { if (profile) $('#profile-message').textContent = text; else message(text); };
    report('กำลังส่งอีเมล…');
    try {
      const endpoint = kind === 'verification' ? 'resend' : 'recover';
      await authRequest(`${endpoint}?redirect_to=${encodeURIComponent(window.location.origin)}`, {
        method: 'POST', body: JSON.stringify(kind === 'verification' ? { type: 'signup', email } : { email })
      });
      if (original.generation !== sessionGeneration || !isCurrentAuthOperation(original.operationGeneration)) return;
      report(kind === 'verification' ? 'หากอีเมลนี้ใช้งานได้ ระบบจะส่งลิงก์ให้ กรุณาตรวจสอบกล่องจดหมายและสแปม'
        : 'โปรดตรวจสอบอีเมลของคุณ หากมีบัญชีอยู่แล้ว คุณจะได้รับคำแนะนำในการตั้งรหัสผ่านใหม่');
    } catch (_) {
      if (original.generation === sessionGeneration && isCurrentAuthOperation(original.operationGeneration)) report('ส่งอีเมลไม่สำเร็จ กรุณารอสักครู่แล้วลองอีกครั้ง');
    } finally {
      if (original.generation === sessionGeneration && isCurrentAuthOperation(original.operationGeneration)) button.disabled = false;
    }
  }
  async function onRecovery(event) {
    event.preventDefault();
    const form = event.currentTarget, values = new FormData(form), password = String(values.get('password') || '');
    const submit = form.querySelector('[type=submit]');
    if (submit.disabled || !recoveryPending || !user?.id || !session?.access_token) return;
    if (password.length < 8 || password !== values.get('confirmPassword')) { message('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และตรงกันทั้งสองช่อง', 'error'); return; }
    const original = captureSession();
    submit.disabled = true;
    try {
      if (!await ensureFresh() || !isCurrentSession(original)) throw staleSessionError();
      await authRequest('user', { method: 'PUT', headers: { Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ password }) });
      if (!isCurrentSession(original)) return;
      form.reset();
      await logout();
    } catch (_) {
      if (isCurrentSession(original)) message('ตั้งรหัสผ่านไม่สำเร็จ ลิงก์อาจหมดอายุ กรุณาขอลิงก์ใหม่หรือลองอีกครั้ง', 'error');
    } finally { if (isCurrentSession(original)) submit.disabled = false; }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (remembered) {
      const original = remembered;
      refreshTimer = setTimeout(() => {
        if (remembered === original) endPrivateSession('expiry');
      }, Math.max(0, original.remainingMs));
      return;
    }
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
  async function consumeAuthCallback(callback) {
    if (callback.error || !callback.access_token) {
      endPrivateSession('invalid-callback', { text: 'ลิงก์ยืนยันหมดอายุหรือไม่ถูกต้อง กรุณาขอลิงก์ใหม่' }); return;
    }
    beginAuthOperation();
    recoveryPending = callback.type === 'recovery';
    replaceSession(sessionFrom(callback));
    const operationGeneration = authOperationGeneration;
    if (!await openDashboardIfValid(operationGeneration) && isCurrentAuthOperation(operationGeneration)) showLogin('ลิงก์ยืนยันหมดอายุหรือไม่ถูกต้อง กรุณาขอลิงก์ใหม่', 'error');
  }
  async function onLogin(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const submit = event.currentTarget.querySelector('[type=submit]');
    const credentials = { email: form.get('email'), password: form.get('password') };
    const operationGeneration = beginAuthOperation();
    if (rememberDevice) rememberDevice.disabled = true;
    submit.disabled = true; message('กำลังตรวจสอบบัญชี…');
    try {
      const rememberSelected = form.get('rememberDevice') === 'on';
      if (!loginWithSession && config?.rememberedSessionRoutes && window.navigator?.locks) {
        const result = await withSessionCookie(async () => {
          if (!isCurrentAuthOperation(operationGeneration)) return null;
          const previous = await restoreRemembered();
          if (!isCurrentAuthOperation(operationGeneration)) return null;
          if (canRemember() && rememberSelected) {
            const next = await rememberedRequest('login', previous?.generation, { ...credentials, rememberDevice: true });
            if (previous) publishAuthBoundary(previous.user.id, 'remembered-switch');
            return next;
          }
          if (previous) {
            await rememberedRequest('logout', previous.generation);
            publishAuthBoundary(previous.user.id, 'remembered-logout');
          }
          return null;
        });
        if (!isCurrentAuthOperation(operationGeneration)) return;
        markRememberedLogout(null);
        if (result) {
          acceptRemembered(result);
          return;
        }
      }
      const result = loginWithSession
        ? await loginWithSession(credentials, { rememberDevice: rememberSelected })
        : await authRequest('token?grant_type=password', { method: 'POST', body: JSON.stringify(credentials) });
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
      if (isCurrentAuthOperation(operationGeneration)) {
        submit.disabled = false;
        if (rememberDevice) rememberDevice.disabled = !rememberAvailable();
      }
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
    if (remembered) {
      const { generation } = remembered;
      const ownerId = activeOwnerId;
      endPrivateSession('logout', { text: '' });
      const operation = authOperationGeneration;
      try {
        await withSessionCookie(async () => {
          markRememberedLogout(ownerId);
          await rememberedRequest('logout', generation);
          markRememberedLogout(null);
          publishAuthBoundary(ownerId, 'remembered-logout');
        });
      } catch (_) {
        if (isCurrentAuthOperation(operation)) message('ยังยืนยันการออกจากระบบไม่ได้ กรุณาลองเข้าสู่ระบบอีกครั้ง', 'error');
      }
      return;
    }
    const accessToken = session?.access_token || '';
    endPrivateSession('logout', { broadcast: true, text: '' });
    const operationGeneration = authOperationGeneration;
    try { if (accessToken) await authRequest('logout?scope=local', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } }); } catch (_) {}
    if (!isCurrentAuthOperation(operationGeneration)) return;
    setMode('login', { replace: true }); window.location.reload();
  }
  async function authorizedFetch(url, options = {}) {
    let target;
    try { target = new URL(String(url), window.location.origin); } catch (_) {}
    if (!target || target.origin !== window.location.origin || target.username || target.password || !target.pathname.startsWith('/api/')) {
      throw Object.assign(Error('ปลายทางคำขอไม่ถูกต้อง'), { code: 'UNSAFE_AUTH_TARGET' });
    }
    url = target.pathname + target.search;
    options = { ...options, redirect: 'error', referrerPolicy: 'no-referrer' };
    const operationGeneration = authOperationGeneration;
    const sessionState = captureSession();
    const cookieSession = remembered;
    if (!cookieSession && !await ensureFresh()) {
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
    const headers = new Headers(options.headers || {});
    if (cookieSession) {
      headers.delete('Authorization');
      headers.set('x-setscope-request', '1');
      headers.set('x-setscope-session', cookieSession.generation);
      options.credentials = 'same-origin';
    } else {
      headers.set('Authorization', `Bearer ${session.access_token}`);
      if (config?.rememberedSessionRoutes) options.credentials = 'omit';
    }
    try {
      let response = await fetch(url, { ...options, headers, signal: controller.signal });
      if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
      if (response.status === 401) {
        if (cookieSession) {
          endPrivateSession('expiry');
          throw staleSessionError();
        }
        const refreshed = await refreshSession();
        if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
        if (refreshed) {
          headers.set('Authorization', `Bearer ${session.access_token}`);
          response = await fetch(url, { ...options, headers, signal: controller.signal });
          if (!isCurrentIdentity(identity) || !isCurrentAuthOperation(operationGeneration)) throw staleSessionError();
          if (response.status === 401) {
            endPrivateSession('expiry', { broadcast: true, reload: true });
            throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
          }
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
    get user() { return recoveryPending ? null : user; },
    captureIdentity,
    isCurrentIdentity,
    markPrivateUiReady,
    refresh: refreshSession,
    authorizedFetch
  };
  setAuthTheme(localStorage.getItem(THEME_KEY) || 'light');
  $('#auth-theme-toggle').addEventListener('click', () => setAuthTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#auth-login-tab').addEventListener('click', () => setMode('login'));
  $('#auth-signup-tab').addEventListener('click', () => setMode('signup'));
  $('#login-form').addEventListener('submit', onLogin);
  $('#signup-form').addEventListener('submit', onSignup);
  $('#profile-logout-button')?.addEventListener('click', logout);
  $('#profile-recovery-button')?.addEventListener('click', event => sendAccountEmail('recovery', event.currentTarget, user?.email));
  $('#profile-verification-button')?.addEventListener('click', event => sendAccountEmail('verification', event.currentTarget, user?.email));
  $('#forgot-password-button')?.addEventListener('click', () => setMode('forgot'));
  $('#recovery-back-button')?.addEventListener('click', () => setMode('login'));
  $('#recovery-cancel-button')?.addEventListener('click', logout);
  $('#forgot-password-form')?.addEventListener('submit', event => {
    event.preventDefault();
    return sendAccountEmail('forgot', event.currentTarget.querySelector('[type=submit]'), String(new FormData(event.currentTarget).get('email') || '').trim());
  });
  $('#recovery-form')?.addEventListener('submit', onRecovery);
  function handleLocationCallback() {
    const callback = readAuthCallback();
    if (!callback) return false;
    endPrivateSession('auth-callback', { text: '' });
    if (!config?.configured) { authCallback = callback; return true; }
    const pending = consumeAuthCallback(callback);
    const operationGeneration = authOperationGeneration;
    void pending.catch(() => {
      if (isCurrentAuthOperation(operationGeneration)) endPrivateSession('invalid-callback', { text: 'ลิงก์ยืนยันไม่ถูกต้อง กรุณาขอลิงก์ใหม่' });
    });
    return true;
  }
  window.addEventListener('hashchange', handleLocationCallback);
  window.addEventListener('storage', event => {
    if (event.key === LOGOUT_PENDING_KEY && event.newValue === activeOwnerId && remembered) {
      endPrivateSession('remote-logout', { text: '' });
      return;
    }
    if (event.key !== AUTH_BOUNDARY_KEY || !event.newValue || !activeOwnerId) return;
    try {
      const boundary = JSON.parse(event.newValue);
      if (boundary?.ownerId === activeOwnerId) {
        if (['remembered-logout', 'remembered-switch'].includes(boundary.reason)) {
          if (remembered) void refreshSession();
        } else if (!remembered) endPrivateSession('remote-logout', { reload: true, text: '' });
      }
    } catch (_) {}
  });
  window.addEventListener('popstate', () => {
    if (handleLocationCallback()) return;
    if (document.body.classList.contains('authenticated')) showDashboard();
    else setMode(modeFromPath(), { updateUrl: false });
  });
  const isAuthCallback = Boolean(authCallback?.access_token);
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
        authCallback = null;
        document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = true; });
        showLogin('ระบบสมาชิกยังไม่ได้ตั้งค่าใน Render (SUPABASE_URL และ SUPABASE_ANON_KEY)', 'error'); return;
      }
      document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = false; });
      if (canRemember() && rememberDevice) {
        rememberDevice.disabled = false;
        rememberDevice.parentElement.hidden = false;
      }
      if (authCallback) {
        const callback = authCallback; authCallback = null;
        await consumeAuthCallback(callback); return;
      }
      const operationGeneration = authOperationGeneration;
      if (!session && config.rememberedSessionRoutes && window.navigator?.locks
        && !localStorage.getItem(LOGOUT_PENDING_KEY)) {
        const result = await restoreRemembered();
        if (!isCurrentAuthOperation(operationGeneration)) return;
        if (result) { acceptRemembered(result); return; }
      }
      if (!await openDashboardIfValid(operationGeneration) && isCurrentAuthOperation(operationGeneration)) showLogin();
    } catch (_) { authCallback = null; showLogin('เชื่อมต่อระบบสมาชิกไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ', 'error'); }
  })();
})();
