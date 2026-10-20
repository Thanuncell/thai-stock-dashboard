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

test('archive ingestion rejects non-news records before persistence', async () => {
  const calls = [];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); }
  });
  const result = await service.ingest([{ source: 'settrade', sourceName: 'SET', title: '- SET', url: 'https://news.google.com/articles/bad', pubDate: '2026-10-17T00:00:00.000Z' }]);
  assert.equal(result.ingested, 0);
  assert.equal(calls.length, 0);
});

test('archive hides existing SETTRADE overview rows and does not ingest them again', async () => {
  const calls = [];
  const bad = {
    fingerprint: 'overview', source: 'settrade', source_name: 'Settrade',
    title: 'LHHOTEL - ภาพรวม - Settrade',
    url: 'https://news.google.com/rss/articles/opaque',
    published_at: '2026-10-17T00:00:00.000Z'
  };
  const good = {
    fingerprint: 'article', source: 'settrade', source_name: 'Settrade',
    title: 'TFEX จากเรื่องไกลตัว สู่เครื่องมือที่นักลงทุนควรรู้จัก',
    url: 'https://www.settrade.com/th/news-and-articles/articles/778-piyaporn-tfex-from-distant-to-essential',
    published_at: '2026-10-17T00:00:00.000Z'
  };
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return new Response(null, { status: 204 });
      return new Response(JSON.stringify([bad, good]), {
        status: 200,
        headers: { 'content-range': '0-1/2', 'content-type': 'application/json' }
      });
    }
  });
  const listed = await service.list({ page: 1, pageSize: 10, source: 'settrade' });
  assert.deepEqual(listed.items.map(item => item.fingerprint), ['article']);
  assert.equal(listed.qualityFiltered, 1);
  const ingested = await service.ingest([{
    source: 'settrade', sourceName: 'Settrade', title: bad.title, url: bad.url,
    pubDate: bad.published_at
  }]);
  assert.equal(ingested.ingested, 0);
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
});

test('archive hides pagination and cross-source non-news rows and prevents re-ingestion', async () => {
  const calls = [];
  const publishedAt = '2026-10-17T00:00:00.000Z';
  const badRows = [
    {
      fingerprint: 'kaohoon-page', source: 'kaohoon', source_name: 'ข่าวหุ้นธุรกิจออนไลน์',
      title: 'ข่าว - Page 7712 of 7712 - ข่าวหุ้นธุรกิจออนไลน์ - ข่าวหุ้นธุรกิจออนไลน์',
      url: 'https://news.google.com/rss/articles/kaohoon-page', published_at: publishedAt,
      snippet: 'ข่าว - Page 7712 of 7712 - ข่าวหุ้นธุรกิจออนไลน์'
    },
    {
      fingerprint: 'thunhoon-slug', source: 'thunhoon', source_name: 'Thunhoon',
      title: 'mmxx-ventures - Thunhoon', url: 'https://news.google.com/rss/articles/thunhoon-slug',
      published_at: publishedAt, snippet: ''
    },
    {
      fingerprint: 'settrade-shareholders', source: 'settrade', source_name: 'Settrade',
      title: 'BCP - ข้อมูลผู้ถือหุ้น - Settrade', url: 'https://news.google.com/rss/articles/settrade-shareholders',
      published_at: publishedAt, snippet: ''
    }
  ];
  const good = {
    fingerprint: 'real-news', source: 'kaohoon', source_name: 'ข่าวหุ้นธุรกิจออนไลน์',
    title: 'ผู้ถือหุ้นอนุมัติแผนลงทุนใหม่ของบริษัท', url: 'https://news.google.com/rss/articles/real-news',
    published_at: publishedAt, snippet: 'ที่ประชุมอนุมัติวงเงินและกรอบเวลาดำเนินการของโครงการใหม่'
  };
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return new Response(null, { status: 204 });
      return new Response(JSON.stringify([...badRows, good]), {
        status: 200,
        headers: { 'content-range': '0-2/3', 'content-type': 'application/json' }
      });
    }
  });
  const listed = await service.list({ page: 1, pageSize: 10, source: 'all' });
  assert.deepEqual(listed.items.map(item => item.fingerprint), ['real-news']);
  assert.equal(listed.qualityFiltered, 3);

  for (const bad of badRows) {
    const result = await service.ingest([{
      source: bad.source, sourceName: bad.source_name, title: bad.title, url: bad.url,
      pubDate: bad.published_at, snippet: bad.snippet
    }]);
    assert.equal(result.ingested, 0);
  }
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
});

test('archive read and ingest gates reject reference classes while preserving short genuine articles', async () => {
  const calls = [];
  const publishedAt = '2026-10-17T00:00:00.000Z';
  const badRows = [
    {
      fingerprint: 'bond-reference', source: 'settrade', source_name: 'Settrade',
      title: 'BONDUS01 - Settrade', url: 'https://news.google.com/rss/articles/bond-reference',
      published_at: publishedAt, snippet: ''
    },
    {
      fingerprint: 'bot-report-reference', source: 'official', source_name: 'Bank of Thailand',
      title: 'ReportEGPRP0001 - Bank of Thailand', url: 'https://news.google.com/rss/articles/bot-report-reference',
      published_at: publishedAt, snippet: ''
    },
    {
      fingerprint: 'trading-calendar', source: 'settrade', source_name: 'Settrade',
      title: 'S50H27P1060 - ปฏิทินการซื้อขาย - Settrade', url: 'https://news.google.com/rss/articles/trading-calendar',
      published_at: publishedAt, snippet: ''
    }
  ];
  const good = {
    fingerprint: 'short-article', source: 'efinance', source_name: 'efinanceThai',
    title: 'Force Majeure', url: 'https://news.google.com/rss/articles/short-article',
    published_at: publishedAt, snippet: 'บทความอธิบายเหตุสุดวิสัยและผลกระทบต่อบริษัทจดทะเบียน'
  };
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return new Response(null, { status: 204 });
      return new Response(JSON.stringify([...badRows, good]), {
        status: 200,
        headers: { 'content-range': '0-3/4', 'content-type': 'application/json' }
      });
    }
  });

  const listed = await service.list({ page: 1, pageSize: 10, source: 'all' });
  assert.deepEqual(listed.items.map(item => item.fingerprint), ['short-article']);
  assert.equal(listed.qualityFiltered, 3);

  for (const bad of badRows) {
    const result = await service.ingest([{
      source: bad.source, sourceName: bad.source_name, title: bad.title, url: bad.url,
      pubDate: bad.published_at, snippet: bad.snippet
    }]);
    assert.equal(result.ingested, 0, bad.title);
  }
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
});
