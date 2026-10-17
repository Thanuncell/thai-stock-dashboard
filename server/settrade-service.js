'use strict';

const {
  marketHtmlText,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr
} = require('../lib/settrade-parser');
const { PROVIDER_POLICIES, createMemoryCache } = require('./reliability');

const PATHS = Object.freeze([
  '/th/equities/market-summary/overview?market=SET',
  '/th/equities/market-data/nvdr/value',
  '/th/equities/market-data/historical-report/investor-type',
  '/th/derivatives/overview',
  '/th/equities/market-summary/top-ranking/most-active-value'
]);

function createSettradeService({ fetchImpl = globalThis.fetch, now = Date.now, cache = createMemoryCache({ maxEntries: 2, now }) } = {}) {
  let lastData = null;

  async function fetchPage(pathname) {
    const response = await fetchImpl(`https://www.settrade.com${pathname}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SETscope/1.0; public market overview)',
        accept: 'text/html'
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Error(`SETTRADE HTTP ${response.status}`);
    return response.text();
  }

  async function getOverview(force = false) {
    return cache.get('settrade:overview', PROVIDER_POLICIES.settrade, async () => {
      const pages = await Promise.allSettled(PATHS.map(fetchPage));
      if (pages.every(page => page.status === 'rejected')) throw Error('SETTRADE upstream unavailable');
      const htmlAt = index => pages[index]?.status === 'fulfilled' ? pages[index].value : '';
      const overview = parseSettradeMarket(htmlAt(0));
      const nvdr = parseSettradeNvdr(htmlAt(1));
      const foreign = parseSettradeForeign(htmlAt(2));
      const tfexHtml = htmlAt(3);
      const nuxtIndex = tfexHtml.indexOf('window.__NUXT__');
      const tfexText = marketHtmlText(tfexHtml.slice(0, nuxtIndex > 0 ? nuxtIndex : undefined));
      const activeHtml = htmlAt(4);
      const data = {
        ...overview,
        nvdr,
        foreign,
        tfex: { available: /Total Market\s*[^-]*\d/i.test(tfexText), delayMinutes: 15 },
        activeValue: [],
        source: 'SETTRADE',
        fetchedAt: new Date().toISOString(),
        marketDate: foreign.date || null,
        errors: pages.map((page, index) => page.status === 'rejected' ? PATHS[index] : null).filter(Boolean),
        links: {
          overview: 'https://www.settrade.com/th/equities/market-summary/overview?market=SET',
          activeValue: 'https://www.settrade.com/th/equities/market-summary/top-ranking/most-active-value',
          nvdr: 'https://www.settrade.com/th/equities/market-data/nvdr/value',
          investorType: 'https://www.settrade.com/th/equities/market-data/historical-report/investor-type',
          tfex: 'https://www.settrade.com/th/derivatives/overview'
        },
        activeValueStatus: activeHtml && activeHtml.includes('table-placeholder')
          ? 'SETTRADE โหลดรายการผ่านตารางแบบโต้ตอบ โปรดเปิดดูต้นทาง'
          : 'ไม่สามารถอ่านตารางจัดอันดับจากต้นทางได้'
      };
      if (lastData) {
        for (const key of ['indices', 'breadth', 'closeSummary', 'nvdr', 'foreign']) {
          const empty = key === 'closeSummary'
            ? !data[key]
            : key === 'nvdr'
              ? Object.values(data[key] || {}).every(value => value == null)
              : key === 'foreign'
                ? data[key].netMillion == null
                : !data[key]?.length;
          if (empty) data[key] = lastData[key];
        }
      }
      lastData = data;
      return data;
    }, { force });
  }

  return { getOverview };
}

module.exports = { PATHS, createSettradeService };
