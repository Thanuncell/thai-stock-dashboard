'use strict';

const {
  classifySettradeParse,
  marketHtmlText,
  parseSettradeActiveValue,
  parseSettradeForeign,
  parseSettradeMarket,
  parseSettradeNvdr
} = require('../lib/settrade-parser');
const { createMarketOverviewSafety, explicitAccessDenial } = require('./market-overview-safety');
const { AOM_UNIT_BASIS, selectMostActiveResponse, isRenderableActiveRow, parseHydratedMostActive } = require('../lib/settrade-active-hydration');
const { assessActiveSession, sourceMarketTime } = require('./market-overview-session');
const { sourceMarketDate } = require('./market-overview-time');
const { createTfexHomeSource } = require('./tfex-home-source');
const { TFEX_HOME_URL } = require('./tfex-home-parser');
const { PROVIDER_POLICIES, createMemoryCache } = require('./reliability');

const PATHS = Object.freeze([
  '/th/equities/market-summary/overview?market=SET',
  '/th/equities/market-data/nvdr/value',
  '/th/equities/market-data/historical-report/investor-type',
  '/th/home',
  '/th/equities/market-summary/top-ranking/most-active-value'
]);

const LINKS = Object.freeze({
  overview: `https://www.settrade.com${PATHS[0]}`,
  nvdr: `https://www.settrade.com${PATHS[1]}`,
  investorType: `https://www.settrade.com${PATHS[2]}`,
  tfex: TFEX_HOME_URL,
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
  if (index === 0) return /สรุปภาวะตลาด|ข้อมูลดัชนี|ดัชนีตลาด/i.test(text) && /\bSET\b/i.test(text);
  if (index === 1) return /NVDR/i.test(text) && /มูลค่า(?:การ)?ซื้อขาย|สัดส่วน/i.test(text);
  if (index === 2) return /กลุ่มนักลงทุน|นักลงทุนต่างประเทศ|นักลงทุนต่างชาติ/i.test(text) && /(?:มูลค่า)?ซื้อ|(?:มูลค่า)?ขาย|สุทธิ/i.test(text);
  if (index === 3) return /อนุพันธ์|Derivatives|TFEX/i.test(text) && /Total Market|ภาพรวมตลาด|ประเภทผู้ลงทุน|ปริมาณซื้อขายสูงสุด/i.test(text);
  if (index === 4) {
    // Strip complete script bodies before truncating so a long state script
    // cannot masquerade as visible page identity when its closing tag is cut.
    const activeText = marketHtmlText(String(html || '').replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ').slice(0, 180_000));
    if (explicitAccessDenial(html) || !/Most Active Value|มูลค่าการซื้อขายสูงสุด/i.test(activeText)) return false;
    return /ชื่อย่อหลักทรัพย์|หลักทรัพย์|Symbol|อันดับ|ลำดับ/i.test(activeText)
      || parseHydratedMostActive(html).metadataValid === true;
  }
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
  fieldLkgTtlMs = 30 * 60 * 1000,
  tfexSource = createTfexHomeSource({ fetchImpl, now,
    enabled: process.env.MARKET_OVERVIEW_SCRAPER_ENABLED !== 'false' && safety.snapshot().state !== 'DISABLED' })
} = {}) {
  const lastKnownGood = new Map();

  function unavailableTfex(reason = 'ACQUISITION_GAP') {
    return { value: { ...EMPTY_TFEX }, status: { state: 'UNAVAILABLE', source: 'TFEX', sourceLabel: 'TFEX Official',
      sourceUrl: TFEX_HOME_URL, asOf: null, delayed: true, reason, sourceUpdatedAt: null, fetchedAt: null,
      freshness: 'UNVERIFIED', freshnessVerified: false,
      volumeEffectiveTime: null, openInterestEffectiveTime: null, tradingSessionDate: null, openInterestReference: null } };
  }

  function tfexFieldSnapshot(snapshot) {
    const value = snapshot?.value, status = snapshot?.status;
    const validCount = number => number === null || (Number.isSafeInteger(number) && number >= 0);
    if (!value || !status || status.source !== 'TFEX' || status.sourceUrl !== TFEX_HOME_URL
      || !['PASS', 'LKG', 'UNAVAILABLE'].includes(status.state)
      || !validCount(value.totalVolume) || !validCount(value.openInterest)
      || value.available !== (value.totalVolume !== null || value.openInterest !== null)
      || value.available !== (status.state !== 'UNAVAILABLE')
      || value.marketDate !== '' || status.asOf !== null
      || (status.state !== 'UNAVAILABLE' && (!sourceMarketTime(status.sourceUpdatedAt) || !Number.isFinite(Date.parse(status.fetchedAt))))) {
      return unavailableTfex('INVALID_DATA');
    }
    return { value, status };
  }

  function tfexSourceStatus() {
    try { return tfexSource.snapshot(); }
    catch (_) { return { source: 'TFEX', sourceUrl: TFEX_HOME_URL, state: 'MANUAL_REVIEW_REQUIRED', reason: 'SOURCE_STATUS_UNAVAILABLE' }; }
  }

  function fieldErrors(fieldStatus) {
    const paths = { indices: PATHS[0], breadth: PATHS[0], closeSummary: PATHS[0], nvdr: PATHS[1],
      foreign: PATHS[2], tfex: TFEX_HOME_URL, activeValue: PATHS[4] };
    return Object.entries(fieldStatus).flatMap(([name, status]) => {
      if (status.state === 'PASS' && !status.partial) return [];
      const reason = status.reason || status.coverageReason || (status.partial ? 'PARTIAL_DATA' : null);
      return reason ? [`${paths[name]}: ${name} ${reason}`] : [];
    });
  }

  function refreshedErrors(value, fieldStatus) {
    const previousFields = new Set(fieldErrors(value.fieldStatus));
    const retained = (value.errors || []).filter(error => !previousFields.has(error));
    return [...new Set([...retained, ...fieldErrors(fieldStatus)])];
  }

  function overviewState(fieldStatus, errors, cacheStale = false) {
    const states = Object.values(fieldStatus).map(status => status.state);
    const stale = cacheStale || states.includes('LKG');
    const partial = errors.length > 0 || states.some(state => state !== 'PASS') || Object.values(fieldStatus).some(status => status.partial);
    const usable = states.some(state => state === 'PASS' || state === 'LKG');
    return { stale, partial, dataState: !usable ? 'unavailable' : stale ? 'stale' : partial ? 'partial' : 'delayed' };
  }

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

  function field(name, value, valid, asOf, reason = null, details = {}) {
    const status = (state, record, failure = null) => ({
      state, source: 'SETTRADE', asOf: record.asOf, delayed: true,
      ...(state === 'LKG' ? { stale: true } : {}), reason: failure,
      ...(record.reportedAsOf ? { reportedAsOf: record.reportedAsOf } : {}),
      ...(name === 'activeValue' ? { fetchedAt: record.fetchedAt || null,
        sourceUpdatedAt: sourceMarketTime(record.reportedAsOf), sessionContext: record.sessionContext || null,
        sessionContextBasis: 'SNAPSHOT_ELIGIBILITY_GUARD',
        tradingSession: null, tradingSessionDate: null, marketEffectiveTime: null,
        sourceRankingPeriod: record.sourceRankingPeriod ?? null, quantityStatus: record.quantityStatus || 'UNVERIFIED',
        quantityBasis: record.quantityBasis || null,
        freshness: state === 'LKG' ? 'LKG' : state === 'PASS' ? record.sessionContext : 'UNVERIFIED',
        freshnessVerified: false,
        sourceTimeAgeMs: sourceMarketTime(record.reportedAsOf) ? now() - Date.parse(sourceMarketTime(record.reportedAsOf)) : null } : {}),
      ...(record.partial ? { partial: true, coverageReason: record.coverageReason } : {})
    });
    if (valid) {
      const record = { value, asOf, savedAt: now(), reportedAsOf: details.reportedAsOf || null,
        fetchedAt: new Date(now()).toISOString(), sessionContext: details.sessionContext || null,
        sourceRankingPeriod: details.sourceRankingPeriod ?? null, quantityStatus: details.quantityStatus || null,
        quantityBasis: details.quantityBasis || null,
        partial: details.partial === true, coverageReason: details.coverageReason || null };
      lastKnownGood.set(name, record);
      return { value, status: status('PASS', record) };
    }
    const previous = lastKnownGood.get(name);
    if (previous && now() >= previous.savedAt && now() - previous.savedAt <= fieldLkgTtlMs
      && (name !== 'activeValue' || (sourceMarketTime(previous.reportedAsOf)
        && Date.parse(sourceMarketTime(previous.reportedAsOf)) <= now()))) {
      return {
        value: previous.value,
        status: status('LKG', previous, reason)
      };
    }
    return {
      value,
      status: status('UNAVAILABLE', { asOf: null, reportedAsOf: details.reportedAsOf }, reason)
    };
  }

  function activeCaption(activeField, session = {}, parsedRows = 0) {
    const reported = activeField.status.reportedAsOf;
    const time = reported ? ` · เวลาที่ต้นทางรายงาน ${reported} · เวลาตลาดยังไม่ยืนยัน` : '';
    const receipt = activeField.status.fetchedAt ? ` · รับข้อมูลเมื่อ ${activeField.status.fetchedAt}` : '';
    const context = `${receipt} · Trading Session ยังไม่ยืนยัน${activeField.status.quantityStatus === 'UNVERIFIED' ? ' · หน่วยมูลค่า/ปริมาณยังไม่ยืนยัน' : ''}`;
    if (activeField.status.state === 'LKG') {
      return `ข้อมูลเก่าที่บันทึกล่าสุด (LKG) ${activeField.value.length} รายการ${time}${context}`;
    }
    if (activeField.value.length) return `ข้อมูล ${activeField.value.length} รายการจาก SETTRADE${time} · Snapshot${context}`;
    if (parsedRows > 0 && !session.accepted) return `อ่านข้อมูลจัดอันดับได้ แต่ยังไม่ยืนยันรอบเวลาตลาด${time}`;
    if (activeField.status.reason === 'MANUAL_REVIEW_REQUIRED') return 'การเข้าถึงข้อมูลจัดอันดับต้องได้รับการตรวจสอบ';
    if (['PARSER_MISMATCH', 'PAGE_IDENTITY_MISMATCH'].includes(activeField.status.reason)) return 'รูปแบบข้อมูลจัดอันดับยังไม่ผ่านการตรวจสอบ';
    if (activeField.status.reason === 'SOURCE_NO_DATA') return 'ต้นทางยังไม่มีข้อมูลจัดอันดับรอบนี้';
    if (activeField.status.reason === 'INVALID_DATA') return 'ข้อมูลจัดอันดับไม่ผ่านการตรวจสอบ';
    return 'ข้อมูลจัดอันดับยังไม่พร้อม';
  }

  async function loadOverview() {
    const pages = [];
    const pageErrors = [];
    const identities = [];
    let tfexField = unavailableTfex();
    for (let index = 0; index < PATHS.length; index += 1) {
      try {
        if (index === 3) {
          // Replace the old slot. Never send this URL through SETTRADE safety
          // or seed the TFEX Official cache/LKG from another provider.
          tfexField = tfexFieldSnapshot(await tfexSource.getSnapshot());
          continue;
        }
        const html = await fetchPage(PATHS[index]);
        pages[index] = html;
        identities[index] = pageIdentity(index, html);
      } catch (error) {
        if (index === 3) {
          tfexField = unavailableTfex(typeof error.code === 'string' ? error.code : 'ACQUISITION_GAP');
          continue;
        }
        pages[index] = '';
        identities[index] = false;
        pageErrors[index] = error;
      }
    }

    const fetchedAt = new Date(now()).toISOString();
    const overview = pages[0] ? parseSettradeMarket(pages[0]) : { indices: [], breadth: [], closeSummary: '' };
    const nvdr = pages[1] ? parseSettradeNvdr(pages[1]) : { ...EMPTY_NVDR };
    const foreign = pages[2] ? parseSettradeForeign(pages[2]) : { ...EMPTY_FOREIGN };
    const active = pages[4] ? selectMostActiveResponse(
      pages[4], parseSettradeActiveValue(pages[4]), identities[4]
    ) : { items: [], asOf: '' };

    function reason(pageIndex, parseField, parsed) {
      if (pageErrors[pageIndex]) return pageErrors[pageIndex].code || pageErrors[pageIndex].message;
      const outcome = classifySettradeParse(parseField, parsed);
      if (outcome === 'ACCEPT') return null;
      return identities[pageIndex] ? outcome : 'PAGE_IDENTITY_MISMATCH';
    }

    // Fetch receipt is not evidence of market-effective time. Only explicit,
    // validated source dates populate asOf; reported snapshot time is separate.
    const indicesField = field('indices', overview.indices, overview.indices.some(item => item.symbol === 'SET' && Number.isFinite(item.last)), null, reason(0, 'indices', overview));
    const maiCoverage = overview.__diagnostics?.breadthCoverage?.mai;
    const breadthField = field('breadth', overview.breadth, overview.breadth.some(group => group.items?.some(item => Number.isFinite(item.count) || Number.isFinite(item.volumeThousand))), null, reason(0, 'breadth', overview), {
      partial: Boolean(maiCoverage && maiCoverage !== 'ACCEPT'),
      coverageReason: maiCoverage === 'PARSER_MISMATCH' ? 'MAI_BREADTH_LABELS_UNVERIFIED' : 'MAI_BREADTH_UNAVAILABLE'
    });
    const closeField = field('closeSummary', overview.closeSummary, Boolean(overview.closeSummary), null, reason(0, 'closeSummary', overview));
    const nvdrField = field('nvdr', nvdr, hasNumber(nvdr), null, reason(1, 'nvdr', nvdr));
    const foreignField = field('foreign', foreign, hasNumber(foreign), sourceMarketDate(foreign.date), reason(2, 'foreign', foreign));
    const activeSession = assessActiveSession(active.asOf, { now: now(), maxIntradayAgeMs: fieldLkgTtlMs });
    const activeValid = classifySettradeParse('activeValue', active) === 'ACCEPT'
      && active.items.length > 0 && active.items.every(isRenderableActiveRow) && activeSession.accepted;
    const activeReason = reason(4, 'activeValue', active) || (!activeSession.accepted ? activeSession.reason : null);
    const unitsUnverified = active.items.some(row => row.sourceQuantities &&
      (row.sourceQuantities.value.unit === null || row.sourceQuantities.volume.unit === null));
    const aomSupported = active.items.some(row => row.sourceQuantities?.origin === 'SETTRADE_AOM') &&
      active.items.every(row => row.sourceQuantities?.origin !== 'SETTRADE_AOM' || row.sourceQuantities.basis === AOM_UNIT_BASIS);
    const activeField = field('activeValue', activeValid ? active.items : [], activeValid, null, activeReason, {
      reportedAsOf: sourceMarketTime(active.asOf) ? active.asOf : null, sessionContext: activeSession.context,
      sourceRankingPeriod: active.__diagnostics?.sourceRankingPeriod ?? null,
      quantityStatus: unitsUnverified ? 'UNVERIFIED' : aomSupported ? 'EVIDENCE_SUPPORTED' : 'HTML_LABELLED',
      quantityBasis: aomSupported ? AOM_UNIT_BASIS : null, partial: unitsUnverified,
      coverageReason: unitsUnverified ? active.__diagnostics?.origin === 'HYDRATION' ? 'AOM_UNITS_UNVERIFIED' : 'HTML_UNITS_UNVERIFIED' : null
    });

    const fieldStatus = {
      indices: indicesField.status,
      breadth: breadthField.status,
      closeSummary: closeField.status,
      nvdr: nvdrField.status,
      foreign: foreignField.status,
      tfex: tfexField.status,
      activeValue: activeField.status
    };
    const errors = fieldErrors(fieldStatus);
    const { stale, partial, dataState } = overviewState(fieldStatus, errors);
    const safetyStatus = safety.snapshot();

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
      stale,
      partial,
      dataState,
      marketDate: foreignField.value?.date || tfexField.value?.marketDate || null,
      errors,
      links: LINKS,
      fieldStatus,
      sourceStatus: { settrade: safetyStatus, tfex: tfexSourceStatus() },
      activeValueStatus: activeCaption(activeField, activeSession, active.items.filter(isRenderableActiveRow).length)
    };
  }

  async function getOverview(_force = false) {
    let result = await cache.get('settrade:overview', PROVIDER_POLICIES.settrade, loadOverview);
    if (typeof tfexSource.peekSnapshot === 'function') {
      // No upstream calls on a cache hit. The source owns freshness/retention;
      // re-saving its LKG in the composite cache must not extend that lifetime.
      let currentTfex;
      try { currentTfex = tfexFieldSnapshot(tfexSource.peekSnapshot()); }
      catch (_) { currentTfex = unavailableTfex('ACQUISITION_GAP'); }
      const fieldStatus = { ...result.value.fieldStatus, tfex: currentTfex.status };
      const errors = refreshedErrors(result.value, fieldStatus);
      result = { ...result, value: { ...result.value, tfex: currentTfex.value, fieldStatus, errors,
        ...overviewState(fieldStatus, errors, result.meta.status === 'stale'),
        sourceStatus: { ...result.value.sourceStatus, tfex: tfexSourceStatus() } } };
    }
    const status = result.value.fieldStatus.activeValue;
    if (status.state !== 'PASS' && status.state !== 'LKG') return result;
    const session = assessActiveSession(status.reportedAsOf, { now: now(), maxIntradayAgeMs: fieldLkgTtlMs });
    const receipt = Date.parse(status.fetchedAt);
    let activeField;
    const quantityProvenance = ['HTML_LABELLED', 'EVIDENCE_SUPPORTED', 'UNVERIFIED'].includes(status.quantityStatus);
    if (status.state === 'PASS' && session.accepted && quantityProvenance && Number.isFinite(receipt) && receipt <= now() && result.meta.status !== 'stale') {
      activeField = { value: result.value.activeValue, status: { ...status, sessionContext: session.context,
        freshness: session.context, freshnessVerified: false,
        sourceUpdatedAt: session.sourceAsOf, sourceTimeAgeMs: now() - Date.parse(session.sourceAsOf) } };
    } else {
    // Re-evaluate only the affected cached field. Neither a cache hit nor a
    // manual refresh may extend trust/retention or issue a compensating fetch.
      const failure = !quantityProvenance ? 'QUANTITY_PROVENANCE_UNVERIFIED' : !Number.isFinite(receipt) || receipt > now() ? 'INVALID_DATA'
        : status.reason || session.reason || 'CACHE_EXPIRED';
      activeField = field('activeValue', [], false, null, failure, { reportedAsOf: status.reportedAsOf });
    }
    const fieldStatus = { ...result.value.fieldStatus, activeValue: activeField.status };
    const errors = refreshedErrors(result.value, fieldStatus);
    return { ...result, value: { ...result.value, activeValue: activeField.value, fieldStatus,
      activeValueStatus: activeCaption(activeField, session, result.value.activeValue.length), errors,
      ...overviewState(fieldStatus, errors, result.meta.status === 'stale') } };
  }

  return { getOverview, safety };
}

module.exports = { EMPTY_FOREIGN, EMPTY_NVDR, EMPTY_TFEX, LINKS, PATHS, createSettradeService, pageIdentity };
