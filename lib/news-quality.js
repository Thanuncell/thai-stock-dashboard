'use strict';
const { issueEvidence, trustedEvidence } = require('./news-evidence');

const PAGE_CLASSIFICATION = Object.freeze({
  ARTICLE_NEWS: 'ARTICLE_NEWS',
  OFFICIAL_ANNOUNCEMENT: 'OFFICIAL_ANNOUNCEMENT',
  BROKER_ANALYSIS: 'BROKER_ANALYSIS',
  COMPANY_PROFILE: 'COMPANY_PROFILE',
  QUOTE_DATA_OVERVIEW: 'QUOTE_DATA_OVERVIEW',
  SHAREHOLDER_OWNERSHIP: 'SHAREHOLDER_OWNERSHIP',
  AUTHENTICATION_PAGE: 'AUTHENTICATION_PAGE',
  AUTH_ACCOUNT: 'AUTH_ACCOUNT',
  ARCHIVE_LISTING: 'ARCHIVE_LISTING',
  PAGINATION: 'PAGINATION',
  INSTRUMENT_REFERENCE: 'INSTRUMENT_REFERENCE',
  REPORT_REFERENCE: 'REPORT_REFERENCE',
  TRADING_CALENDAR: 'TRADING_CALENDAR',
  NAVIGATION_REFERENCE: 'NAVIGATION_REFERENCE',
  SERVICE_MARKETING: 'SERVICE_MARKETING',
  CAREERS_RECRUITING: 'CAREERS_RECRUITING',
  COMPANY_LEADERSHIP: 'COMPANY_LEADERSHIP',
  EMPTY_OR_SLUG: 'EMPTY_OR_SLUG',
  UNKNOWN: 'UNKNOWN'
});

const NEWS_QUALITY_DECISION = Object.freeze({
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  AMBIGUOUS: 'AMBIGUOUS'
});

