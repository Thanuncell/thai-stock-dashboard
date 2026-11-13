'use strict';

const { createAuthService } = require('./auth-service');
const { createPostgresRememberedSessionStore } = require('./remembered-session-postgres');
const { checkServerIdentity } = require('node:tls');

const PROJECT = 'nrlznztqtresaycbxuck';
const ORIGIN = 'https://setscope.onrender.com';
const ROLE = 'setscope_v165_bff';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
class ProductionRuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new ProductionRuntimeError(code); };

// No connection strings, inherited PG options, mock fallback, key generation or
// Dev-vault reader. This factory is activated only by the normal Node bootstrap.
async function createProductionRememberedRuntime({ env, send, fetchImpl = globalThis.fetch,
  Pool, now = Date.now }) {
  const publicIssue = env.SETSCOPE_REMEMBER_MODE === 'public';
  if (env.NODE_ENV !== 'production' || env.SETSCOPE_REMEMBER_REQUIRED !== '1'
    || !['guard', 'cohort', 'public'].includes(env.SETSCOPE_REMEMBER_MODE)
    || env.SUPABASE_URL !== `https://${PROJECT}.supabase.co`
    || env.SETSCOPE_REMEMBER_PROJECT !== PROJECT || env.SETSCOPE_REMEMBER_ORIGIN !== ORIGIN) {
    refuse('PRODUCTION_REMEMBER_TARGET_REJECTED');
  }
  // Public anon/publishable key only; never send a service-role key as apikey.
  const apiKey = env.SUPABASE_ANON_KEY;
  let publicKey = typeof apiKey === 'string' && apiKey.startsWith('sb_publishable_');
  try {
    const claims = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url'));
    publicKey ||= claims.role === 'anon' && claims.ref === PROJECT;
  } catch (_) {}
  if (!publicKey) refuse('PRODUCTION_PUBLIC_KEY_REQUIRED');
  if (publicIssue && env.SETSCOPE_REMEMBER_GUARDS_READY !== '1') {
    refuse('PRODUCTION_PUBLIC_PREREQUISITES_REQUIRED');
  }
  const cohort = new Set((env.SETSCOPE_REMEMBER_COHORT_IDS || '').split(',').filter(Boolean).map(x => x.toLowerCase()));
  if ([...cohort].some(x => !uuid.test(x)) || (env.SETSCOPE_REMEMBER_MODE === 'cohort'
    && (!cohort.size || cohort.size > 20 || env.SETSCOPE_REMEMBER_GUARDS_READY !== '1'))) {
    refuse('PRODUCTION_COHORT_PREREQUISITES_REQUIRED');
  }
  const keyText = env.SETSCOPE_REMEMBER_ENCRYPTION_KEY || '';
  const key = Buffer.from(keyText, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyText) refuse('PRODUCTION_PERSISTED_KEY_REQUIRED');
  const host = env.SETSCOPE_REMEMBER_DB_HOST;
  const direct = host === `db.${PROJECT}.supabase.co`;
  const pooled = /^aws-\d+-ap-southeast-1\.pooler\.supabase\.com$/.test(host || '');
  const user = direct ? ROLE : `${ROLE}.${PROJECT}`;
  if ((!direct && !pooled) || env.SETSCOPE_REMEMBER_DB_USER !== user
    || env.SETSCOPE_REMEMBER_DB_PORT !== '5432' || !env.SETSCOPE_REMEMBER_DB_PASSWORD
    || !env.SETSCOPE_REMEMBER_DB_CA?.includes('-----BEGIN CERTIFICATE-----')) {
    refuse('PRODUCTION_DATABASE_CONFIGURATION_REQUIRED');
  }
  Pool ||= require('pg').Pool;
  const pool = new Pool({ host, port: 5432, user, password: env.SETSCOPE_REMEMBER_DB_PASSWORD,
    database: 'postgres', ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: env.SETSCOPE_REMEMBER_DB_CA },
    max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 7000,
    options: '-c search_path=pg_catalog', application_name: 'setscope_v165_bff' });
  // Never log error objects (which can contain credentials or certificate data).
  pool.on('error', () => {});
  try {
    const client = await pool.connect();
    try {
      const stream = client.connection?.stream;
      if (stream?.encrypted !== true || stream.authorized !== true
        || !['TLSv1.2', 'TLSv1.3'].includes(stream.getProtocol?.())
        || checkServerIdentity(host, stream.getPeerCertificate?.() || {})) {
        refuse('PRODUCTION_CERTIFICATE_REJECTED');
      }
      const { rows: [s] } = await client.query(`select current_user as role,
        current_database() as database, r.rolcanlogin as login, r.rolsuper as superuser,
        r.rolbypassrls as bypass, r.rolcreaterole as create_role, r.rolcreatedb as create_db,
        r.rolreplication as replication, r.rolconnlimit as connection_limit,
        (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as ssl,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','SELECT') as store_read,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','INSERT') as store_insert,
        has_column_privilege(current_user,'setscope_private.remembered_sessions','encrypted','UPDATE') as rotate,
        has_column_privilege(current_user,'setscope_private.remembered_sessions','expires_at_ms','UPDATE') as extend,
        has_column_privilege(current_user,'setscope_private.remembered_sessions','provider_session_id','UPDATE') as remap,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','DELETE') as store_delete,
        has_table_privilege(current_user,'setscope_private.remembered_sessions','TRUNCATE') as store_truncate,
        has_table_privilege(current_user,'public.user_watchlists','SELECT') as member_data,
        has_schema_privilege('authenticated','setscope_private','USAGE')
          or has_schema_privilege('anon','setscope_private','USAGE') as api_private,
        has_table_privilege('authenticated','public.user_watchlists','TRUNCATE')
          or has_table_privilege('anon','public.user_watchlists','TRUNCATE') as api_truncate,
        (select relrowsecurity from pg_class where oid='public.user_watchlists'::regclass) as watchlist_rls,
        (select relrowsecurity from pg_class where oid='setscope_private.remembered_sessions'::regclass) as store_rls,
        exists(select 1 from pg_policy where polrelid='public.user_watchlists'::regclass
          and polname='remembered_session_guard' and not polpermissive and polcmd='*'
          and pg_get_expr(polqual,polrelid) like '%watchlist_session_allowed%'
          and pg_get_expr(polwithcheck,polrelid) like '%watchlist_session_allowed%') as guard,
        exists(select 1 from pg_trigger where tgrelid='setscope_private.remembered_sessions'::regclass
          and tgname='keep_session_revoked' and tgenabled='O') as tombstone_guard,
        not pg_has_role(current_user,'setscope_session_guard','USAGE') as lookup_role_separate
        from pg_roles r where r.rolname=current_user`);
      if (!s || s.role !== ROLE || s.database !== 'postgres' || !s.login || s.superuser || s.bypass
        || s.create_role || s.create_db || s.replication || s.connection_limit < 4 || s.connection_limit > 8
        // pg_stat_ssl describes the pooler's backend leg, not this Node TLS socket.
        || (direct && !s.ssl) || !s.store_read || !s.store_insert || !s.rotate || s.extend || s.remap
        || s.store_delete || s.store_truncate || s.member_data || s.api_private || s.api_truncate
        || !s.guard || !s.watchlist_rls || !s.store_rls || !s.tombstone_guard || !s.lookup_role_separate) {
        refuse('PRODUCTION_DATABASE_SECURITY_REJECTED');
      }
    } finally { client.release(); }

    const auth = createAuthService({ env, send, fetchImpl, remembered: {
      store: createPostgresRememberedSessionStore(pool), key, origin: ORIGIN, now,
      allowIssue: publicIssue || env.SETSCOPE_REMEMBER_MODE === 'cohort', dataApiGuardVerified: true,
      allowRestoreWhenOff: true, cohortPreviewOnly: !publicIssue,
      mayIssue: verifiedUser => publicIssue || cohort.has(verifiedUser.id.toLowerCase())
    } });
    return { auth, close: () => pool.end() };
  } catch (error) {
    await pool.end().catch(() => {});
    if (error instanceof ProductionRuntimeError) throw error;
    refuse('PRODUCTION_DATABASE_NOT_READY');
  }
}

module.exports = { createProductionRememberedRuntime, ProductionRuntimeError };
