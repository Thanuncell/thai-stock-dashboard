'use strict';

const {
  marketHtmlText,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr
} = require('../lib/settrade-parser');

const PATHS = Object.freeze([
  '/th/equities/market-summary/overview?market=SET',
  '/th/equities/market-data/nvdr/value',
  '/th/equities/market-data/historical-report/investor-type',
  '/th/derivatives/overview',
  '/th/equities/market-summary/top-ranking/most-active-value'
]);

function createSettradeService({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let overviewCache = { data: null, expiresAt: 0, pending: null };

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
    if (!force && overviewCache.data && now() < overviewCache.expiresAt) {
      return { ...overviewCache.data, cached: true };
    }
    if (overviewCache.pending) return overviewCache.pending;
    overviewCache.pending = (async () => {
      const pages = await Promise.allSettled(PATHS.map(fetchPage));
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
      if (overviewCache.data) {
        for (const key of ['indices', 'breadth', 'closeSummary', 'nvdr', 'foreign']) {
          const empty = key === 'closeSummary'
            ? !data[key]
            : key === 'nvdr'
              ? Object.values(data[key] || {}).every(value => value == null)
              : key === 'foreign'
                ? data[key].netMillion == null
                : !data[key]?.length;
          if (empty) data[key] = overviewCache.data[key];
        }
      }
      overviewCache.data = data;
      overviewCache.expiresAt = now() + 60000;
      return data;
    })().catch(error => {
      if (overviewCache.data) {
        return { ...overviewCache.data, cached: true, stale: true, errors: [error.message] };
      }
      throw error;
    }).finally(() => { overviewCache.pending = null; });
    return overviewCache.pending;
  }

  return { getOverview };
}

module.exports = { PATHS, createSettradeService };
