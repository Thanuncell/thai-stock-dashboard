'use strict';

function createAuthService({ env = process.env, fetchImpl = globalThis.fetch, send }) {
  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);

  function configPayload() {
    return {
      configured,
      url: configured ? env.SUPABASE_URL.replace(/\/$/, '') : null,
      anonKey: configured ? env.SUPABASE_ANON_KEY : null
    };
  }

  async function requireUser(req, res) {
    if (!configured) {
      send(res, 503, { error: 'ระบบสมาชิกยังไม่ได้ตั้งค่า' });
      return false;
    }
    const token = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) {
      send(res, 401, { error: 'กรุณาเข้าสู่ระบบ' });
      return false;
    }
    let response;
    try {
      response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
        headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(7000)
      });
    } catch (_) {
      send(res, 503, { error: 'ระบบสมาชิกตอบสนองช้า กรุณาลองใหม่อีกครั้ง', retryable: true });
      return false;
    }
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) {
      send(res, 401, { error: 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง' });
      return false;
    }
    send(res, 503, { error: 'ระบบสมาชิกไม่พร้อมชั่วคราว กรุณาลองใหม่อีกครั้ง', retryable: true });
    return false;
  }

  return { configured, configPayload, requireUser };
}

module.exports = { createAuthService };
