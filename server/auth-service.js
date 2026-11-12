'use strict';

const { AuthFailure, createRememberedSessions } = require('./remembered-session');

function createAuthService({ env = process.env, fetchImpl = globalThis.fetch, send, remembered }) {
  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
  const sessions = remembered && createRememberedSessions(remembered, {
    login: credentials => requestProvider('token?grant_type=password', { body: credentials }),
    refresh: refresh => requestProvider('token?grant_type=refresh_token', { body: { refresh_token: refresh } }),
    logout: token => requestProvider('logout?scope=local', { token, method: 'POST' }),
    verify: verifyUser
  });

  function configPayload() {
    return {
      configured,
      url: configured ? env.SUPABASE_URL.replace(/\/$/, '') : null,
      anonKey: configured ? env.SUPABASE_ANON_KEY : null,
      ...(configured && sessions?.canIssue ? { rememberDevice: true } : {}),
      ...(configured && sessions ? { rememberedSessionRoutes: true } : {})
    };
  }

  async function requestProvider(path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
    let response;
    try {
      response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/${path}`, {
        method,
        headers: {
          apikey: env.SUPABASE_ANON_KEY,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(7000)
      });
    } catch (_) {
      throw new AuthFailure(503);
    }
    if (!response.ok) {
      const denied = response.status === 401 || response.status === 403
        || (response.status === 400 && path.startsWith('token?'));
      throw new AuthFailure(denied ? 401 : 503);
    }
    if (method === 'POST' && path.startsWith('logout?')) return null;
    try { return await response.json(); } catch (_) { throw new AuthFailure(503); }
  }

  async function verifyUser(token) {
    const user = await requestProvider('user', { token });
    if (!user || typeof user.id !== 'string' || !user.id.trim() || user.id !== user.id.trim() || user.id.length > 128) {
      throw new AuthFailure(503);
    }
    return user;
  }

  function reject(res, error) {
    const status = error instanceof AuthFailure ? error.status : 503;
    if (status === 401) return send(res, 401, { error: 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง' });
    return send(res, status, status === 503
      ? { error: 'ระบบสมาชิกไม่พร้อมชั่วคราว กรุณาลองใหม่อีกครั้ง', retryable: true }
      : { error: 'คำขอเข้าสู่ระบบไม่สำเร็จ' });
  }

  async function authorize(req, res) {
    if (!configured) {
      send(res, 503, { error: 'ระบบสมาชิกยังไม่ได้ตั้งค่า' });
      return false;
    }
    try {
      if (sessions?.hasCookie(req)) return await sessions.authenticate(req);
      const authorization = req.headers.authorization || '';
      const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) {
        send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
        return false;
      }
      const user = await verifyUser(token);
      if (sessions) await sessions.rejectRememberedBearer(token, user.id);
      return { user, authorization };
    } catch (error) {
      reject(res, error);
      return false;
    }
  }

  async function handleSession(req, res, action, readBody) {
    if (!sessions) return send(res, 404, { error: 'ไม่พบเส้นทาง' });
    if (!configured) return reject(res, new AuthFailure(503));
    try {
      const result = await sessions.endpoint(req, action, readBody);
      return send(res, 200, result.body, result.cookie ? { 'set-cookie': result.cookie } : {});
    } catch (error) { return reject(res, error); }
  }

  return { configured, configPayload, authorize, handleSession };
}

module.exports = { createAuthService };
