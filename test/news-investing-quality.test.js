'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fixtures = require('./fixtures/investing-news-quality.json');
const owner = require('./fixtures/investing-owner-pages.json');
const { classifyNewsItem, reviewNewsItem } = require('../lib/news-quality');
const { newsDisplayBlocked, newsUrlIdentity } = require('../lib/news-content');
const { createNewsService } = require('../server/news-service');
const { createNewsArchiveService } = require('../server/news-archive-service');
const { memoryTransport, env: archiveEnv } = require('./fixtures/news-evidence.cjs');
const { dedupeNewsItems } = require('../lib/broker-news');
const { issueEvidence, evidenceColumns, validStoredEvidence } = require('../lib/news-evidence');
const date = new Date(Date.now() - 60000).toISOString();
const item = row => ({ ...row, source: 'other', sourceName: 'Investing.com', pubDate: date });
const wrapper = row => item({ ...row, url: 'https://news.google.com/rss/articles/investing-quality-' + row.id });
const rss = rows => '<rss><channel>' + rows.map(row => '<item><title><![CDATA[' + row.title + ']]></title><link>' + row.url + '</link><source>Investing.com</source><pubDate>' + date + '</pubDate><description><![CDATA[' + row.snippet + ']]></description></item>').join('') + '</channel></rss>';

for (const row of fixtures.nonArticles) test('shared gate rejects Investing non-article URL and opaque RSS title: ' + row.id, () => {
  for (const candidate of [item(row), wrapper(row)]) {
    assert.equal(classifyNewsItem(candidate).decision, 'REJECT');
    assert.equal(reviewNewsItem(candidate).status, 'REJECTED');
    assert.equal(newsDisplayBlocked(candidate), true);
  }
});

for (const row of owner.cases) test('Owner screenshot ' + row.image + ' non-article is blocked at URL and opaque-wrapper boundaries: ' + row.id, () => {
  const candidate = { ...row, title: row.title + ' - Investing.com', snippet: 'ข้อมูลตลาดหุ้นไทยและข้อมูลตราสาร ราคาซื้อขาย กราฟและข้อมูลย้อนหลังสำหรับผู้ลงทุนในประเทศไทย' };
  for (const value of [item(candidate), wrapper(candidate)]) {
    assert.equal(reviewNewsItem(value).status, 'REJECTED');
    assert.equal(newsDisplayBlocked(value), true);
  }
});

for (const row of fixtures.articles) test('removed publisher blocks even relevant article content: ' + row.id, () => {
  const candidate = wrapper(row);
  assert.equal(classifyNewsItem(candidate).decision, 'REJECT');
  assert.equal(reviewNewsItem(candidate).status, 'REJECTED');
  assert.equal(newsDisplayBlocked(candidate), true);
});

test('content language and market evidence cannot be replaced by RSS locale or symbols', () => {
  const irrelevant = wrapper({ id: 'foreign', title: 'US stocks rise as technology earnings improve - Investing.com', snippet: 'US stocks rose as the technology sector reported stronger earnings and investors assessed the outlook for American companies. The Federal Reserve said that domestic inflation remained elevated.' });
  const foreign = wrapper({ id: 'language', title: fixtures.articles[1].title, snippet: 'Las acciones de Thailand subieron por las ganancias de los bancos. Los inversores evaluaron la situación económica del país y las nuevas decisiones de la autoridad monetaria en el mercado financiero.' });
  const sparse = wrapper({ id: 'sparse', title: fixtures.articles[1].title, snippet: 'Thailand stocks' });
  assert.equal(reviewNewsItem({ ...irrelevant, language: 'th', matchedSymbols: ['PTT'] }).status, 'REJECTED');
  assert.equal(reviewNewsItem({ ...foreign, language: 'en' }).status, 'REJECTED');
  assert.equal(reviewNewsItem(sparse).status, 'REJECTED');
  assert.match(reviewNewsItem(sparse).reason, /REMOVED_NEWS_PUBLISHER/);
  const noMarket = wrapper({ id: 'no-market', title: 'PTT ข่าวลงทุน B', snippet: 'บริษัทเผยรายละเอียดผลประกอบการและการลงทุนตามข่าวต้นทาง' });
  assert.equal(reviewNewsItem(noMarket).status, 'REJECTED', 'retired publisher stays blocked regardless of headline');
  const thaiQuotation = wrapper({ ...fixtures.articles[0], snippet: fixtures.articles[0].snippet + ' โดยมีข้อความอ้างอิงภาษาฝรั่งเศสว่า les des une' });
  assert.equal(reviewNewsItem(thaiQuotation).status, 'REJECTED', 'retired publisher stays blocked regardless of language');
});

test('removed publisher cannot return through real article routes or instrument narratives', () => {
  for (const path of ['/news/stock-market-news/thailand-outlook-123456', '/analysis/thailand-outlook-123456', '/commodities/news/thailand-outlook-123456', '/rates-bonds/articles/thailand-outlook-123456']) {
    const candidate = item({ ...fixtures.articles[1], url: 'https://www.investing.com' + path });
    assert.equal(classifyNewsItem(candidate).decision, 'REJECT');
    assert.equal(newsDisplayBlocked(candidate), true);
  }
  const narrative = wrapper({ ...fixtures.articles[1], title: 'Thailand manufacturers assess Copper Perpetual Futures - Investing.com' });
  assert.equal(reviewNewsItem(narrative).status, 'REJECTED', 'retired publisher stays blocked for real article narratives');
});

