'use strict';

const { randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');

const LIFETIME = 168 * 60 * 60 * 1000;
const REFRESH_LEASE = 25_000;
const COOKIE = '__Host-setscope-remember';
const SESSION_HEADER = 'x-setscope-session';
const cookieFlags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const id = () => randomBytes(32).toString('base64url');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class AuthFailure extends Error {
  constructor(status) {
    super('Authentication failed');
    this.status = status;
  }
}

// Call only after the provider authenticated this exact JWT via /auth/v1/user.
function verifiedSessionClaims(token, userId, now) {
  let claims;
  try {
    const parts = token.split('.');
    if (parts.length === 3) claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch (_) {}
  if (claims?.sub !== userId || typeof claims?.session_id !== 'string'
    || !uuid.test(claims.session_id) || !Number.isSafeInteger(claims.exp) || claims.exp <= now / 1000) {
    throw new AuthFailure(401);
  }
  return { providerSessionId: claims.session_id.toLowerCase(), accessExpiresAt: claims.exp * 1000 };
}

// Offline contract for a restrictive Data API policy. The caller supplies verified
// claims and a successful registry lookup (null means legacy, not a failed read).
function allowsWatchlistAccess({ userId, rowOwnerId, providerSessionId, remembered, now }) {
  return Boolean(userId && userId === rowOwnerId && typeof providerSessionId === 'string'
    && uuid.test(providerSessionId) && (remembered === null || (
      remembered?.providerSessionId === providerSessionId.toLowerCase()
      && remembered.ownerId === userId && remembered.revokedAt === null && now < remembered.expiresAt
    )));
}

function cookieDigest(req) {
  const entries = (req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE}=`));
  if (!entries.length) return null;
  const value = entries[0].slice(COOKIE.length + 1);
  if (entries.length !== 1 || !/^[\w-]{43}$/.test(value)) throw new AuthFailure(401);
  return createHash('sha256').update(value).digest('hex');
}

// Store operations are atomic across workers. Reads return snapshots. issue
// inserts a unique provider session ID and optionally retires its predecessor
// in one operation. Retain revoked/expired provider IDs for replay protection.
// An unavailable lookup must throw, never report a missing provider session.
// acquireRefresh/finishRefresh compare version and lease, reject expired or
// revoked records, and never extend expiresAt. revoke wins over a pending lease.
function createRememberedSessions({ store, key, origin, allowIssue = false, dataApiGuardVerified = false,
  allowRestoreWhenOff = false, mayIssue = () => true, now = Date.now }, provider) {
  if (!store || !Buffer.isBuffer(key) || key.length !== 32 || !/^https:\/\/[^/]+$/.test(origin)
    || new URL(origin).origin !== origin) throw new Error('Invalid remembered session dependencies');
  const canIssue = allowIssue === true && dataApiGuardVerified === true;
  const checkedAt = (record, at = now()) => Math.max(at, record.checkedAt ?? at);
  const active = (record, at = now()) => record?.revokedAt === null && checkedAt(record, at) < record.expiresAt;
  const metadata = record => ({
    user: record.user, generation: record.generation, remainingMs: record.expiresAt - checkedAt(record)
  });
  const userSummary = ({ id: userId, email, email_confirmed_at }) => ({ id: userId, email, email_confirmed_at });

  function seal(tokens, digest) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(digest));
    const content = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64url');
  }

  function open(record) {
    const bytes = Buffer.from(record.encrypted, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(record.digest));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
  }

  function checkBrowser(req) {
    const requestOrigin = req.headers.origin;
    if (req.headers['x-setscope-request'] !== '1'
      || (requestOrigin !== origin && (req.method !== 'GET' || requestOrigin !== undefined))
      || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      throw new AuthFailure(403);
    }
  }

  function checkGeneration(req, record) {
    if (!record || req.headers[SESSION_HEADER] !== record.generation) throw new AuthFailure(401);
  }

  async function verifyPair(payload) {
    if (typeof payload?.access_token !== 'string' || typeof payload.refresh_token !== 'string'
      || !payload.access_token || !payload.refresh_token) throw new AuthFailure(401);
    const user = userSummary(await provider.verify(payload.access_token));
    const claims = verifiedSessionClaims(payload.access_token, user.id, now());
    return { ...claims, user, tokens: { access: payload.access_token, refresh: payload.refresh_token } };
  }

  async function login(req, body) {
    if (!canIssue) throw new AuthFailure(404);
    if (body?.rememberDevice !== true || typeof body.email !== 'string' || typeof body.password !== 'string'
      || !body.email || !body.password) throw new AuthFailure(400);
    const previousDigest = cookieDigest(req);
    const previous = previousDigest ? await store.find(previousDigest) : null;
    if (active(previous)) checkGeneration(req, previous);
    const pair = await verifyPair(await provider.login({ email: body.email, password: body.password }));
    // Only a provider-verified immutable identity can enter a restricted cohort.
    // The submitted email and user-editable metadata are not authorization.
    if (!await mayIssue(pair.user)) {
      try { await provider.logout(pair.tokens.access); } catch (_) {}
      throw new AuthFailure(403);
    }
    const handle = id();
    const digest = createHash('sha256').update(handle).digest('hex');
    const issuedAt = now();
    const record = {
      digest, generation: id(), providerSessionId: pair.providerSessionId, ownerId: pair.user.id,
      user: pair.user, issuedAt, expiresAt: issuedAt + LIFETIME, accessExpiresAt: pair.accessExpiresAt,
      encrypted: seal(pair.tokens, digest), revokedAt: null, version: 0, lease: null
    };
    const predecessor = active(previous, issuedAt) ? previous : null;
    if (!await store.issue(record, predecessor?.digest ?? null)) throw new AuthFailure(409);
    if (predecessor) {
      try { await provider.logout(open(predecessor).access); } catch (_) {}
    }
    return { body: metadata(record), cookie: `${COOKIE}=${handle}; ${cookieFlags}; Max-Age=${LIFETIME / 1000}` };
  }

  async function current(digest) {
    if (!digest) throw new AuthFailure(401);
    const record = await store.find(digest);
    if (!active(record)) throw new AuthFailure(401);
    if (record.lease?.until <= checkedAt(record)) {
      await store.revoke(digest, now(), record.lease.id);
      throw new AuthFailure(401);
    }
    return record;
  }

  async function rotate(record) {
    const at = now();
    const lease = { id: id(), until: at + REFRESH_LEASE };
    if (!await store.acquireRefresh(record.digest, record.version, lease, at)) throw new AuthFailure(503);
    try {
      const pair = await verifyPair(await provider.refresh(open(record).refresh));
      if (pair.providerSessionId !== record.providerSessionId || pair.user.id !== record.ownerId) throw new AuthFailure(401);
      const update = { encrypted: seal(pair.tokens, record.digest), accessExpiresAt: pair.accessExpiresAt, user: pair.user };
      if (!await store.finishRefresh(record.digest, record.version, lease.id, update, now())) throw new AuthFailure(401);
    } catch (error) {
      await store.revoke(record.digest, now(), lease.id);
      throw error;
    }
    return current(record.digest);
  }

  async function authenticate(req, { restore = false } = {}) {
    checkBrowser(req);
    if (req.headers.authorization) throw new AuthFailure(401);
    if (!canIssue && !(allowRestoreWhenOff === true && dataApiGuardVerified === true)) throw new AuthFailure(401);
    let record = await current(cookieDigest(req));
    if (!restore) checkGeneration(req, record);
    if (record.accessExpiresAt <= now() + 10_000) record = await rotate(record);
    const token = open(record).access;
    let user;
    try {
      user = userSummary(await provider.verify(token));
      if (user.id !== record.ownerId
        || verifiedSessionClaims(token, user.id, now()).providerSessionId !== record.providerSessionId) throw new AuthFailure(401);
    } catch (error) {
      if (error instanceof AuthFailure && error.status === 401) await store.revoke(record.digest, now());
      throw error;
    }
    const latest = await current(record.digest);
    if (latest.version !== record.version) throw new AuthFailure(503);
    return { user, authorization: `Bearer ${token}`, body: metadata(latest) };
  }

  async function endpoint(req, action, readBody) {
    if (req.method !== 'POST') throw new AuthFailure(405);
    checkBrowser(req);
    if (req.headers.authorization) throw new AuthFailure(401);
    if (action === 'login') {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new AuthFailure(415);
      let body;
      try { body = await readBody(); } catch (_) { throw new AuthFailure(400); }
      return login(req, body);
    }
    if (action === 'logout') {
      const digest = cookieDigest(req);
      if (!digest) throw new AuthFailure(401);
      const record = await store.find(digest);
      checkGeneration(req, record);
      if (record.revokedAt === null) {
        const revoked = await store.revoke(digest, now());
        if (!revoked && (await store.find(digest))?.revokedAt == null) throw new AuthFailure(503);
        // The application revocation remains authoritative if upstream is unavailable.
        try { await provider.logout(open(record).access); } catch (_) {}
      }
      return { body: { revoked: true }, cookie: `${COOKIE}=; ${cookieFlags}; Max-Age=0` };
    }
    if (action === 'restore' || action === 'refresh') return authenticate(req, { restore: action === 'restore' });
    throw new AuthFailure(404);
  }

  async function rejectRememberedBearer(token, userId) {
    const { providerSessionId } = verifiedSessionClaims(token, userId, now());
    if (await store.hasProviderSession(providerSessionId)) throw new AuthFailure(401);
  }

  return { canIssue, hasCookie: req => Boolean(cookieDigest(req)), endpoint, authenticate, rejectRememberedBearer };
}

module.exports = { AuthFailure, createRememberedSessions, allowsWatchlistAccess };
