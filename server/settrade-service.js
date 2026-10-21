'use strict';

const {
  marketHtmlText,
  parseSettradeActiveValue,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr,
  parseSettradeTfex
} = require('../lib/settrade-parser');
const { createMarketOverviewSafety } = require('./market-overview-safety');
const { PROVIDER_POLICIES, createMemoryCache } = require('./reliability');

const PATHS = Object.freeze([
  '/th/equities/market-summary/overview?market=SET',
  '/th/equities/market-data/nvdr/value',
  '/th/equities/market-data/historical-report/investor-type',
  '/th/derivatives/overview',
  '/th/equities/market-summary/top-ranking/most-active-value'
]);

const LINKS = Object.freeze({
  overview: `https://www.settrade.com${PATHS[0]}`,
  nvdr: `https://www.settrade.com${PATHS[1]}`,
  investorType: `https://www.settrade.com${PATHS[2]}`,
  tfex: `https://www.settrade.com${PATHS[3]}`,
  activeValue: `https://www.settrade.com${PATHS[4]}`
});

const EMPTY_NVDR = Object.freeze({ marketMillion: null, nvdrMillion: null, ratioPercent: null });
const EMPTY_FOREIGN = Object.freeze({ date: '', name: 'นักลงทุนต่างประเทศ', buyMillion: null, sellMillion: null, netMillion: null });
const EMPTY_TFEX = Object.freeze({
  available: false,
  delayMinutes: 15,
  totalVolume: null,
  openInterest: null,
  marketDate: '',
  investorType: [],
  topVolume: []
});

function pageIdentity(index, html) {
  const text = marketHtmlText(String(html || '').slice(0, 180_000));
  if (index === 0) return /ดัชนี/i.test(text) && /\bSET\b/i.test(text) && /\bmai\b/i.test(text);
  if (index === 1) return /NVDR/i.test(text) && /มูลค่าการซื้อขาย/i.test(text);
  if (index === 2) return /นักลงทุนต่างประเทศ/i.test(text) && /มูลค่าซื้อ|มูลค่าขาย/i.test(text);
  if (index === 3) return /อนุพันธ์|Derivatives|TFEX/i.test(text) && /Total Market|ภาพรวมตลาด/i.test(text);
  if (index === 4) return /Most Active Value/i.test(text) && /ชื่อย่อหลักทรัพย์/i.test(text);
  return false;
}

function hasNumber(value) {
  return Object.values(value || {}).some(item => Number.isFinite(item));
}