const GENERIC_TITLE = /^\s*-?\s*(?:SET|SETTRADE|ข่าว|ข่าวสาร|ข่าวล่าสุด|latest\s+news|news|ภาพรวม|ข้อมูลบริษัท)\s*$/i;
const PAGINATION_TITLE = /\bpage\s+\d+\s+(?:of|\/)\s+\d+\b/i;
const SLUG_TITLE = /^[a-z0-9]+(?:-[a-z0-9]+){1,}$/i;
const AUTH_TITLE = /^(?:login|log\s*in|sign\s*in|register|account|reset(?:\s+password)?|forgot(?:\s+password)?|otp|เข้าสู่ระบบ|สมัครสมาชิก|บัญชีผู้ใช้|รีเซ็ตรหัสผ่าน|ลืมรหัสผ่าน)$/i;
const AUTHENTICATION_PAGE_TITLE = /^(?:(?:(?:2|two)[-\s]*factors?|2fa)\s+authentication(?:\s+(?:login|sign[-\s]*in))?|authentication\s+(?:login|sign[-\s]*in)|(?:login|sign[-\s]*in)\s+(?:with\s+)?(?:(?:2|two)[-\s]*factors?\s+authentication|2fa))$/i;
const SETTRADE_PUBLISHER = /^SETTRADE(?:\.COM)?$/i;
const SETTRADE_PUBLISHER_SUFFIX = /\s+-\s+SETTRADE(?:\.COM)?$/i;
const DATA_PAGE_TITLE = /^(?:ข้อมูลรายบริษัท|ข้อมูลหลักทรัพย์|ข้อมูลหุ้น|ข้อมูลบริษัท|ข้อมูลทางการเงิน|ข้อมูลสถิติ|ภาพรวม|ราคาย้อนหลัง|กราฟเทคนิค|company profile|stock quote|financial data|market data|statistics)$/i;
const SHAREHOLDER_PAGE_TITLE = /^(?:(?:[A-Z0-9][A-Z0-9.-]{0,19})\s*[-–—]\s*)?(?:รายชื่อผู้ถือหุ้น(?:รายใหญ่)?|ผู้ถือหุ้นรายใหญ่|โครงสร้างผู้ถือหุ้น|ข้อมูลผู้ถือหุ้น|major shareholders?|shareholder structure|ownership|free float)$/i;
const PAGINATION_PATH = /\/page\/\d+(?:\/|$)/i;
const ARCHIVE_LISTING_PATH = /\/(?:archive|archives|category|categories|tag|tags|search|search-results|listing|index)(?:\/|$)/i;
const TERMINAL_LISTING_PATH = /\/(?:news|articles|latest-news)\/?$/i;
const AUTH_ACCOUNT_PATH = /\/(?:login|sign-?in|account|register|reset(?:-password)?|forgot(?:-password)?|otp|member|user-profile)(?:\/|$)/i;
const COMPANY_PROFILE_PATH = /\/(?:company-profile|stock-profile|companies?\/[^/]+\/profile|equities\/quote\/[^/]+\/profile)(?:\/|$)/i;
const QUOTE_DATA_PATH = /\/(?:stock-quote|market-data|quote\/[^/]+\/(?:overview|financials?|historical(?:-trading|-price)?|statistics|factsheet)|financial-data|statistics)(?:\/|$)/i;
const SHAREHOLDER_PATH = /\/(?:shareholders?|major-shareholders?|shareholder-structure|ownership|free-float)(?:\/|$)/i;
const TRADING_CALENDAR_PATH = /\/(?:trading-calendar|contract(?:-data|-specifications?)?|instrument(?:-data|-reference)?)(?:\/|$)/i;
const REPORT_REFERENCE_PATH = /\/(?:report-reference|statistical-reports?)(?:\/|$)|\/reports?\/(?:Report[A-Z0-9]{4,}|[A-Z0-9]{8,})(?:\/|$)/i;
const SERVICE_MARKETING_PATH = /\/(?:services?|products?|pricing)(?:\/|$)/i;
const SET_CAREER_PATH = /\/(?:about\/(?:careers?|jobs?|recruit(?:ment|ing))|careers?|jobs?|recruit(?:ment|ing))(?:\/|$)/i;
const SET_CAREER_TITLE = /^(?:SET\s+(?:Recruiting|Careers?|Jobs?)|ร่วมงานกับ(?:เรา|ตลาดหลักทรัพย์(?:แห่งประเทศไทย)?|\s*SET)|สมัครงาน(?:กับ)?\s*SET)$/i;
const COMPANY_LEADERSHIP_TITLE = /^[A-Z0-9][A-Z0-9._-]{0,23}\s*[-–—]\s*(?:กรรมการบริษัท|คณะกรรมการบริษัท|คณะกรรมการ|board\s+of\s+directors?|company\s+directors?)$/i;
const SETTRADE_NON_NEWS_TITLE = /(?:^|\s+-\s+)(?:ภาพรวม(?:บริษัท)?|ราคาย้อนหลัง|ข้อมูลบริษัท|ข้อมูลทางการเงิน|ข้อมูลหลักทรัพย์|ข้อมูลสถิติ|สถิติ|สิทธิประโยชน์|factsheet|company(?:\s+profile)?|profile|financial(?:\s+data)?|market(?:\s+data)?|quote|statistics|ความคิดเห็นนักวิเคราะห์|กราฟเทคนิค|ข้อมูลความยั่งยืน(?:\s*\(ESG\))?|อันดับในหมวดธุรกิจ|ข่าวสารการลงทุน|กรรมการบริษัท|คณะกรรมการบริษัท)(?:\s+-\s+(?:SETTRADE(?:\.COM)?|SET))?\s*$/i;
const SETTRADE_ARTICLE_PATH = /^\/(?:th|en)\/news-and-articles\/(?:news\/\d+(?:-[^/]+)?|articles\/\d+-[^/]+)\/?$/i;
const SET_ANNOUNCEMENT_PATH = /^\/(?:th|en)\/market\/news-and-alert\/newsdetails\/?$/i;
const ARTICLE_PATH = /\/(?:news(?:-and-alert)?\/newsdetails|news-and-articles\/(?:news|articles)|news|articles?|story|stories)\/(?:[^/]+)(?:\/|$)/i;
const INSTRUMENT_REFERENCE_TITLE = /^[A-Z0-9][A-Z0-9._-]{2,24}\s*[-–—]\s*(?:SETTRADE(?:\.COM)?|SET)$/i;
const REPORT_REFERENCE_TITLE = /^Report[A-Z0-9]{4,}\s*[-–—]\s*(?:Bank of Thailand|ธนาคารแห่งประเทศไทย|BOT)$/i;
const TRADING_CALENDAR_TITLE = /^(?:[A-Z0-9][A-Z0-9._-]{2,24})\s*[-–—]\s*(?:ปฏิทินการซื้อขาย|ข้อมูลสัญญา|รายละเอียดสัญญา|trading calendar|contract data)(?:\s*[-–—]\s*(?:SETTRADE(?:\.COM)?|SET))?$/i;
const NAVIGATION_REFERENCE_TITLE = /^(?:[^-–—]+\s*[-–—]\s*)?(?:ค้นหากองทุน(?:รวม)?(?:\s*IPO)?|สรุปภาพรวมตลาด)$/i;

function headlinePart(title = '') {
  return String(title).trim().replace(/\s+-\s+[^-]+$/, '').trim();
}

