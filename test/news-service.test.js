'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BROKER_FIRMS, decorateBrokerAttribution, matchBrokerFirms } = require('../lib/broker-news');
const { createNewsService } = require('../server/news-service');
const { classifyNewsItem } = require('../lib/news-quality');

function rss(items) {
  return `<rss><channel>${items.map(item => `<item><title>${item.title}</title><link>${item.url}</link><pubDate>${item.pubDate}</pubDate><description>${item.snippet || ''}</description><source>${item.sourceName}</source></item>`).join('')}</channel></rss>`;
}

test('Watchlist News keeps relevant unknown publishers and rejects only invalid items', async () => {
  const recent = new Date().toUTCString();
  const body = rss([
    { title: 'PTT เดินหน้าลงทุน', url: 'https://news.google.com/articles/unknown', pubDate: recent, sourceName: 'สำนักข่าวท้องถิ่น' },
    { title: 'PTT เดินหน้าลงทุน', url: 'https://news.google.com/articles/unknown', pubDate: recent, sourceName: 'สำนักข่าวท้องถิ่น' },
    { title: 'AOT เปิดเส้นทางใหม่', url: 'https://news.google.com/articles/unrelated', pubDate: recent, sourceName: 'สำนักข่าวท้องถิ่น' },
    { title: 'PTT URL ไม่ปลอดภัย', url: 'http://news.google.com/articles/bad', pubDate: recent, sourceName: 'สำนักข่าวท้องถิ่น' },
    { title: 'PTT วันที่เสีย', url: 'https://news.google.com/articles/date', pubDate: 'not-a-date', sourceName: 'สำนักข่าวท้องถิ่น' }
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getWatchlistNews([{ symbol: 'PTT', name: 'ปตท.' }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source, 'other');
  assert.equal(result.items[0].sourceName, 'สำนักข่าวท้องถิ่น');
  assert.deepEqual(result.items[0].matchedSymbols, ['PTT']);
});

test('all ten broker mappings are deterministic without acronym-only collisions', () => {
  assert.equal(BROKER_FIRMS.length, 10);
  for (const broker of BROKER_FIRMS) {
    assert.deepEqual(matchBrokerFirms(`บทวิเคราะห์โดย ${broker.companyName}`), [broker.key]);
  }
  for (const acronym of ['KS', 'KSS', 'KGI', 'FSS', 'LIB']) {
    assert.deepEqual(matchBrokerFirms(`หุ้น ${acronym} ปรับตัววันนี้`), []);
  }
});

test('republished broker analysis keeps the actual publisher and one deduplicated card', () => {
  const item = decorateBrokerAttribution({
    source: 'infoquest',
    sourceName: 'InfoQuest',
    title: 'อินโฟเควสท์รายงานบทวิเคราะห์จาก บริษัทหลักทรัพย์ บัวหลวง จำกัด (มหาชน)',
    snippet: ''
  });
  assert.equal(item.source, 'infoquest');
  assert.equal(item.sourceName, 'InfoQuest');
  assert.equal(item.brokerCategory, true);
  assert.deepEqual(item.matchedBrokerFirms, ['BLS']);
});

test('news quality rejects slug, generic source and account-service pages but accepts genuine articles', () => {
  const date = new Date().toISOString();
  const cases = [
    { title: '- SET', sourceName: 'SET', url: 'https://news.google.com/articles/set', pubDate: date, snippet: '' },
    { title: 'mmxx-ventures - Thunhoon', sourceName: 'Thunhoon', url: 'https://news.google.com/articles/slug', pubDate: date, snippet: '' },
    { title: 'Reset Password', sourceName: 'Example', url: 'https://example.com/account/reset-password', pubDate: date, snippet: 'Reset your account password' }
  ];
  assert.ok(cases.every(item => classifyNewsItem(item).accepted === false));
  assert.equal(classifyNewsItem({
    title: 'บริษัทจดทะเบียนแจ้งผลประกอบการไตรมาสล่าสุด', sourceName: 'ตลาดหลักทรัพย์แห่งประเทศไทย',
    source: 'settrade', url: 'https://news.google.com/articles/official', pubDate: date,
    snippet: 'บริษัทเปิดเผยผลประกอบการและรายละเอียดสำคัญสำหรับผู้ลงทุน'
  }).accepted, true);
});

test('watchlist news quality keeps relevant unknown publishers with meaningful content', async () => {
  const recent = new Date().toUTCString();
  const body = rss([
    { title: 'PTT เดินหน้าลงทุนพลังงานสะอาด', url: 'https://news.google.com/articles/good', pubDate: recent, sourceName: 'สำนักข่าวท้องถิ่น', snippet: 'บริษัทเปิดเผยแผนลงทุนใหม่พร้อมกรอบเวลาและงบประมาณโครงการ' },
    { title: 'PTT-company-profile - Example', url: 'https://news.google.com/articles/profile', pubDate: recent, sourceName: 'Example', snippet: '' }
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getWatchlistNews([{ symbol: 'PTT', name: 'ปตท.' }]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source, 'other');
  assert.equal(result.items[0].sourceName, 'สำนักข่าวท้องถิ่น');
});

test('analysis does not fabricate a summary when no article or snippet exists', async () => {
  const service = createNewsService({ env: {}, fetchImpl: async () => new Response('', { status: 404 }) });
  const result = await service.analyse([{ title: 'PTT รายงานผลประกอบการล่าสุด', url: 'https://news.google.com/articles/no-content', snippet: '' }]);
  assert.equal(result.items[0].summary, '');
  assert.equal(result.items[0].mode, 'unavailable');
  assert.equal(result.items[0].basis, 'headline');
});

test('AI analysis is not called when article extraction and snippet are both empty', async () => {
  let aiCalls = 0;
  const service = createNewsService({
    env: { OPENAI_API_KEY: 'test-only' },
    fetchImpl: async input => {
      if (String(input).includes('api.openai.com')) aiCalls += 1;
      return new Response('', { status: 404 });
    },
    logger: { warn() {} }
  });
  const result = await service.analyse([{ title: 'PTT รายงานผลประกอบการล่าสุด', url: 'https://news.google.com/articles/no-content', snippet: '' }]);
  assert.equal(aiCalls, 0);
  assert.equal(result.items[0].summary, '');
});
