'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const navigationPageFixtures = require('./fixtures/news-quality-navigation-pages.json');

const { createNewsArchiveService } = require('../server/news-archive-service');

function archiveRow(index, overrides = {}) {
  const order = Number.isFinite(Number(index)) ? Number(index) : 999;
  return {
    fingerprint: `row-${index}`,
    title: `PTT รายงานความคืบหน้าธุรกิจลำดับ ${index}`,
    url: `https://news.google.com/articles/archive-${index}`,
    source: 'infoquest',
    source_name: 'InfoQuest',
    snippet: 'บริษัทเปิดเผยรายละเอียดและกรอบเวลาดำเนินงานล่าสุด',
    published_at: new Date(Date.parse('2026-10-18T00:00:00.000Z') - order * 60_000).toISOString(),
    matched_symbols: ['PTT'],
    broker_firms: [],
    ...overrides
  };
}

function rangeResponse(rows, init) {
  const [start, end] = String(init.headers.Range || '0-999').split('-').map(Number);
  const page = rows.slice(start, end + 1);
  const last = page.length ? start + page.length - 1 : start;
  return new Response(JSON.stringify(page), {
    status: 200,
    headers: {
      'content-range': `${start}-${last}/${rows.length}`,
      'content-type': 'application/json'
    }
  });
}

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
  const item = { source: 'infoquest', sourceName: 'InfoQuest', title: 'PTT update', url: 'https://news.google.com/articles/1', pubDate: '2026-10-17T00:00:00.000Z', snippet: 'บริษัทเปิดเผยรายละเอียดและกรอบเวลาดำเนินงานล่าสุด' };
  const result = await service.ingest([item, { ...item }]);
  assert.equal(result.ingested, 1);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /news_archive\?on_conflict=fingerprint/);
  assert.match(calls[1].url, /rpc\/cleanup_news_archive/);
  assert.equal(JSON.parse(calls[1].init.body).p_limit, 500);
});

test('archive pagination validates filters and never returns an unbounded year', async () => {
  const requested = [];
  const rows = Array.from({ length: 43 }, (_, index) => archiveRow(index + 1));
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key' },
    scanChunkSize: 20,
    fetchImpl: async (url, init) => {
      requested.push({ url: String(url), init });
      return rangeResponse(rows, init);
    }
  });
  const result = await service.list({ page: 2, pageSize: 20, source: 'infoquest', symbol: 'PTT' });
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 20);
  assert.equal(result.total, 43);
  assert.equal(result.items.length, 20);
  assert.deepEqual(requested.map(call => call.init.headers.Range), ['0-19', '20-39', '40-59']);
  assert.ok(result.items.every(item => item.source === 'infoquest' && item.matchedSymbols.includes('PTT')));
});

test('archive paginates the final displayable dataset after quality filtering and deduplication', async () => {
  const goodRows = Array.from({ length: 23 }, (_, index) => archiveRow(index + 1));
  const rawRows = [
    archiveRow('bad-a', { title: '- SET', url: 'https://news.google.com/articles/bad-a' }),
    goodRows[0],
    archiveRow('duplicate-1', { ...goodRows[0], fingerprint: 'duplicate-1', url: `${goodRows[0].url}?utm_source=duplicate` }),
    ...goodRows.slice(1, 10),
    archiveRow('bad-b', { title: '- SET', url: 'https://news.google.com/articles/bad-b' }),
    ...goodRows.slice(10, 18),
    archiveRow('duplicate-5', { ...goodRows[4], fingerprint: 'duplicate-5', url: `${goodRows[4].url}?utm_medium=duplicate` }),
    ...goodRows.slice(18),
    archiveRow('bad-c', { title: '- SET', url: 'https://news.google.com/articles/bad-c' })
  ];
  const calls = [];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    scanChunkSize: 6,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return rangeResponse(rawRows, init);
    }
  });

  const first = await service.list({ page: 1, pageSize: 10 });
  const second = await service.list({ page: 2, pageSize: 10 });
  const final = await service.list({ page: 3, pageSize: 10 });
  const items = [...first.items, ...second.items, ...final.items];

  assert.equal(first.total, 23);
  assert.equal(first.qualityFiltered, 3);
  assert.equal(first.deduplicated, 2);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 10);
  assert.equal(final.items.length, 3);
  assert.deepEqual(items.map(item => item.fingerprint), goodRows.map(item => item.fingerprint));
  assert.equal(new Set(items.map(item => item.url)).size, 23);
  assert.equal(calls.length, Math.ceil(rawRows.length / 6), 'later pages reuse the bounded archive snapshot');
});

