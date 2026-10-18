'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BROKER_FIRMS, decorateBrokerAttribution, matchBrokerFirms } = require('../lib/broker-news');
const { createNewsService } = require('../server/news-service');

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