function createSettradeService({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cache = createMemoryCache({ maxEntries: 2, now }),
  safety = createMarketOverviewSafety({ fetchImpl, now }),
  fieldLkgTtlMs = 30 * 60 * 1000
} = {}) {
  const lastKnownGood = new Map();

  async function fetchPage(pathname) {
    const result = await safety.request(`https://www.settrade.com${pathname}`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; SETscope/1.0; public market overview)',
        accept: 'text/html'
      },
      signal: AbortSignal.timeout(10000)
    });
    return result.text;
  }

  function field(name, value, valid, fetchedAt, reason = null) {
    if (valid) {
      lastKnownGood.set(name, { value, fetchedAt, savedAt: now() });
      return {
        value,
        status: { state: 'PASS', source: 'SETTRADE', asOf: fetchedAt, delayed: true, reason: null }
      };
    }
    const previous = lastKnownGood.get(name);
    if (previous && now() - previous.savedAt <= fieldLkgTtlMs) {
      return {
        value: previous.value,
        status: { state: 'LKG', source: 'SETTRADE', asOf: previous.fetchedAt, delayed: true, stale: true, reason }
      };
    }
    return {
      value,
      status: { state: 'UNAVAILABLE', source: 'SETTRADE', asOf: null, delayed: true, reason }
    };
  }

  async function loadOverview() {
    const pages = [];
    const pageErrors = [];
    for (let index = 0; index < PATHS.length; index += 1) {
      try {
        const html = await fetchPage(PATHS[index]);
        if (!pageIdentity(index, html)) throw Error('PAGE_IDENTITY_MISMATCH');
        pages[index] = html;
      } catch (error) {
        pages[index] = '';
        pageErrors[index] = error;
      }
    }

    const fetchedAt = new Date(now()).toISOString();
    const overview = pages[0] ? parseSettradeMarket(pages[0]) : { indices: [], breadth: [], closeSummary: '' };
    const nvdr = pages[1] ? parseSettradeNvdr(pages[1]) : { ...EMPTY_NVDR };
    const foreign = pages[2] ? parseSettradeForeign(pages[2]) : { ...EMPTY_FOREIGN };
    const tfex = pages[3] ? parseSettradeTfex(pages[3]) : { ...EMPTY_TFEX };
    const active = pages[4] ? parseSettradeActiveValue(pages[4]) : { items: [], asOf: '' };

    const indicesField = field('indices', overview.indices, overview.indices.some(item => item.symbol === 'SET' && Number.isFinite(item.last)), fetchedAt, pageErrors[0]?.message || 'SCHEMA_UNAVAILABLE');
    const breadthField = field('breadth', overview.breadth, overview.breadth.length > 0, fetchedAt, pageErrors[0]?.message || 'SCHEMA_UNAVAILABLE');
    const closeField = field('closeSummary', overview.closeSummary, Boolean(overview.closeSummary), fetchedAt, pageErrors[0]?.message || 'NOT_PUBLISHED');
    const nvdrField = field('nvdr', nvdr, hasNumber(nvdr), fetchedAt, pageErrors[1]?.message || 'SCHEMA_UNAVAILABLE');
    const foreignField = field('foreign', foreign, hasNumber(foreign), fetchedAt, pageErrors[2]?.message || 'SCHEMA_UNAVAILABLE');
    const tfexField = field('tfex', tfex, Boolean(tfex.available), fetchedAt, pageErrors[3]?.message || 'NO_STRUCTURED_DATA');
    const activeField = field('activeValue', active.items, active.items.length > 0, active.asOf || fetchedAt, pageErrors[4]?.message || 'NO_STRUCTURED_DATA');

    const fieldStatus = {
      indices: indicesField.status,
      breadth: breadthField.status,
      closeSummary: closeField.status,
      nvdr: nvdrField.status,
      foreign: foreignField.status,
      tfex: tfexField.status,
      activeValue: activeField.status
    };
    const errors = pageErrors.map((error, index) => error ? `${PATHS[index]}: ${error.code || error.message}` : null).filter(Boolean);
    const states = Object.values(fieldStatus).map(status => status.state);
    const hasUsableField = states.some(state => state === 'PASS' || state === 'LKG');
    const partial = errors.length > 0 || states.some(state => state !== 'PASS');
    const safetyStatus = safety.snapshot();
    const dataState = !hasUsableField ? 'unavailable' : states.some(state => state === 'LKG') ? 'stale' : partial ? 'partial' : 'delayed';

    return {
      indices: indicesField.value,
      breadth: breadthField.value,
      closeSummary: closeField.value,
      nvdr: nvdrField.value,
      foreign: foreignField.value,
      tfex: tfexField.value,
      activeValue: activeField.value,
      source: 'SETTRADE',
      fetchedAt,
      asOf: null,
      delayed: true,
      stale: dataState === 'stale',
      partial,
      dataState,
      marketDate: foreignField.value?.date || tfexField.value?.marketDate || null,
      errors,
      links: LINKS,
      fieldStatus,
      sourceStatus: { settrade: safetyStatus },
      activeValueStatus: activeField.value.length
        ? `ข้อมูลล่าสุด ${activeField.value.length} รายการจาก SETTRADE`
        : activeField.status.state === 'LKG'
          ? 'ใช้รายการจัดอันดับที่บันทึกล่าสุด'
          : 'ต้นทางยังไม่ส่งตารางจัดอันดับแบบอ่านได้'
    };
  }

  async function getOverview(_force = false) {
    return cache.get('settrade:overview', PROVIDER_POLICIES.settrade, loadOverview);
  }

  return { getOverview, safety };
}

module.exports = { EMPTY_FOREIGN, EMPTY_NVDR, EMPTY_TFEX, LINKS, PATHS, createSettradeService, pageIdentity };
