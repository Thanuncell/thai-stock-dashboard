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

test('SETTRADE overview and data pages are rejected while real articles and official announcements remain', () => {
  const date = new Date().toISOString();
  const overview = {
    title: 'LHHOTEL - ภาพรวม - Settrade', sourceName: 'Settrade', source: 'settrade',
    url: 'https://www.settrade.com/th/equities/quote/LHHOTEL/overview', pubDate: date
  };
  assert.deepEqual(classifyNewsItem(overview), {
    accepted: false, classification: 'NON_NEWS', reason: 'SETTRADE_DATA_PAGE_TITLE'
  });
  assert.equal(classifyNewsItem({
    ...overview,
    title: 'LHHOTEL แจ้งผลการดำเนินงานล่าสุด',
    url: 'https://news.google.com/rss/articles/opaque',
    resolvedUrl: 'https://www.settrade.com/th/equities/quote/LHHOTEL/financials'
  }).reason, 'SETTRADE_NON_ARTICLE_PATH');
  assert.equal(classifyNewsItem({
    ...overview,
    title: 'TFEX จากเรื่องไกลตัว สู่เครื่องมือที่นักลงทุนควรรู้จัก',
    url: 'https://www.settrade.com/th/news-and-articles/articles/778-piyaporn-tfex-from-distant-to-essential'
  }).accepted, true);
  assert.equal(classifyNewsItem({
    ...overview,
    title: 'รายงานการจำหน่ายหุ้นที่ซื้อคืนของบริษัทจดทะเบียน',
    url: 'https://www.settrade.com/th/news-and-articles/news/106526600?symbol=A5'
  }).accepted, true);
  assert.equal(classifyNewsItem({
    ...overview,
    title: 'บริษัทจดทะเบียนชี้แจงข้อมูลสำคัญต่อตลาดหลักทรัพย์',
    sourceName: 'ตลาดหลักทรัพย์แห่งประเทศไทย',
    url: 'https://www.set.or.th/th/market/news-and-alert/newsdetails?id=12345'
  }).accepted, true);
});

test('live News API omits opaque SETTRADE overview results before UI delivery', async () => {
  const recent = new Date().toUTCString();
  const body = rss([
    {
      title: 'LHHOTEL - ภาพรวม - Settrade',
      url: 'https://news.google.com/rss/articles/opaque-overview',
      pubDate: recent,
      sourceName: 'Settrade'
    },
    {
      title: 'บริษัทจดทะเบียนแจ้งความคืบหน้าโครงการลงทุนสำคัญ - SET',
      url: 'https://news.google.com/rss/articles/genuine-announcement',
      pubDate: recent,
      sourceName: 'ตลาดหลักทรัพย์แห่งประเทศไทย',
      snippet: 'บริษัทเปิดเผยรายละเอียดโครงการและกำหนดการต่อตลาดหลักทรัพย์'
    }
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getNews();
  assert.deepEqual(result.items.map(item => item.title), [
    'บริษัทจดทะเบียนแจ้งความคืบหน้าโครงการลงทุนสำคัญ - SET'
  ]);
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