function settradePageClassification(value = '') {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { return null; }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'settrade.com' && host !== 'www.settrade.com') return null;
  if (SETTRADE_ARTICLE_PATH.test(parsed.pathname)) return 'ARTICLE';
  return 'NON_NEWS';
}

function rejected(classification, reason) {
  return { accepted: false, decision: NEWS_QUALITY_DECISION.REJECT, classification, reason };
}

function accepted(classification) {
  return { accepted: true, decision: NEWS_QUALITY_DECISION.ACCEPT, classification, reason: null };
}

function ambiguous(reason = 'INSUFFICIENT_EVIDENCE') {
  return {
    accepted: false,
    decision: NEWS_QUALITY_DECISION.AMBIGUOUS,
    classification: PAGE_CLASSIFICATION.UNKNOWN,
    reason
  };
}

function classifyPageUrl(parsed, title) {
  const path = parsed.pathname.replace(/\/{2,}/g, '/');
  const pathAndSearch = `${path}${parsed.search}`;
  const isSetHost = /(?:^|\.)(?:set\.or\.th|settrade\.com)$/i.test(parsed.hostname);
  if (isSetHost && SET_CAREER_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.CAREERS_RECRUITING, 'SET_CAREER_PATH');
  if (PAGINATION_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_PATH');
  const pageParam = parsed.searchParams.get('page');
  if (/^\d+$/.test(pageParam || '') && (ARCHIVE_LISTING_PATH.test(path) || TERMINAL_LISTING_PATH.test(path) || GENERIC_TITLE.test(title))) {
    return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_QUERY');
  }
  if (AUTH_ACCOUNT_PATH.test(pathAndSearch)) return rejected(PAGE_CLASSIFICATION.AUTH_ACCOUNT, 'AUTH_ACCOUNT_PATH');
  if (SHAREHOLDER_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.SHAREHOLDER_OWNERSHIP, 'SHAREHOLDER_PATH');
  if (TRADING_CALENDAR_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.TRADING_CALENDAR, 'TRADING_CALENDAR_PATH');
  if (REPORT_REFERENCE_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.REPORT_REFERENCE, 'REPORT_REFERENCE_PATH');
  if (COMPANY_PROFILE_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.COMPANY_PROFILE, 'COMPANY_PROFILE_PATH');
  if (QUOTE_DATA_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'QUOTE_DATA_PATH');
  if (ARCHIVE_LISTING_PATH.test(path) || TERMINAL_LISTING_PATH.test(path)) {
    return rejected(PAGE_CLASSIFICATION.ARCHIVE_LISTING, 'ARCHIVE_LISTING_PATH');
  }
  if (SERVICE_MARKETING_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.SERVICE_MARKETING, 'SERVICE_MARKETING_PATH');
  return null;
}

function classifyNewsItem(item = {}) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  const headline = headlinePart(title);
  const sourceName = String(item.sourceName || '').trim();
  if (PAGINATION_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_TITLE');
  if (AUTH_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.AUTH_ACCOUNT, 'AUTH_ACCOUNT_TITLE');
  if ((SETTRADE_PUBLISHER.test(sourceName) || SETTRADE_PUBLISHER_SUFFIX.test(title))
    && AUTHENTICATION_PAGE_TITLE.test(headline)) {
    return rejected(PAGE_CLASSIFICATION.AUTHENTICATION_PAGE, 'AUTHENTICATION_PAGE_TITLE');
  }
  if ((/^(?:SET|SETTRADE(?:\.COM)?|ตลาดหลักทรัพย์(?:แห่งประเทศไทย)?)$/i.test(sourceName)
    || /\s+-\s+(?:SET|SETTRADE(?:\.COM)?|ตลาดหลักทรัพย์(?:แห่งประเทศไทย)?)$/i.test(title))
    && SET_CAREER_TITLE.test(headline)) {
    return rejected(PAGE_CLASSIFICATION.CAREERS_RECRUITING, 'SET_CAREER_TITLE');
  }
  if ((SETTRADE_PUBLISHER.test(sourceName) || SETTRADE_PUBLISHER_SUFFIX.test(title))
    && COMPANY_LEADERSHIP_TITLE.test(headline)) {
    return rejected(PAGE_CLASSIFICATION.COMPANY_LEADERSHIP, 'SETTRADE_COMPANY_LEADERSHIP_TITLE');
  }
  if (SHAREHOLDER_PAGE_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.SHAREHOLDER_OWNERSHIP, 'SHAREHOLDER_PAGE_TITLE');
  if (DATA_PAGE_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'DATA_PAGE_TITLE');
  if (SETTRADE_NON_NEWS_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'SETTRADE_DATA_PAGE_TITLE');
  if (TRADING_CALENDAR_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.TRADING_CALENDAR, 'TRADING_CALENDAR_TITLE');
  if (REPORT_REFERENCE_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.REPORT_REFERENCE, 'REPORT_REFERENCE_TITLE');
  if (INSTRUMENT_REFERENCE_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.INSTRUMENT_REFERENCE, 'INSTRUMENT_REFERENCE_TITLE');
  if (NAVIGATION_REFERENCE_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.NAVIGATION_REFERENCE, 'NAVIGATION_REFERENCE_TITLE');
  let parsed;
  const classificationUrl = item.resolvedUrl || item.canonicalUrl || item.url;
  try { parsed = new URL(String(classificationUrl || '')); } catch (_) { return rejected(PAGE_CLASSIFICATION.UNKNOWN, 'INVALID_URL'); }
  if (settradePageClassification(parsed.href) === 'NON_NEWS') {
    return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'SETTRADE_NON_ARTICLE_PATH');
  }
  if (parsed.hostname !== 'news.google.com') {
    const urlDecision = classifyPageUrl(parsed, headline);
    if (urlDecision) return urlDecision;
  }
  if (!title || GENERIC_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.UNKNOWN, 'GENERIC_TITLE');

  const snippet = String(item.snippet || '').replace(/\s+/g, ' ').trim();
  const hasSnippetEvidence = snippet.length >= 20 && /[\p{L}\p{N}]/u.test(snippet);
  const hasArticlePathEvidence = parsed.hostname !== 'news.google.com'
    && (ARTICLE_PATH.test(parsed.pathname) || SETTRADE_ARTICLE_PATH.test(parsed.pathname)
      || SET_ANNOUNCEMENT_PATH.test(parsed.pathname));
  if (SLUG_TITLE.test(headline) && !hasSnippetEvidence && !hasArticlePathEvidence) {
    return rejected(PAGE_CLASSIFICATION.EMPTY_OR_SLUG, 'SLUG_TITLE');
  }

  const meaningfulHeadline = /[\p{L}\p{N}]/u.test(headline);
  if (!meaningfulHeadline) return rejected(PAGE_CLASSIFICATION.UNKNOWN, 'INSUFFICIENT_CONTENT');
  const isOfficial = /ตลาดหลักทรัพย์|\bSET\b|bot\.or\.th|ธนาคารแห่งประเทศไทย/i.test(sourceName)
    || SET_ANNOUNCEMENT_PATH.test(parsed.pathname);
  const classification = isOfficial
    ? PAGE_CLASSIFICATION.OFFICIAL_ANNOUNCEMENT
    : item.brokerCategory || item.source === 'broker' ? PAGE_CLASSIFICATION.BROKER_ANALYSIS : PAGE_CLASSIFICATION.ARTICLE_NEWS;
  if (hasSnippetEvidence || hasArticlePathEvidence || isOfficial || item.brokerCategory || item.source === 'broker') {
    return accepted(classification);
  }
  return ambiguous();
}

