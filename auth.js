(() => {
  const STORAGE_KEY = 'setscope-auth-session-v1';
  let config = null;
  let session = readSession();
  let user = null;
  let refreshTimer;
  const $ = selector => document.querySelector(selector);
  const message = (text, type = '') => { const box = $('#auth-message'); box.textContent = text; box.className = `auth-message ${type}`.trim(); };
  function readSession() { try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; } }
  function saveSession(value) { session = value; if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); else sessionStorage.removeItem(STORAGE_KEY); }
  function sessionFrom(payload) { return { ...payload, expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000 }; }
  async function authRequest(path, options = {}) {
    const response = await fetch(`${config.url}/auth/v1/${path}`, { ...options, headers: { apikey: config.anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || payload.error || 'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง');
    return payload;
  }
  async function refreshSession() {
    if (!config?.configured || !session?.refresh_token) return false;
    try { const refreshed = await authRequest('token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) }); saveSession(sessionFrom(refreshed)); scheduleRefresh(); return true; }
    catch (_) { saveSession(null); return false; }
  }
  async function ensureFresh() {
    if (!session?.access_token) return false;
    if (Number(session.expires_at) < Date.now() + 60_000 && !await refreshSession()) return false;
    return true;
  }
  async function validateSession() {
    if (!await ensureFresh()) return null;
    try { user = await authRequest('user', { headers: { Authorization: `Bearer ${session.access_token}` } }); return user; }
    catch (_) { saveSession(null); return null; }
  }
  function showDashboard() {
    document.body.classList.add('authenticated');
    $('#auth-gate').hidden = true;
    $('#app-shell').setAttribute('aria-hidden', 'false');
    const email = user?.email || '';
    const avatar = $('#user-avatar'); if (avatar) { avatar.textContent = email.slice(0, 1).toUpperCase() || 'ก'; avatar.title = email; }
    message('');
    window.dispatchEvent(new CustomEvent('setscope:authenticated', { detail: { email } }));
  }
  function showLogin(text = '', type = '') {
    document.body.classList.remove('authenticated');
    $('#auth-gate').hidden = false;
    $('#app-shell')?.setAttribute('aria-hidden', 'true');
    message(text, type);
  }
  function setMode(mode) {
    const signup = mode === 'signup';
    $('#login-form').hidden = signup; $('#signup-form').hidden = !signup;
    $('#auth-login-tab').classList.toggle('selected', !signup); $('#auth-signup-tab').classList.toggle('selected', signup);
    $('#auth-login-tab').setAttribute('aria-selected', String(!signup)); $('#auth-signup-tab').setAttribute('aria-selected', String(signup));
    $('#auth-title').textContent = signup ? 'สร้างบัญชี SETscope' : 'เข้าสู่ระบบ SETscope';
    message('');
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (!session?.expires_at) return;
    refreshTimer = setTimeout(async () => { if (!await refreshSession()) showLogin('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง'); }, Math.max(15_000, Number(session.expires_at) - Date.now() - 60_000));
  }
  async function openDashboardIfValid() { const valid = await validateSession(); if (!valid) return false; scheduleRefresh(); showDashboard(); return true; }
  async function onLogin(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const submit = event.currentTarget.querySelector('[type=submit]');
    submit.disabled = true; message('กำลังตรวจสอบบัญชี…');
    try { const result = await authRequest('token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) }); saveSession(sessionFrom(result)); user = result.user || await authRequest('user', { headers: { Authorization: `Bearer ${session.access_token}` } }); scheduleRefresh(); showDashboard(); }
    catch (error) { message(error.message, 'error'); }
    finally { submit.disabled = false; }
  }
  async function onSignup(event) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get('password') || ''); const submit = event.currentTarget.querySelector('[type=submit]');
    if (password !== form.get('confirmPassword')) { message('รหัสผ่านที่กรอกไม่ตรงกัน', 'error'); return; }
    submit.disabled = true; message('กำลังสร้างบัญชี…');
    try {
      const result = await authRequest(`signup?redirect_to=${encodeURIComponent(window.location.origin)}`, { method: 'POST', body: JSON.stringify({ email: form.get('email'), password, data: { terms_accepted_at: new Date().toISOString(), terms_version: '2026-10-13' } }) });
      if (result.access_token) { saveSession(sessionFrom(result)); user = result.user || await authRequest('user', { headers: { Authorization: `Bearer ${session.access_token}` } }); scheduleRefresh(); showDashboard(); }
      else { event.currentTarget.reset(); setMode('login'); message('สมัครสมาชิกแล้ว กรุณากดยืนยันจากอีเมลก่อน แล้วกลับมาเข้าสู่ระบบ', 'success'); }
    } catch (error) { message(error.message, 'error'); }
    finally { submit.disabled = false; }
  }
  async function logout() {
    try { if (await ensureFresh()) await authRequest('logout', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } }); } catch (_) {}
    clearTimeout(refreshTimer); saveSession(null); user = null; window.location.reload();
  }
  async function authorizedFetch(url, options = {}) {
    if (!await ensureFresh()) { const wasAuthenticated = document.body.classList.contains('authenticated'); saveSession(null); showLogin('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง'); if (wasAuthenticated) window.location.reload(); throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง'); }
    const headers = new Headers(options.headers || {}); headers.set('Authorization', `Bearer ${session.access_token}`);
    let response = await fetch(url, { ...options, headers });
    if (response.status === 401) { if (await refreshSession()) { headers.set('Authorization', `Bearer ${session.access_token}`); response = await fetch(url, { ...options, headers }); } else { saveSession(null); window.location.reload(); } }
    return response;
  }
  window.setscopeAuth = { get accessToken() { return session?.access_token || ''; }, get user() { return user; }, refresh: refreshSession, authorizedFetch };
  $('#auth-login-tab').addEventListener('click', () => setMode('login'));
  $('#auth-signup-tab').addEventListener('click', () => setMode('signup'));
  $('#login-form').addEventListener('submit', onLogin);
  $('#signup-form').addEventListener('submit', onSignup);
  $('#logout-button').addEventListener('click', logout);

  (async () => {
    try {
      const response = await fetch('/api/auth-config', { cache: 'no-store' }); config = await response.json();
      if (!config.configured) {
        document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = true; });
        message('ระบบสมาชิกยังไม่ได้ตั้งค่าใน Render (SUPABASE_URL และ SUPABASE_ANON_KEY)', 'error'); return;
      }
      document.querySelectorAll('.auth-submit').forEach(button => { button.disabled = false; });
      if (location.hash.includes('access_token=')) {
        const params = new URLSearchParams(location.hash.slice(1));
        if (params.get('access_token')) { saveSession(sessionFrom({ access_token: params.get('access_token'), refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') })); history.replaceState(null, '', location.pathname + location.search); }
      }
      if (!await openDashboardIfValid()) showLogin();
    } catch (_) { message('เชื่อมต่อระบบสมาชิกไม่สำเร็จ กรุณารีเฟรชหน้าเว็บ', 'error'); }
  })();
})();
