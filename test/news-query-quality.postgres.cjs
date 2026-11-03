'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fixtureRows, legacyGroups, OLD_POLICY } = require('./fixtures/news-query-quality.cjs');
const { createNewsArchiveService } = require('../server/news-archive-service');

test('shared-quality generation on isolated PostgreSQL 17', { skip: !process.env.SETSCOPE_QUERY_QUALITY_PG }, async t => {
  const { Pool } = require('pg');
  const config = JSON.parse(process.env.SETSCOPE_QUERY_QUALITY_PG);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'postgres');
  const database = 'setscope_quality_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ ...config, max: 1 });
  let db, rpcDb, created = false;
  try {
    assert.match((await admin.query('show server_version')).rows[0].server_version, /^17\./);
    await admin.query('create database ' + database); created = true;
    db = new Pool({ ...config, database, max: 2 });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) await admin.query('create role ' + role + ' nologin' + (role === 'service_role' ? ' bypassrls' : ''));
    }
    for (const file of ['supabase/news_archive.sql', 'supabase/news_archive_least_privilege.sql', 'supabase/migrations/20261027112037_news_archive_evidence.sql',
      'supabase/migrations/20261029131808_news_archive_query.sql', 'supabase/migrations/20261029154157_news_archive_query_safeupdate.sql']) await db.query(await fs.readFile(path.join(__dirname, '..', file), 'utf8'));
    const sourceRows = fixtureRows(), columns = Object.keys(sourceRows[0]).filter(key => key !== 'id');
    await db.query('insert into public.news_archive(' + columns.join(',') + ') select ' + columns.join(',') + ' from jsonb_populate_recordset(null::public.news_archive,$1::jsonb)', [JSON.stringify(sourceRows)]);
    rpcDb = new Pool({ ...config, database, max: 2, options: '-c role=service_role' });
    const signatures = {
      news_archive_query_reset: { p_policy: 'text' }, news_archive_query_work: { p_limit: 'integer' },
      news_archive_query_components: { p_fingerprints: 'text[]', p_aliases: 'text[]' },
      news_archive_query_commit: { p_source_revision: 'bigint', p_index_revision: 'bigint', p_policy: 'text', p_dirty: 'text[]', p_removed: 'text[]', p_groups: 'jsonb', p_rows: 'jsonb' },
      list_news_archive_query: { p_policy: 'text', p_page: 'integer', p_page_size: 'integer', p_sources: 'text[]', p_symbol: 'text', p_query: 'text', p_exclude: 'text[]', p_featured: 'integer', p_now: 'timestamptz', p_overlays: 'jsonb' }
    };
    const rpc = async (name, args) => {
      const signature = signatures[name]; assert.ok(signature, 'only test RPCs are callable');
      const fields = Object.entries(args).map(([key]) => {
        const type = signature[key]; assert.ok(type, 'only named arguments from the existing contract');
        const value = type === 'jsonb' ? "value->'" + key + "'" : type.endsWith('[]') ? "array(select jsonb_array_elements_text(value->'" + key + "'))" : "(value->>'" + key + "')::" + type;
        return key + '=>' + value;
      });
      const result = await rpcDb.query('with args as(select $1::jsonb value) select public.' + name + '(' + fields.join(',') + ') result from args', [JSON.stringify(args)]);
      return result.rows[0].result;
    };
    const rows = async () => (await db.query("select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]'::jsonb) value from public.news_archive a")).rows[0].value;
    const fetchImpl = async (value, init = {}) => {
      const url = new URL(value); assert.equal(url.origin, 'https://query-quality.invalid');
      if (url.pathname.startsWith('/rest/v1/rpc/')) return Response.json(await rpc(url.pathname.split('/').at(-1), JSON.parse(init.body)));
      assert.equal(url.pathname, '/rest/v1/news_archive'); assert.equal(init.method || 'GET', 'GET', 'original news are read-only');
      const all = (await rows()).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id);
      const [start, end] = String(init.headers.Range || '0-499').split('-').map(Number);
      return Response.json(all.slice(start, end + 1), { headers: { 'content-range': start + '-' + Math.max(start, Math.min(end, all.length - 1)) + '/' + all.length } });
    };
    const env = { SUPABASE_URL: 'https://query-quality.invalid', SUPABASE_SECRET_KEY: 'synthetic-query-key', SETSCOPE_NEWS_EVIDENCE: 'read', SETSCOPE_NEWS_ARCHIVE_QUERY: 'on' };
    const service = extra => createNewsArchiveService({ env: { ...env, ...extra }, fetchImpl });
    const listArgs = { p_policy: OLD_POLICY, p_page: 1, p_page_size: 2, p_sources: ['all'], p_symbol: '', p_query: '', p_exclude: [], p_featured: 0, p_now: new Date().toISOString(), p_overlays: [] };
    await rpc('news_archive_query_reset', { p_policy: OLD_POLICY });
    const work = await rpc('news_archive_query_work', { p_limit: 500 }), oldGroups = legacyGroups(work.rows);
    const membership = new Map(oldGroups.flatMap(group => group.fingerprints.map(key => [key, group.projection.group_key])));
    assert.equal((await rpc('news_archive_query_commit', { p_source_revision: work.sourceRevision, p_index_revision: work.indexRevision, p_policy: OLD_POLICY,
      p_dirty: work.fingerprints, p_removed: [], p_groups: oldGroups.map(group => group.projection), p_rows: work.rows.map(row => ({ fingerprint: row.fingerprint,
        group_key: membership.get(row.fingerprint), row_digest: row._query_digest, quality_status: 'VERIFIED' })) })).pending, 0);
    const before = JSON.stringify(await rows());
    const protectedState = async () => (await db.query("select jsonb_build_object('functions',(select jsonb_agg(jsonb_build_object('oid',oid,'name',proname,'acl',proacl,'definer',prosecdef,'config',proconfig) order by oid) from pg_proc where oid in('public.news_archive_query_commit(bigint,bigint,text,text[],text[],jsonb,jsonb)'::regprocedure,'public.news_archive_query_reset(text)'::regprocedure)), 'tables',(select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl,'rls',relrowsecurity,'force',relforcerowsecurity) order by relname) from pg_class where oid in('public.news_archive'::regclass,'public.news_archive_query_state'::regclass,'public.news_archive_query_groups'::regclass,'public.news_archive_query_rows'::regclass,'public.news_archive_query_dirty'::regclass))) value")).rows[0].value;
    const security = await protectedState();

    await t.test('old exact counts are inflated; new reads fail closed and cannot reset without the approved guard extension', async () => {
      const old = await rpc('list_news_archive_query', listArgs);
      assert.equal(old.matchingTotal, 25); assert.equal(old.total, 25); assert.equal(old.countExact, true);
      await assert.rejects(service().list({ pageSize: 2 }), /NEWS_QUERY_POLICY_NOT_READY/);
      await assert.rejects(service().list({ page: 999 }), /NEWS_QUERY_POLICY_NOT_READY/);
      await assert.rejects(service().refreshQueryIndex({ reset: true }), /NEWS_QUERY_POLICY_MISMATCH/);
      assert.equal(JSON.stringify(await rows()), before);
    });
    await t.test('migration preserves source bytes, table/RLS/grant state, function identities and the old derived index', async () => {
      const normalize = result => ({ ...result, groups: result.groups.slice().sort((a, b) => a.key.localeCompare(b.key)) });
      const oldIndex = normalize(await rpc('list_news_archive_query', listArgs));
      await db.query(await fs.readFile(path.join(__dirname, '../supabase/migrations/20261103035737_news_archive_query_quality_policy.sql'), 'utf8'));
      assert.deepEqual(await protectedState(), security);
      assert.deepEqual(normalize(await rpc('list_news_archive_query', listArgs)), oldIndex);
      await assert.rejects(service().refreshQueryIndex({ maxBatches: 1 }), /NEWS_QUERY_POLICY_MISMATCH/);
      await assert.rejects(rpc('news_archive_query_reset', { p_policy: 'news-query-3:read:metadata' }), /NEWS_QUERY_POLICY_MISMATCH/);
      assert.equal(JSON.stringify(await rows()), before);
      const permissions = (await db.query("select has_function_privilege('anon','public.news_archive_query_reset(text)','EXECUTE') anon, has_function_privilege('authenticated','public.news_archive_query_reset(text)','EXECUTE') authenticated,has_function_privilege('service_role','public.news_archive_query_reset(text)','EXECUTE') service")).rows[0];
      assert.deepEqual(permissions, { anon: false, authenticated: false, service: true });
    });
    await t.test('partial rebuild serves no stale data or false exact counts', async () => {
      assert.equal((await service().refreshQueryIndex({ reset: true, maxBatches: 1, batchSize: 2 })).pending, true);
      await assert.rejects(service().list(), /NEWS_QUERY_INDEX_NOT_READY/);
      await assert.rejects(rpc('list_news_archive_query', listArgs), /NEWS_QUERY_POLICY_NOT_READY/);
      assert.equal(JSON.stringify(await rows()), before);
    });
    await t.test('completed rebuild matches read-time oracle for pages, features, filters, counts and distinct stories', async () => {
      assert.equal((await service().refreshQueryIndex({ maxBatches: 30, batchSize: 2 })).pending, 0);
      const archive = service(), oracle = service({ SETSCOPE_NEWS_ARCHIVE_QUERY: 'off' });
      const samples = [{ page: 1, pageSize: 2, featuredCount: 2 }, { page: 2, pageSize: 2, featuredCount: 2 }, { page: 3, pageSize: 2, featuredCount: 2 },
        { source: 'investing' }, { source: 'infoquest' }, { source: 'investing,infoquest', symbol: 'PTT' }, { symbol: 'CPALL' }, { query: 'distinct-story-1' }, { query: 'same-headline' }];
      for (const options of samples) {
        const actual = await archive.list(options), expected = await oracle.list(options);
        assert.deepEqual(actual.items.map(item => item.url), expected.items.map(item => item.url));
        assert.deepEqual(actual.featured.map(item => item.url), expected.featured.map(item => item.url));
        for (const field of ['total', 'matchingTotal', 'countExact', 'page', 'pageSize']) assert.equal(actual[field], expected[field], field);
      }
      const result = await archive.list({ pageSize: 2, featuredCount: 2 });
      assert.equal(result.total, 4); assert.equal(result.matchingTotal, 6); assert.equal(result.rejected, 18);
      assert.equal(result.quarantined, 1); assert.equal(result.qualityFiltered, 19); assert.equal(result.deduplicated, 1);
      const keys = await rpc('list_news_archive_query', { ...listArgs, p_policy: 'news-query-2:read:metadata', p_featured: 2 });
      assert.equal(keys.pageKeys.length, 2); assert.equal(keys.featuredKeys.length, 2); assert.equal(new Set([...keys.pageKeys, ...keys.featuredKeys]).size, 4);
      const excluded = await archive.list({ excludeUrls: [result.items[0].url] }); assert.equal(excluded.total, 5);
      assert.equal((await service().list()).total, 6, 'restart retains the complete projection');
      assert.equal(JSON.stringify(await rows()), before);
    });
    await t.test('old policy remains available for separately approved rollback without changing news', async () => {
      await db.query('begin');
      try { await db.query('select public.news_archive_query_reset($1)', [OLD_POLICY]); } finally { await db.query('rollback'); }
      assert.equal((await service().list()).total, 6); assert.equal(JSON.stringify(await rows()), before);
    });
  } finally {
    await rpcDb?.end(); await db?.end();
    if (created) { assert.match(database, /^setscope_quality_[a-f0-9]{32}$/); await admin.query('drop database ' + database + ' with(force)'); }
    await admin.end();
  }
});
