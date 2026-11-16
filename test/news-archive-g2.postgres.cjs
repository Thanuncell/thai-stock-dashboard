'use strict';
// Explicit local G2 verification. Uses existing SQL/RPCs; no hosted credentials.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), Module = require('node:module');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { createNewsArchiveService } = require('../server/news-archive-service');
const { createMemoryCache, PROVIDER_POLICIES } = require('../server/reliability');
const { fixtureRows } = require('./fixtures/news-query-quality.cjs');
const { article } = require('./fixtures/news-evidence.cjs');
const repo = path.join(__dirname, '..');

test('G2 localhost PostgreSQL 17 bootstrap, parity and comparable transfer measurements', {
  skip: !process.env.SETSCOPE_WS7_PG, timeout: 180000
}, async t => {
  const { Pool } = require('pg'), config = JSON.parse(process.env.SETSCOPE_WS7_PG);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'postgres');
  const admin = new Pool({ ...config, max: 1 }), database = 'setscope_g2_' + randomUUID().replaceAll('-', '');
  let db, http;
  const metrics = [], now = Date.now();
  let paginationParity = false, retainedParity = false;
  try {
    assert.match((await admin.query('show server_version')).rows[0].server_version, /^17\./);
    await admin.query('create database ' + database);
    db = new Pool({ ...config, database, max: 4 });
    for (const role of ['anon', 'authenticated', 'service_role']) {
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
        await admin.query('create role ' + role + ' nologin' + (role === 'service_role' ? ' bypassrls' : ''));
      }
    }
    for (const file of ['supabase/news_archive.sql', 'supabase/news_archive_least_privilege.sql',
      'supabase/migrations/20261027112037_news_archive_evidence.sql',
      'supabase/migrations/20261029131808_news_archive_query.sql',
      'supabase/migrations/20261029154157_news_archive_query_safeupdate.sql',
      'supabase/migrations/20261103035737_news_archive_query_quality_policy.sql']) {
      await db.query(await fs.readFile(path.join(repo, file), 'utf8'));
    }
    const quality = fixtureRows(), columns = Object.keys(quality[0]).filter(key => key !== 'id');
    await db.query('insert into news_archive(' + columns.join(',') + ') select ' + columns.join(',') +
      ' from jsonb_populate_recordset(null::news_archive,$1::jsonb)', [JSON.stringify(quality)]);
    await db.query(`insert into news_archive(fingerprint,title,url,source,source_name,snippet,published_at,fetched_at,matched_symbols,broker_firms,analysis_mode,analysis_summary)
      select encode(sha256(convert_to('g2-'||i,'UTF8')),'hex'),'PTT ข่าวผลประกอบการและการลงทุน '||i,
      'https://news.google.com/rss/articles/g2-'||i,case when i%3=0 then 'infoquest' else 'other' end,
      case when i%3=0 then 'InfoQuest' when i%3=1 then 'กรุงเทพธุรกิจ' else 'ฐานเศรษฐกิจ' end,
      'บริษัทเปิดเผยรายละเอียดผลประกอบการและการลงทุนจากต้นทางสำหรับผู้ถือหุ้น',
      $2::timestamptz-i*interval '1 minute',$2::timestamptz,
      case when i%5=0 then array['ADVANC'] else array['PTT'] end,
      case when i%7=0 then array['KS'] else '{}'::text[] end,
      case when i%11=0 then 'ai' else null end,case when i%11=0 then 'Stored AI '||i else null end
      from generate_series(1,$1::integer) i`, [3785 - quality.length, new Date(now).toISOString()]);
    const digest = async () => (await db.query("select count(*)::int rows,md5(string_agg(to_jsonb(a)::text,'' order by id)) digest from news_archive a")).rows[0];
    const initial = await digest(); assert.equal(initial.rows, 3785);
    http = await require('./fixtures/news-archive-query-http.cjs')(db, { ...config, database });
    const env = { SUPABASE_URL: 'https://g2-local.invalid', SUPABASE_SECRET_KEY: http.token,
      SETSCOPE_NEWS_EVIDENCE: 'read', SETSCOPE_NEWS_ARCHIVE_QUERY: 'on' };
    let active = null;
    const transport = async (input, init = {}) => {
      const u = new URL(input); assert.equal(u.origin, env.SUPABASE_URL);
      const response = await fetch(http.base + u.pathname.slice('/rest/v1'.length) + u.search, init);
      const body = await response.text();
      if (active) {
        active.requests++; active.responseBytes += Buffer.byteLength(body); active.requestBytes += Buffer.byteLength(init.body || '');
        if (init.headers?.Range) active.fullSnapshotRequests++;
        let value; try { value = JSON.parse(body); } catch { value = null; }
        active.rows += Array.isArray(value) ? value.length : value?.groups?.reduce((n, group) => n + group.rows.length, 0) || 0;
        if (!response.ok) active.errors++;
      }
      return new Response(body || null, { status: response.status, headers: response.headers });
    };
    const service = (extra = {}, create = createNewsArchiveService, options = {}) => create({ env: { ...env, ...extra }, fetchImpl: transport, now: () => now, ...options });
    const state = async () => (await db.query('select source_revision::text,index_revision::text,policy,(select count(*)::int from news_archive_query_dirty) dirty,(select count(*)::int from news_archive_query_rows) indexed from news_archive_query_state')).rows[0];
    await t.test('missing/partial index refuses empty success, interrupted bootstrap resumes without source changes', async () => {
      await assert.rejects(service().list(), /HTTP 400/);
      assert.equal((await service().refreshQueryIndex({ reset: true, maxBatches: 1, batchSize: 50 })).pending, true);
      await assert.rejects(service().list({ page: 999 }), /HTTP 400/);
      assert.equal((await service().refreshQueryIndex({ maxBatches: 30, batchSize: 500 })).pending, 0);
      const ready = await state(); assert.equal(ready.dirty, 0); assert.equal(ready.indexed, 3785);
      assert.equal(ready.policy, 'news-query-2:read:metadata'); assert.ok(Number(ready.index_revision) > 0);
      assert.deepEqual(await digest(), initial);
    });
    const reference = await service({ SETSCOPE_NEWS_ARCHIVE_QUERY: 'off' }).list({ featuredCount: 5 });
    const workloads = [
      { page: 1, featuredCount: 5 }, { page: 100, featuredCount: 5 },
      { page: Math.ceil(reference.total / 10), featuredCount: 5 }, { page: 99999, featuredCount: 5 },
      { source: 'bangkokbiznews,thansettakij', symbol: 'PTT', query: 'การลงทุน', featuredCount: 2 },
      { source: 'broker', symbol: 'ADVANC' }, { query: 'Stored AI' }, { symbol: 'CPALL' },
      { excludeUrls: [reference.items[0].url], featuredCount: 3 }
    ];
    const parity = (actual, expected) => {
      assert.deepEqual(actual.items, expected.items); assert.deepEqual(actual.featured, expected.featured);
      for (const key of ['total', 'matchingTotal', 'countExact', 'page', 'pageSize', 'qualityFiltered', 'rejected', 'quarantined', 'deduplicated']) {
        assert.equal(actual[key], expected[key], key);
      }
    };
    async function measure(label, create, { cold = false, bff = false, ingest = null, options = workloads } = {}) {
      const stats = { label, calls: options.length, requests: 0, rows: 0, responseBytes: 0, requestBytes: 0,
        fullSnapshotRequests: 0, errors: 0, cacheHit: 0, cacheMiss: 0, coalesced: 0, snapshotBuilds: 0, latenciesMs: [] };
      let shared = create(stats), cache = createMemoryCache({ now: () => now });
      const results = []; active = stats;
      try {
        for (const args of options) {
          const current = cold ? create(stats) : shared;
          const start = performance.now();
          if (ingest) assert.equal((await current.ingest([ingest])).retained, 1);
          if (bff) {
            const result = await cache.get(JSON.stringify(args), PROVIDER_POLICIES.newsArchive, () => current.list(args));
            if (result.meta.status === 'hit') stats.cacheHit++; else stats.cacheMiss++;
            results.push(result.value);
          } else results.push(await current.list(args));
          stats.latenciesMs.push(Number((performance.now() - start).toFixed(3)));
        }
      } finally { active = null; }
      const sorted = stats.latenciesMs.slice().sort((a, b) => a - b);
      stats.p50Ms = sorted[Math.ceil(sorted.length * .5) - 1]; stats.p95Ms = sorted[Math.ceil(sorted.length * .95) - 1];
      stats.cacheScope = bff ? 'existing BFF memory cache' : 'BFF bypassed; snapshotBuilds measures existing archive cache misses';
      metrics.push(stats); return results;
    }
    await t.test('cold and warm page/count/quality/filter parity with measured PostgreSQL/PostgREST responses', async () => {
      const factory = mode => stats => service({ SETSCOPE_NEWS_ARCHIVE_QUERY: mode }, createNewsArchiveService,
        { displayReview: async items => { if (mode === 'off') stats.snapshotBuilds++; return items; } });
      for (const scenario of ['cold', 'warm', 'bff']) {
        const options = scenario === 'bff' ? [...workloads, ...workloads] : workloads;
        const before = await measure(scenario + '-snapshot', factory('off'), { cold: scenario === 'cold', bff: scenario === 'bff', options });
        const after = await measure(scenario + '-database', factory('on'), { cold: scenario === 'cold', bff: scenario === 'bff', options });
        after.forEach((result, i) => parity(result, before[i]));
      }
      for (const result of metrics.filter(x => x.label.endsWith('-database'))) assert.equal(result.fullSnapshotRequests, 0);
      assert.deepEqual(await digest(), initial);
      paginationParity = true;
    });
    await t.test('retained RPC leaves all row bytes, source/index revisions and dirty queue unchanged', async () => {
      const item = article({ url: 'https://thunhoon.com/article-g2-retained', title: 'PTT ข่าวผลประกอบการฉบับทดสอบ', pubDate: new Date(now - 1000).toISOString(), checkedAt: now, matchedSymbols: ['PTT'] });
      const writer = service({ SETSCOPE_NEWS_EVIDENCE: 'write' });
      assert.equal((await writer.ingest([item])).ingested, 1);
      assert.equal((await writer.refreshQueryIndex({ maxBatches: 10 })).pending, 0);
      const before = await digest(), revision = await state();
      const filename = path.join(repo, 'server/news-archive-service.js'), baseline = new Module(filename, module);
      baseline.filename = filename; baseline.paths = Module._nodeModulePaths(path.dirname(filename));
      baseline._compile(execFileSync(process.env.SETSCOPE_G2_GIT || 'git', ['show', '3e705d6d221710a55c5e561e2ef2af906ffa582e:server/news-archive-service.js'], { cwd: repo, encoding: 'utf8', windowsHide: true }), filename);
      const options = Array.from({ length: 6 }, (_, i) => ({ page: i + 1 }));
      const factory = create => stats => {
        const archive = service({ SETSCOPE_NEWS_EVIDENCE: 'write', SETSCOPE_NEWS_ARCHIVE_QUERY: 'off' }, create,
          { displayReview: async items => { stats.snapshotBuilds++; return items; } });
        return archive;
      };
      // First request warms each version identically; subsequent ingests are exact retained retries.
      const beforeResults = await measure('retained-baseline', factory(baseline.exports.createNewsArchiveService), { ingest: item, options });
      const afterResults = await measure('retained-candidate', factory(createNewsArchiveService), { ingest: item, options });
      afterResults.forEach((result, i) => parity(result, beforeResults[i]));
      assert.deepEqual(await digest(), before); assert.deepEqual(await state(), revision);
      const stale = article({ ...item, title: 'PTT ข่าวฉบับเก่าที่มาถึงช้า', checkedAt: now - 10000 });
      assert.equal((await writer.ingest([stale])).retained, 1); assert.deepEqual(await digest(), before);
      const changed = article({ ...item, title: 'PTT ข่าวผลประกอบการฉบับแก้ไข', checkedAt: now + 1000 });
      assert.equal((await writer.ingest([changed])).ingested, 1);
      assert.notDeepEqual(await digest(), before);
      const result = await writer.list({ query: 'ฉบับแก้ไข' }); assert.equal(result.total, 1);
      assert.equal(result.items[0].title, changed.title);
      retainedParity = true;
    });
    if (process.env.SETSCOPE_G2_METRICS) await fs.writeFile(process.env.SETSCOPE_G2_METRICS, JSON.stringify({
      environment: 'isolated localhost PostgreSQL 17 / PostgREST 16.5', baseline: '3e705d6d221710a55c5e561e2ef2af906ffa582e',
      paginationSourceRows: initial.rows, paginationWorkloads: workloads,
      paginationParity: paginationParity ? 'PASS' : 'FAIL', retainedParity: retainedParity ? 'PASS' : 'FAIL', metrics,
      limitation: 'Uncompressed HTTP body bytes and fixture timings; not billed Supabase GB or production cache metrics.'
    }, null, 2));
    console.log('G2_METRICS ' + JSON.stringify(metrics));
  } finally {
    await http?.stop(); await db?.end();
    if (db) await admin.query('drop database ' + database + ' with(force)');
    await admin.end();
  }
});
