'use strict';

const { createAuthService } = require('./auth-service');
const { createPostgresRememberedSessionStore } = require('./remembered-session-postgres');

const DEV_PROJECT = 'mlqbmtycvlbfbszyrsqd';
const DEV_URL = `https://${DEV_PROJECT}.supabase.co`;
const DB_ROLE = 'setscope_v165_dev_bff';
class DevRuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new DevRuntimeError(code); };

// This entry point is never imported by the normal production bootstrap.
async function createDevRememberedRuntime({ config, secrets, send, Pool, fetchImpl = globalThis.fetch, now = Date.now }) {
  if (config?.devTestsOnly !== true || config.nodeEnv === 'production'
    || config.projectId !== DEV_PROJECT || config.supabaseUrl !== DEV_URL) refuse('DEV_TARGET_REQUIRED');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.origin !== config.origin) refuse('DEV_LOOPBACK_HTTPS_REQUIRED');
  const emails = new Set(config.testEmails || []);
  if (!emails.size || [...emails].some(email => !/^v165-[a-z0-9-]+@example\.test$/.test(email))) refuse('DEV_SYNTHETIC_ACCOUNT_ALLOWLIST_REQUIRED');
  if (typeof config.publishableKey !== 'string' || !config.publishableKey.startsWith('sb_publishable_')) refuse('DEV_PUBLIC_KEY_REQUIRED');
  const db = secrets?.database;
  const direct = db?.host === `db.${DEV_PROJECT}.supabase.co` && db?.user === DB_ROLE;
  const pooled = /^aws-\d+-ap-southeast-1\.pooler\.supabase\.com$/.test(db?.host || '')
    && db?.user === `${DB_ROLE}.${DEV_PROJECT}`;
  if ((!direct && !pooled) || db?.port !== 5432 || db?.database !== 'postgres'
    || typeof db?.password !== 'string' || !db.password) refuse('DEV_DATABASE_CREDENTIAL_REQUIRED');
  const key = Buffer.from(secrets.encryptionKey || '', 'base64');
  if (key.length !== 32) refuse('DEV_ENCRYPTION_KEY_REQUIRED');
  const pool = new Pool({
    host: db.host, port: db.port, user: db.user, password: db.password, database: db.database,
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(db.ca ? { ca: db.ca } : {}) },
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    statement_timeout: 7000, options: '-c search_path=pg_catalog', application_name: 'setscope_v165_dev_bff'
  });
  // Idle connection failures must not print provider/connection objects.
  pool.on('error', () => {});
  try {
    const client = await pool.connect();
    try {
      const { rows: [state] } = await client.query(`select current_user as role, r.rolcanlogin as login,
        r.rolsuper as superuser,r.rolbypassrls as bypass,r.rolcreaterole as create_role,
        r.rolcreatedb as create_db,r.rolreplication as replication,
        (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as ssl,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','SELECT') as store_read,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','INSERT') as store_insert,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','DELETE') as store_delete,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','TRUNCATE') as store_truncate,
        has_column_privilege(current_user,'setscope_private.remembered_sessions','expires_at_ms','UPDATE') as extend,
        exists(select 1 from pg_policy where polrelid='public.user_watchlists'::regclass
          and polname='remembered_session_guard' and not polpermissive and polcmd='*') as guard,
        (select relrowsecurity from pg_class where oid='public.user_watchlists'::regclass) as watchlist_rls,
        has_schema_privilege('authenticated','setscope_private','USAGE') as api_private
        from pg_roles r where r.rolname=current_user`);
      if (state?.role !== DB_ROLE || !state.login || state.superuser || state.bypass || state.create_role
        || state.create_db || state.replication || !state.ssl || !state.store_read || !state.store_insert
        || state.store_delete || state.store_truncate || state.extend || !state.guard || !state.watchlist_rls
        || state.api_private) refuse('DEV_DATABASE_PRIVILEGES_REJECTED');
      if (client.connection?.stream?.authorized !== true) refuse('DEV_DATABASE_CERTIFICATE_REJECTED');
    } finally { client.release(); }

    const scopedFetch = async (input, init = {}) => {
      const url = new URL(input);
      if (url.origin !== DEV_URL || !url.pathname.startsWith('/auth/v1/')) refuse('DEV_UPSTREAM_REJECTED');
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        let body; try { body = JSON.parse(init.body); } catch (_) {}
        if (!emails.has(body?.email)) return Response.json({ error: 'Dev test account required' }, { status: 403 });
      }
      const response = await fetchImpl(input, init);
      if (url.pathname === '/auth/v1/user' && response.ok) {
        const user = await response.clone().json().catch(() => null);
        if (!emails.has(user?.email)) return Response.json({ error: 'Dev test account required' }, { status: 403 });
      }
      return response;
    };
    const auth = createAuthService({
      env: { SUPABASE_URL: DEV_URL, SUPABASE_ANON_KEY: config.publishableKey }, send, fetchImpl: scopedFetch,
      remembered: {
        store: createPostgresRememberedSessionStore(pool), key, origin: config.origin, now,
        allowIssue: config.enableRemember === true,
        dataApiGuardVerified: config.guardVerifiedForDevTests === true
      }
    });
    return { auth, pool, close: () => pool.end() };
  } catch (error) {
    await pool.end().catch(() => {});
    if (error instanceof DevRuntimeError) throw error;
    refuse('DEV_DATABASE_NOT_READY');
  }
}

module.exports = { createDevRememberedRuntime, DevRuntimeError, DEV_PROJECT, DEV_URL, DB_ROLE };
