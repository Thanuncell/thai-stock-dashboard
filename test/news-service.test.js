'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const navigationPageFixtures = require('./fixtures/news-quality-navigation-pages.json');

const { BROKER_FIRMS, decorateBrokerAttribution, matchBrokerFirms } = require('../lib/broker-news');
const { createNewsService } = require('../server/news-service');
const { NEWS_QUALITY_DECISION, classifyNewsItem } = require('../lib/news-quality');

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
    accepted: false, decision: 'REJECT', classification: 'QUOTE_DATA_OVERVIEW', reason: 'SETTRADE_DATA_PAGE_TITLE'
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

test('three-state news quality rejects deterministic reference pages generically', () => {
  const date = new Date().toISOString();
  const rejected = [
    {
      title: 'BONDUS01 - Settrade', sourceName: 'Settrade', source: 'settrade',
      url: 'https://news.google.com/rss/articles/bondus01-reference', pubDate: date,
      classification: 'INSTRUMENT_REFERENCE'
    },
    {
      title: 'ReportEGPRP0001 - Bank of Thailand', sourceName: 'Bank of Thailand', source: 'official',
      url: 'https://news.google.com/rss/articles/bot-report-reference', pubDate: date,
      classification: 'REPORT_REFERENCE'
    },
    {
      title: 'S50H27P1060 - ปฏิทินการซื้อขาย - Settrade', sourceName: 'Settrade', source: 'settrade',
      url: 'https://news.google.com/rss/articles/settrade-calendar', pubDate: date,
      classification: 'TRADING_CALENDAR'
    },
    {
      title: 'METCO - ภาพรวมบริษัท - Settrade', sourceName: 'Settrade', source: 'settrade',
      url: 'https://news.google.com/rss/articles/metco-overview', pubDate: date,
      classification: 'QUOTE_DATA_OVERVIEW'
    },
    {
      title: 'HUMAN - ภาพรวมบริษัท - SETTRADE.COM', sourceName: 'SETTRADE.COM', source: 'other',
      url: 'https://news.google.com/rss/articles/human-overview', pubDate: date,
      classification: 'QUOTE_DATA_OVERVIEW'
    },
    {
      title: 'S50V26P990 - ปฏิทินการซื้อขาย - SETTRADE.COM', sourceName: 'SETTRADE.COM', source: 'other',
      url: 'https://news.google.com/rss/articles/settrade-com-calendar', pubDate: date,
      classification: 'TRADING_CALENDAR'
    },
    {
      title: 'ข่าวล่าสุด', sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', source: 'kaohoon',
      url: 'https://www.kaohoon.com/category/news/page/7712/', pubDate: date,
      classification: 'PAGINATION'
    }
  ];

  assert.equal(NEWS_QUALITY_DECISION.REJECT, 'REJECT');
  for (const item of rejected) {
    const result = classifyNewsItem(item);
    assert.equal(result.accepted, false, item.title);
    assert.equal(result.decision, NEWS_QUALITY_DECISION.REJECT, item.title);
    assert.equal(result.classification, item.classification, item.title);
  }
});