test('archive applies source, symbol, search and featured exclusions before pagination totals', async () => {
  const matching = Array.from({ length: 13 }, (_, index) => archiveRow(index + 1, {
    title: `PTT กำไรเติบโตลำดับ ${index + 1}`
  }));
  const rows = [
    ...matching,
    archiveRow(20, { title: 'PTT รายงานยอดขายล่าสุด' }),
    archiveRow(21, { title: 'PTT กำไรเติบโตจากอีกสำนัก', source: 'efinance', source_name: 'efinanceThai' }),
    archiveRow(22, { title: 'AOT กำไรเติบโต', matched_symbols: ['AOT'] })
  ];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    scanChunkSize: 5,
    fetchImpl: async (url, init) => rangeResponse(rows, init)
  });

  const excludedUrl = matching[0].url;
  const first = await service.list({
    page: 1, pageSize: 10, source: 'infoquest', symbol: 'PTT', query: 'กำไร', excludeUrls: [excludedUrl]
  });
  const second = await service.list({
    page: 2, pageSize: 10, source: 'infoquest', symbol: 'PTT', query: 'กำไร', excludeUrls: [excludedUrl]
  });

  assert.equal(first.total, 12);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 2);
  assert.ok([...first.items, ...second.items].every(item => item.source === 'infoquest'));
  assert.ok([...first.items, ...second.items].every(item => item.matchedSymbols.includes('PTT')));
  assert.ok([...first.items, ...second.items].every(item => item.title.includes('กำไร')));
  assert.ok([...first.items, ...second.items].every(item => item.url !== excludedUrl));
});

test('archive returns a quality-gated seven-day Featured fallback before pagination', async () => {
  const timestamp = Date.parse('2026-10-24T12:00:00.000Z');
  const recent = Array.from({ length: 12 }, (_, index) => archiveRow(index + 1, {
    title: `PTT กำไรเติบโตลำดับ ${index + 1}`,
    published_at: new Date(timestamp - (index + 1) * 60_000).toISOString(),
    analysis_summary: index === 0 ? 'สรุปที่บันทึกและตรวจสอบแล้ว' : null,
    analysis_mode: index === 0 ? 'rules' : null
  }));
  const rows = [
    ...recent,
    archiveRow('official', {
      title: 'ประกาศสำคัญจากตลาดหลักทรัพย์',
      source: 'official',
      source_name: 'ตลาดหลักทรัพย์แห่งประเทศไทย',
      published_at: new Date(timestamp - 6 * 24 * 60 * 60 * 1000).toISOString()
    }),
    archiveRow('old', { published_at: new Date(timestamp - 8 * 24 * 60 * 60 * 1000).toISOString() }),
    archiveRow('invalid-date', { published_at: 'not-a-date' }),
    archiveRow('rejected', { title: '- SET' })
  ];
  let calls = 0;
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => timestamp,
    scanChunkSize: 50,
    fetchImpl: async (url, init) => { calls += 1; return rangeResponse(rows, init); }
  });

  const first = await service.list({ page: 1, pageSize: 10, source: 'all', query: '', featuredCount: 5 });
  const second = await service.list({ page: 2, pageSize: 10, source: 'all', query: '', featuredCount: 5 });
  const featuredKeys = new Set(first.featured.map(item => item.fingerprint));

  assert.equal(first.featured.length, 5);
  assert.equal(first.featured[0].fingerprint, 'row-official', 'source priority is preserved inside the seven-day window');
  assert.ok(first.featured.every(item => Number.isFinite(Date.parse(item.pubDate))));
  assert.ok(first.featured.every(item => Date.parse(item.pubDate) >= timestamp - 7 * 24 * 60 * 60 * 1000));
  assert.ok(!featuredKeys.has('row-old'));
  assert.ok(!featuredKeys.has('row-invalid-date'));
  assert.ok([...first.items, ...second.items].every(item => !featuredKeys.has(item.fingerprint)));
  assert.equal(first.total, rows.length - 2 - first.featured.length, 'invalid date, non-news row and Featured rows are excluded from the Latest total');
  assert.equal(calls, 1, 'Featured and paginated Latest reuse one bounded archive snapshot');
  assert.equal(first.featured.find(item => item.fingerprint === 'row-1').analysisSummary, 'สรุปที่บันทึกและตรวจสอบแล้ว');
});

test('archive Featured fallback keeps source, search, total and persisted-summary validation', async () => {
  const timestamp = Date.parse('2026-10-24T12:00:00.000Z');
  const rows = [
    ...Array.from({ length: 8 }, (_, index) => archiveRow(index + 1, {
      title: `PTT กำไรเติบโตลำดับ ${index + 1}`,
      published_at: new Date(timestamp - index * 60_000).toISOString()
    })),
    archiveRow(20, { title: 'PTT รายงานยอดขาย', published_at: new Date(timestamp - 60_000).toISOString() }),
    archiveRow(21, { title: 'PTT กำไรจากอีกสำนัก', source: 'efinance', source_name: 'efinanceThai', published_at: new Date(timestamp - 60_000).toISOString() }),
    archiveRow(22, { title: 'PTT กำไรพร้อมข้อมูลไม่รับรอง', published_at: new Date(timestamp - 60_000).toISOString(), analysis_summary: 'ห้ามนำมาแสดง', analysis_mode: 'unknown' })
  ];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => timestamp,
    fetchImpl: async (url, init) => rangeResponse(rows, init)
  });

  const result = await service.list({ page: 1, pageSize: 10, source: 'infoquest', query: 'กำไร', featuredCount: 5 });
  assert.equal(result.featured.length, 5);
  assert.equal(result.total, 4);
  assert.ok([...result.featured, ...result.items].every(item => item.source === 'infoquest' && item.title.includes('กำไร')));
  const unverified = [...result.featured, ...result.items].find(item => item.fingerprint === 'row-22');
  assert.equal(unverified.analysisSummary, '');
  assert.equal(unverified.analysisMode, '');
});