test('RSS Feed, Watchlist, persistence, archive reads and analysis share the same gate', async () => {
  const candidates = [...fixtures.nonArticles.map(wrapper), ...fixtures.articles.map(wrapper)];
  let articleCalls = 0, aiCalls = 0;
  const service = createNewsService({ env: { SETSCOPE_NEWS_EVIDENCE: 'write', SETSCOPE_P1_DISPLAY_GATE: 'off', OPENAI_API_KEY: 'synthetic-fixture-key' },
    fetchImpl: async value => { const url = new URL(value); if (url.hostname !== 'news.google.com') { aiCalls++; throw Error('Unexpected analysis request'); } return new Response(rss(candidates)); },
    articleFetch: async () => { articleCalls++; throw Error('Direct acquisition remains disabled'); } });
  const feed = await service.getNews();
  assert.equal(feed.items.length, 0);
  const watched = await service.getWatchlistNews('PTT', { ownerId: 'a' });
  assert.equal(watched.items.length, 0);
  assert.ok(watched.items.every(value => value.matchedSymbols.includes('PTT')));
  const db = memoryTransport(), archive = createNewsArchiveService({ env: { ...archiveEnv, SETSCOPE_P1_DISPLAY_GATE: 'off' }, fetchImpl: db.fetchImpl });
  await archive.ingest(candidates);
  assert.equal(db.rows.size, 0);
  const legacy = fixtures.nonArticles.map(wrapper).map((candidate, index) => ({ fingerprint: 'legacy-' + index, title: candidate.title, url: candidate.url, source: candidate.source,
    source_name: candidate.sourceName, snippet: candidate.snippet, published_at: date, fetched_at: date, first_seen_at: date, matched_symbols: ['PTT'], broker_firms: [] }));
  for (const row of legacy) db.rows.set(row.fingerprint, row);
  const read = await createNewsArchiveService({ env: { ...archiveEnv, SETSCOPE_NEWS_EVIDENCE: 'off', SETSCOPE_P1_DISPLAY_GATE: 'off' }, fetchImpl: db.fetchImpl }).list();
  assert.equal(read.items.length, 0); assert.equal(db.rows.size, 6, 'read-time exclusion never deletes historical rows');
  const summaries = await service.analyse(fixtures.nonArticles.map(wrapper));
  assert.ok(summaries.items.every(result => result.mode === 'unavailable' && result.summary === ''));
  for (let offset = 0; offset < owner.cases.length; offset += 8) {
    const rejected = owner.cases.slice(offset, offset + 8).map(row => wrapper({ ...row, snippet: fixtures.articles[0].snippet }));
    assert.ok((await service.analyse(rejected)).items.every(result => result.mode === 'unavailable' && result.summary === ''));
  }
  assert.equal(articleCalls, 0); assert.equal(aiCalls, 0);
  const positive = await createNewsService({ env: {}, fetchImpl: async () => { throw Error('No provider IO for rules summaries'); } }).analyse(fixtures.articles.map(wrapper));
  assert.equal(positive.items.length, 2);
  assert.ok(positive.items.every(result => result.mode === 'unavailable' && result.summary === ''), 'retired Thai and English articles never reach analysis');
});

test('canonical URL dedup preserves distinct stories and language editions despite identical titles', () => {
  const a = wrapper(fixtures.articles[0]), b = { ...a, url: a.url + '-different-story' };
  assert.equal(dedupeNewsItems([a, { ...a, url: a.url + '?utm_source=test#top' }, b]).length, 2);
  assert.notEqual(newsUrlIdentity('https://th.investing.com/news/stock-market-news/story-123'), newsUrlIdentity('https://www.investing.com/news/stock-market-news/story-123'));
  assert.notEqual(newsUrlIdentity('https://th.investing.com/commodities/copper?cid=1'), newsUrlIdentity('https://th.investing.com/commodities/copper?cid=2'));
});

test('old subject-bound positive evidence cannot bypass current quality and read-time exclusion is non-destructive', async () => {
  const db = memoryTransport();
  const candidate = wrapper({ ...owner.cases[0], snippet: fixtures.articles[0].snippet });
  const old = issueEvidence(candidate, { status: 'VERIFIED', reason: 'NEWS_METADATA_EVIDENCE', basis: 'metadata' });
  const row = { fingerprint: 'old-positive', title: candidate.title, url: candidate.url, source: candidate.source, source_name: candidate.sourceName,
    snippet: candidate.snippet, published_at: date, fetched_at: date, first_seen_at: date, matched_symbols: [], broker_firms: [] };
  Object.assign(row, evidenceColumns(candidate, row, old), { verification_revision: 1 });
  assert.equal(validStoredEvidence(row), true, 'the historical proof is structurally valid');
  db.rows.set(row.fingerprint, row);
  const before = JSON.stringify([...db.rows.values()]);
  const service = createNewsArchiveService({ env: { ...archiveEnv, SETSCOPE_P1_DISPLAY_GATE: 'off' }, fetchImpl: db.fetchImpl });
  assert.equal((await service.list()).items.length, 0);
  assert.equal(JSON.stringify([...db.rows.values()]), before);
  const sparse = wrapper({ ...fixtures.articles[1], snippet: 'Thailand stocks' });
  const obsolete = issueEvidence(sparse, { status: 'VERIFIED', reason: 'NEWS_METADATA_EVIDENCE', basis: 'metadata' });
  assert.equal(reviewNewsItem(sparse, obsolete).status, 'REJECTED');
});