test('navigation and reference landing pages are rejected without hiding genuine news', async () => {
  const pubDate = new Date().toUTCString();
  for (const item of navigationPageFixtures.rejected) {
    const result = classifyNewsItem({ ...item, pubDate });
    assert.equal(result.accepted, false, item.title);
    assert.equal(result.decision, NEWS_QUALITY_DECISION.REJECT, item.title);
    assert.equal(result.classification, item.classification, item.title);
  }
  for (const item of navigationPageFixtures.accepted) {
    assert.equal(classifyNewsItem({ ...item, pubDate }).accepted, true, item.title);
  }

  const body = rss([
    ...navigationPageFixtures.rejected.map(item => ({ ...item, pubDate })),
    ...navigationPageFixtures.accepted.map(item => ({ ...item, pubDate }))
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getNews();
  assert.deepEqual(
    result.items.map(item => item.title).sort(),
    navigationPageFixtures.accepted.map(item => item.title).sort()
  );
});

test('short or unusual headlines use article evidence instead of title length alone', () => {
  const date = new Date().toISOString();
  const accepted = [
    {
      title: 'Force Majeure', sourceName: 'efinanceThai', source: 'efinance',
      url: 'https://news.google.com/rss/articles/efinance-force-majeure', pubDate: date,
      snippet: 'บทความอธิบายเหตุสุดวิสัยและผลกระทบต่อบริษัทจดทะเบียน'
    },
    {
      title: 'ไทย เยอรมนี', sourceName: 'efinanceThai', source: 'efinance',
      url: 'https://www.efinancethai.com/news/short-thai-germany', pubDate: date,
      snippet: 'รายงานความร่วมมือทางเศรษฐกิจระหว่างไทยและเยอรมนี'
    },
    {
      title: 'บัตรเติมเงิน', sourceName: 'efinanceThai', source: 'efinance',
      url: 'https://www.efinancethai.com/article/prepaid-card', pubDate: date,
      snippet: 'ข่าวธุรกิจเกี่ยวกับบริการบัตรเติมเงินและแผนการดำเนินงาน'
    },
    {
      title: 'PTT', sourceName: 'สำนักข่าวท้องถิ่น', source: 'other',
      url: 'https://news.google.com/rss/articles/opaque-short-title', pubDate: date,
      snippet: ''
    }
  ];

  const results = accepted.map(classifyNewsItem);
  assert.deepEqual(results.slice(0, 3).map(result => result.decision), [
    NEWS_QUALITY_DECISION.ACCEPT,
    NEWS_QUALITY_DECISION.ACCEPT,
    NEWS_QUALITY_DECISION.ACCEPT
  ]);
  assert.equal(results[3].decision, NEWS_QUALITY_DECISION.AMBIGUOUS);
  assert.ok(results.every(result => result.accepted), 'title shape alone must not discard a potentially genuine article');
});

test('official announcements and genuine shareholder articles remain accepted', () => {
  const date = new Date().toISOString();
  const controls = [
    {
      title: 'บริษัทจดทะเบียนแจ้งมติที่ประชุมผู้ถือหุ้น',
      sourceName: 'ตลาดหลักทรัพย์แห่งประเทศไทย', source: 'settrade',
      url: 'https://www.set.or.th/th/market/news-and-alert/newsdetails?id=12345', pubDate: date
    },
    {
      title: 'ผู้ถือหุ้นอนุมัติแผนลงทุนใหม่ของบริษัท',
      sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', source: 'kaohoon',
      url: 'https://www.kaohoon.com/news/999999', pubDate: date,
      snippet: 'ที่ประชุมผู้ถือหุ้นอนุมัติวงเงินและกรอบเวลาดำเนินโครงการ'
    }
  ];
  const results = controls.map(classifyNewsItem);
  assert.ok(results.every(result => result.accepted));
  assert.ok(results.every(result => result.decision === NEWS_QUALITY_DECISION.ACCEPT));
  assert.equal(results[0].classification, 'OFFICIAL_ANNOUNCEMENT');
});

test('generic page classification rejects listings, auth, data and ownership pages without hiding real news', () => {
  const date = new Date().toISOString();
  const rejected = [
    {
      title: 'ข่าว - Page 7712 of 7712 - ข่าวหุ้นธุรกิจออนไลน์ - ข่าวหุ้นธุรกิจออนไลน์',
      source: 'kaohoon', sourceName: 'ข่าวหุ้นธุรกิจออนไลน์',
      url: 'https://news.google.com/rss/articles/opaque-kaohoon-page', pubDate: date,
      snippet: 'ข่าว - Page 7712 of 7712 - ข่าวหุ้นธุรกิจออนไลน์'
    },
    { title: 'รวมข่าวหุ้นไทยล่าสุด', url: 'https://www.kaohoon.com/page/7712/', sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', pubDate: date },
    { title: 'ข่าวล่าสุด', url: 'https://www.kaohoon.com/category/news?page=8', sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', pubDate: date },
    { title: 'Reset Password', url: 'https://www.set.or.th/th/account/reset-password', sourceName: 'SET', pubDate: date },
    { title: 'ข้อมูลผู้ถือหุ้นของบริษัทจดทะเบียน', url: 'https://www.set.or.th/th/market/product/stock/quote/PTT/major-shareholders', sourceName: 'SET', pubDate: date },
    { title: 'BCP - ข้อมูลผู้ถือหุ้น - Settrade', url: 'https://news.google.com/rss/articles/opaque-settrade-shareholders', sourceName: 'Settrade', source: 'settrade', pubDate: date },
    { title: 'ข้อมูลทางการเงินของบริษัทจดทะเบียน', url: 'https://news.google.com/rss/articles/opaque-set-data', resolvedUrl: 'https://www.set.or.th/th/market/product/stock/quote/PTT/financials', sourceName: 'SET', pubDate: date },
    { title: 'ข้อมูลบริษัทจดทะเบียน', url: 'https://www.set.or.th/th/market/product/stock/quote/PTT/profile', sourceName: 'SET', pubDate: date },
    { title: 'บริการสำหรับผู้ลงทุน', url: 'https://www.set.or.th/th/services/investors', sourceName: 'SET', pubDate: date },
    { title: 'ข่าวล่าสุด', url: 'https://news.google.com/rss/articles/generic-title', sourceName: 'Example', pubDate: date },
    { title: 'mmxx-ventures - Thunhoon', url: 'https://news.google.com/rss/articles/opaque-thunhoon-slug', sourceName: 'Thunhoon', pubDate: date }
  ];
  assert.deepEqual(rejected.map(item => classifyNewsItem(item).accepted), Array(rejected.length).fill(false));

  const accepted = [
    {
      title: 'ผู้ถือหุ้นอนุมัติแผนลงทุนใหม่ของบริษัท', sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', source: 'kaohoon',
      url: 'https://www.kaohoon.com/news/999999', pubDate: date,
      snippet: 'ที่ประชุมผู้ถือหุ้นอนุมัติแผนลงทุน พร้อมเปิดเผยวงเงินและกรอบเวลาดำเนินการ'
    },
    {
      title: 'บริษัทจดทะเบียนแจ้งมติที่ประชุมผู้ถือหุ้น', sourceName: 'ตลาดหลักทรัพย์แห่งประเทศไทย', source: 'settrade',
      url: 'https://www.set.or.th/th/market/news-and-alert/newsdetails?id=12345', pubDate: date
    },
    {
      title: 'บริษัทเปิดเผยผลประกอบการไตรมาสล่าสุด', sourceName: 'Thunhoon', source: 'thunhoon',
      url: 'https://thunhoon.com/article/123456', pubDate: date
    },
    {
      title: 'เศรษฐกิจไทยฟื้นตัวตามการส่งออก', sourceName: 'InfoQuest', source: 'infoquest',
      url: 'https://news.google.com/rss/articles/infoquest-genuine', pubDate: date,
      snippet: 'รายงานตัวเลขส่งออกและปัจจัยที่มีผลต่อแนวโน้มเศรษฐกิจไทย'
    },
    {
      title: 'ตลาดหุ้นไทยปิดบวกตามแรงซื้อหุ้นขนาดใหญ่', sourceName: 'efinanceThai', source: 'efinance',
      url: 'https://news.google.com/rss/articles/efinance-genuine', pubDate: date,
      snippet: 'สรุปภาวะตลาดพร้อมมูลค่าซื้อขายและปัจจัยที่นักลงทุนติดตาม'
    }
  ];
  assert.deepEqual(accepted.map(item => classifyNewsItem(item).accepted), Array(accepted.length).fill(true));
  assert.equal(classifyNewsItem(accepted[1]).classification, 'OFFICIAL_ANNOUNCEMENT');
});

test('live News API removes cross-source non-article records while keeping genuine headlines', async () => {
  const recent = new Date().toUTCString();
  const body = rss([
    { title: 'ข่าว - Page 7712 of 7712 - ข่าวหุ้นธุรกิจออนไลน์ - ข่าวหุ้นธุรกิจออนไลน์', url: 'https://news.google.com/rss/articles/kaohoon-list', pubDate: recent, sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', snippet: 'ข่าว - Page 7712 of 7712' },
    { title: 'mmxx-ventures - Thunhoon', url: 'https://news.google.com/rss/articles/thunhoon-slug', pubDate: recent, sourceName: 'Thunhoon' },
    { title: 'BCP - ข้อมูลผู้ถือหุ้น - Settrade', url: 'https://news.google.com/rss/articles/settrade-shareholders', pubDate: recent, sourceName: 'Settrade' },
    { title: 'ผู้ถือหุ้นอนุมัติแผนลงทุนใหม่ของบริษัท', url: 'https://news.google.com/rss/articles/genuine-shareholder-news', pubDate: recent, sourceName: 'ข่าวหุ้นธุรกิจออนไลน์', snippet: 'ที่ประชุมอนุมัติวงเงินและกรอบเวลาดำเนินการของโครงการใหม่' }
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getNews();
  assert.deepEqual(result.items.map(item => item.title), ['ผู้ถือหุ้นอนุมัติแผนลงทุนใหม่ของบริษัท']);
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

test('Watchlist News filters and deduplicates before its 30-item pagination dataset cap', async () => {
  const recent = new Date().toUTCString();
  const accepted = Array.from({ length: 30 }, (_, index) => ({
    title: `PTT แจ้งความคืบหน้าโครงการลำดับ ${index + 1}`,
    url: `https://news.google.com/articles/watchlist-${index + 1}`,
    pubDate: recent,
    sourceName: 'สำนักข่าวท้องถิ่น',
    snippet: 'บริษัทเปิดเผยรายละเอียดโครงการและกรอบเวลาดำเนินงาน'
  }));
  const body = rss([
    { title: 'PTT-company-profile - Example', url: 'https://news.google.com/articles/profile-before-cap', pubDate: recent, sourceName: 'Example' },
    accepted[0],
    { ...accepted[0], url: `${accepted[0].url}?utm_source=duplicate` },
    ...accepted.slice(1),
    { title: 'AOT เปิดเส้นทางใหม่', url: 'https://news.google.com/articles/not-in-watchlist', pubDate: recent, sourceName: 'Example' }
  ]);
  const service = createNewsService({ fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await service.getWatchlistNews([{ symbol: 'PTT', name: 'ปตท.' }]);

  assert.equal(result.items.length, 30);
  assert.equal(new Set(result.items.map(item => item.url.replace(/\?.*$/, ''))).size, 30);
  assert.ok(result.items.every(item => item.matchedSymbols.includes('PTT')));
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