test('archive fails closed when the persisted dataset exceeds its bounded scan limit', async () => {
  let calls = 0;
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    scanChunkSize: 5,
    maxScanRows: 10,
    fetchImpl: async (url, init) => {
      calls += 1;
      return new Response(JSON.stringify(Array.from({ length: 5 }, (_, index) => archiveRow(index + 1))), {
        status: 200,
        headers: { 'content-range': '0-4/11', 'content-type': 'application/json' }
      });
    }
  });

  await assert.rejects(service.list({ page: 1, pageSize: 10 }), /exceeds bounded scan limit/);
  assert.equal(calls, 1);
});

test('concurrent archive pages coalesce into one bounded snapshot scan', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => archiveRow(index + 1));
  let calls = 0;
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    scanChunkSize: 5,
    fetchImpl: async (url, init) => {
      calls += 1;
      await Promise.resolve();
      return rangeResponse(rows, init);
    }
  });

  const [first, second] = await Promise.all([
    service.list({ page: 1, pageSize: 10 }),
    service.list({ page: 2, pageSize: 10 })
  ]);
  assert.equal(first.items.length, 10);
  assert.equal(second.items.length, 2);
  assert.equal(calls, 3);
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

test('archive read and ingest gates reject navigation/reference landing pages', async () => {
  const calls = [];
  const publishedAt = '2026-10-17T00:00:00.000Z';
  const badRows = navigationPageFixtures.rejected.map((item, index) => ({
    fingerprint: `navigation-reference-${index}`,
    source: item.source,
    source_name: item.sourceName,
    title: item.title,
    url: item.url,
    published_at: publishedAt,
    snippet: ''
  }));
  const good = navigationPageFixtures.accepted[0];
  const goodRow = {
    fingerprint: 'genuine-fund-ipo-news',
    source: good.source,
    source_name: good.sourceName,
    title: good.title,
    url: good.url,
    published_at: publishedAt,
    snippet: good.snippet
  };
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-18T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return new Response(null, { status: 204 });
      return new Response(JSON.stringify([...badRows, goodRow]), {
        status: 200,
        headers: {
          'content-range': `0-${badRows.length}/${badRows.length + 1}`,
          'content-type': 'application/json'
        }
      });
    }
  });

  const listed = await service.list({ page: 1, pageSize: 10, source: 'settrade' });
  assert.deepEqual(listed.items.map(item => item.fingerprint), ['genuine-fund-ipo-news']);
  assert.equal(listed.qualityFiltered, navigationPageFixtures.rejected.length);

  for (const bad of badRows) {
    const result = await service.ingest([{
      source: bad.source,
      sourceName: bad.source_name,
      title: bad.title,
      url: bad.url,
      pubDate: bad.published_at,
      snippet: bad.snippet
    }]);
    assert.equal(result.ingested, 0, bad.title);
  }
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
});

test('archive read-time and ingest gates exclude targeted recruiting and company-board records without deleting stored rows', async () => {
  const calls = [];
  const publishedAt = '2026-10-23T00:00:00.000Z';
  const badRows = [
    {
      fingerprint: 'set-recruiting', source: 'settrade', source_name: 'SET',
      title: 'SET Recruiting - ตลาดหลักทรัพย์แห่งประเทศไทย',
      url: 'https://news.google.com/rss/articles/set-recruiting', published_at: publishedAt, snippet: ''
    },
    {
      fingerprint: 'amata-board', source: 'settrade', source_name: 'SETTRADE.COM',
      title: 'AMATA - กรรมการบริษัท - SETTRADE.COM',
      url: 'https://news.google.com/rss/articles/amata-company-board', published_at: publishedAt, snippet: ''
    }
  ];
  const service = createNewsArchiveService({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-key' },
    now: () => Date.parse('2026-10-24T00:00:00.000Z'),
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'POST') return new Response(null, { status: 204 });
      return new Response(JSON.stringify(badRows), {
        status: 200,
        headers: { 'content-range': '0-1/2', 'content-type': 'application/json' }
      });
    }
  });

  const listed = await service.list({ page: 1, pageSize: 10 });
  assert.deepEqual(listed.items, []);
  assert.equal(listed.qualityFiltered, 2);
  assert.equal(calls.filter(call => call.init.method === 'DELETE').length, 0);
  for (const row of badRows) {
    const result = await service.ingest([{
      source: row.source, sourceName: row.source_name, title: row.title,
      url: row.url, pubDate: row.published_at, snippet: row.snippet
    }]);
    assert.equal(result.ingested, 0);
  }
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
});
