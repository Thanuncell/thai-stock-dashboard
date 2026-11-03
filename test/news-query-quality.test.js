'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createNewsArchiveService, reviewArchivedNewsRow } = require('../server/news-archive-service');
const { validStoredEvidence } = require('../lib/news-evidence');
const { memoryQuery } = require('./fixtures/news-query-quality.cjs');
const env = { SUPABASE_URL: 'https://query-quality.invalid', SUPABASE_SECRET_KEY: 'synthetic-query-key', SETSCOPE_NEWS_EVIDENCE: 'read', SETSCOPE_NEWS_ARCHIVE_QUERY: 'on' };
const service = fixture => createNewsArchiveService({ env, fetchImpl: fixture.fetchImpl });

test('quality revision refuses an old clean index even when page 1 contains only accepted publishers', async () => {
  const fixture = memoryQuery(), archive = service(fixture), before = JSON.stringify([...fixture.raw.values()]);
  assert.ok(fixture.rows.every(validStoredEvidence));
  assert.equal(fixture.rows.filter(row => reviewArchivedNewsRow(row).status === 'REJECTED').length, 18);
  await assert.rejects(archive.list({ page: 1, pageSize: 2 }), /NEWS_QUERY_POLICY_NOT_READY/);
  await assert.rejects(archive.list({ page: 999, pageSize: 2 }), /NEWS_QUERY_POLICY_NOT_READY/);
  await assert.rejects(archive.refreshQueryIndex({ maxBatches: 1 }), /NEWS_QUERY_POLICY_MISMATCH/, 'incremental refresh cannot relabel the old generation');
  assert.equal(JSON.stringify([...fixture.raw.values()]), before);
  assert.ok(fixture.calls.every(call => ['list_news_archive_query', 'news_archive_query_work'].includes(call.name)), 'reads and an incompatible incremental refresh never reset or commit');
});

test('manual rebuild excludes old positives before key selection, counts, features and pagination without changing news rows', async () => {
  const fixture = memoryQuery(), archive = service(fixture), before = JSON.stringify([...fixture.raw.values()]);
  const first = await archive.refreshQueryIndex({ reset: true, maxBatches: 1, batchSize: 2 });
  assert.equal(first.pending, true);
  await assert.rejects(archive.list(), /NEWS_QUERY_INDEX_NOT_READY/);
  assert.equal((await archive.refreshQueryIndex({ maxBatches: 30, batchSize: 2 })).pending, 0);
  assert.equal(fixture.policy, 'news-query-2:read:metadata');
  const selected = [], featured = [];
  for (const page of [1, 2, 3]) {
    const result = await archive.list({ page, pageSize: 2, featuredCount: 2 });
    assert.equal(result.total, 4); assert.equal(result.matchingTotal, 6); assert.equal(result.countExact, true);
    assert.equal(result.rejected, 18); assert.equal(result.quarantined, 1); assert.equal(result.qualityFiltered, 19);
    assert.equal(result.deduplicated, 1); assert.equal(result.items.length, page === 3 ? 0 : 2);
    selected.push(...result.items.map(item => item.url)); featured.push(...result.featured.map(item => item.url));
    const rpc = fixture.calls.filter(call => call.name === 'list_news_archive_query').at(-1);
    const raw = fixture.rpc('list_news_archive_query', rpc.args);
    assert.equal(raw.pageKeys.length, result.items.length); assert.equal(raw.featuredKeys.length, 2);
    assert.equal(new Set([...raw.pageKeys, ...raw.featuredKeys]).size, raw.pageKeys.length + 2);
  }
  assert.equal(new Set(selected).size, 4); assert.equal(new Set(featured).size, 2);
  assert.equal(JSON.stringify([...fixture.raw.values()]), before);
});

test('rebuilt query projection preserves Investing positives, other publishers, search, exclusions and distinct stories across restart', async () => {
  const fixture = memoryQuery(); await service(fixture).refreshQueryIndex({ reset: true, maxBatches: 10 });
  const archive = service(fixture);
  const investing = await archive.list({ source: 'investing', pageSize: 10 });
  assert.equal(investing.total, 2); assert.equal(investing.items.length, 2);
  assert.ok(investing.items.every(item => item.sourceName === 'Investing.com'));
  assert.equal((await archive.list({ source: 'infoquest' })).total, 4);
  assert.equal((await archive.list({ query: 'same-headline' })).items.length, 2, 'same-title distinct URLs never merge');
  assert.equal((await archive.list({ query: 'distinct-story-1' })).total, 1);
  assert.equal((await archive.list({ source: 'investing,infoquest', symbol: 'PTT' })).total, 6);
  assert.equal((await archive.list({ excludeUrls: [investing.items[0].url] })).total, 5);
  assert.equal((await archive.list({ symbol: 'CPALL' })).total, 0);
  const reads = fixture.calls.filter(call => call.name === 'list_news_archive_query');
  assert.ok(reads.every(call => call.args.p_policy === 'news-query-2:read:metadata'));
});
