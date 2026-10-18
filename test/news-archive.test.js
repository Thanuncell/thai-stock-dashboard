'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createNewsArchiveService } = require('../server/news-archive-service');

test('archive ingestion is idempotent, bounded and followed by bounded retention cleanup', async () => {
  const calls = [];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }
  });
  const item = { source: 'infoquest', sourceName: 'InfoQuest', title: 'PTT update', url: 'https://news.google.com/articles/1', pubDate: '2026-10-17T00:00:00.000Z', snippet: 'รายละเอียด' };
  const result = await service.ingest([item, { ...item }]);
  assert.equal(result.ingested, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /news_archive\?on_conflict=fingerprint/);
  assert.match(calls[1].url, /rpc\/cleanup_news_archive/);
  assert.equal(JSON.parse(calls[1].init.body).p_limit, 500);
});

test('archive pagination validates filters and never returns an unbounded year', async () => {
  let requested;
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' },
    fetchImpl: async (url, init) => {
      requested = { url: String(url), init };
      return new Response(JSON.stringify([{ fingerprint: 'one', title: 'PTT', url: 'https://news.google.com/articles/1', source: 'infoquest', source_name: 'InfoQuest', published_at: '2026-10-17T00:00:00.000Z' }]), {
        status: 200,
        headers: { 'content-range': '20-20/43', 'content-type': 'application/json' }
      });
    }
  });
  const result = await service.list({ page: 2, pageSize: 20, source: 'infoquest', symbol: 'PTT' });
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 20);
  assert.equal(result.total, 43);
  assert.match(requested.init.headers.Range, /20-39/);
  assert.match(requested.url, /source=eq\.infoquest/);
  assert.match(requested.url, /matched_symbols=cs\./);
});