// Metadata acceptance and article verification are distinct evidence sources.
// Uncertainty can never be promoted by an older permissive accepted flag.
function reviewNewsItem(item = {}, articleVerification = item.verification) {
  const quality = classifyNewsItem(item);
  if (quality.decision === NEWS_QUALITY_DECISION.REJECT) {
    if (trustedEvidence(item, articleVerification) && articleVerification.status === 'REJECTED'
      && articleVerification.basis === 'metadata' && articleVerification.reason === quality.reason) return articleVerification;
    const observed = trustedEvidence(item, articleVerification);
    return issueEvidence(item, { status: 'REJECTED', reason: quality.reason, basis: 'metadata' },
      observed ? { checkedAt: observed.checkedAt } : {});
  }
  if (articleVerification && ['UNVERIFIED', 'REJECTED'].includes(articleVerification.status)) {
    if (trustedEvidence(item, articleVerification)) return articleVerification;
    return { status: articleVerification.status, reason: articleVerification.reason || 'ARTICLE_NOT_VERIFIED', basis: 'article' };
  }
  if (trustedEvidence(item, articleVerification)) return articleVerification;
  return issueEvidence(item, quality.decision === NEWS_QUALITY_DECISION.ACCEPT
    ? { status: 'VERIFIED', reason: 'NEWS_METADATA_EVIDENCE', basis: 'metadata' }
    : { status: 'UNVERIFIED', reason: quality.reason || 'INSUFFICIENT_EVIDENCE', basis: 'metadata' });
}

module.exports = { NEWS_QUALITY_DECISION, PAGE_CLASSIFICATION, classifyNewsItem, reviewNewsItem, settradePageClassification };
