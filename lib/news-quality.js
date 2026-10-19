'use strict';

const PAGE_CLASSIFICATION = Object.freeze({
  ARTICLE_NEWS: 'ARTICLE_NEWS',
  OFFICIAL_ANNOUNCEMENT: 'OFFICIAL_ANNOUNCEMENT',
  BROKER_ANALYSIS: 'BROKER_ANALYSIS',
  COMPANY_PROFILE: 'COMPANY_PROFILE',
  QUOTE_DATA_OVERVIEW: 'QUOTE_DATA_OVERVIEW',
  SHAREHOLDER_OWNERSHIP: 'SHAREHOLDER_OWNERSHIP',
  AUTH_ACCOUNT: 'AUTH_ACCOUNT',
  ARCHIVE_LISTING: 'ARCHIVE_LISTING',
  PAGINATION: 'PAGINATION',
  SERVICE_MARKETING: 'SERVICE_MARKETING',
  EMPTY_OR_SLUG: 'EMPTY_OR_SLUG',
  UNKNOWN: 'UNKNOWN'
});

const GENERIC_TITLE = /^\s*-?\s*(?:SET|SETTRADE|ข่าว|ข่าวสาร|ข่าวล่าสุด|latest\s+news|news|ภาพรวม|ข้อมูลบริษัท)\s*$/i;
const PAGINATION_TITLE = /\bpage\s+\d+\s+(?:of|\/)\s+\d+\b/i;
const SLUG_TITLE = /^[a-z0-9]+(?:-[a-z0-9]+){1,}$/i;
const AUTH_TITLE = /^(?:login|log\s*in|sign\s*in|register|account|reset(?:\s+password)?|forgot(?:\s+password)?|otp|เข้าสู่ระบบ|สมัครสมาชิก|บัญชีผู้ใช้|รีเซ็ตรหัสผ่าน|ลืมรหัสผ่าน)$/i;
const DATA_PAGE_TITLE = /^(?:ข้อมูลรายบริษัท|ข้อมูลหลักทรัพย์|ข้อมูลหุ้น|ข้อมูลบริษัท|ข้อมูลทางการเงิน|ข้อมูลสถิติ|ภาพรวม|ราคาย้อนหลัง|กราฟเทคนิค|company profile|stock quote|financial data|market data|statistics)$/i;
const SHAREHOLDER_PAGE_TITLE = /^(?:(?:[A-Z0-9][A-Z0-9.-]{0,19})\s*[-–—]\s*)?(?:รายชื่อผู้ถือหุ้น(?:รายใหญ่)?|ผู้ถือหุ้นรายใหญ่|โครงสร้างผู้ถือหุ้น|ข้อมูลผู้ถือหุ้น|major shareholders?|shareholder structure|ownership|free float)$/i;
const PAGINATION_PATH = /\/page\/\d+\/?$/i;
const ARCHIVE_LISTING_PATH = /\/(?:archive|archives|category|categories|tag|tags|search|search-results|listing|index)(?:\/|$)/i;
const TERMINAL_LISTING_PATH = /\/(?:news|articles|latest-news)\/?$/i;
const AUTH_ACCOUNT_PATH = /\/(?:login|sign-?in|account|register|reset(?:-password)?|forgot(?:-password)?|otp|member|user-profile)(?:\/|$)/i;
const COMPANY_PROFILE_PATH = /\/(?:company-profile|stock-profile|companies?\/[^/]+\/profile|equities\/quote\/[^/]+\/profile)(?:\/|$)/i;
const QUOTE_DATA_PATH = /\/(?:stock-quote|market-data|quote\/[^/]+\/(?:overview|financials?|historical(?:-trading|-price)?|statistics|factsheet)|financial-data|statistics)(?:\/|$)/i;
const SHAREHOLDER_PATH = /\/(?:shareholders?|major-shareholders?|shareholder-structure|ownership|free-float)(?:\/|$)/i;
const SERVICE_MARKETING_PATH = /\/(?:services?|products?|pricing)(?:\/|$)/i;
const SETTRADE_NON_NEWS_TITLE = /(?:^|\s+-\s+)(?:ภาพรวม|ราคาย้อนหลัง|ข้อมูลบริษัท|ข้อมูลทางการเงิน|ข้อมูลหลักทรัพย์|ข้อมูลสถิติ|สถิติ|สิทธิประโยชน์|factsheet|company(?:\s+profile)?|profile|financial(?:\s+data)?|market(?:\s+data)?|quote|statistics|ความคิดเห็นนักวิเคราะห์|กราฟเทคนิค|ข้อมูลความยั่งยืน(?:\s*\(ESG\))?|อันดับในหมวดธุรกิจ|ข่าวสารการลงทุน)(?:\s+-\s+(?:SETTRADE|SET))?\s*$/i;
const SETTRADE_ARTICLE_PATH = /^\/(?:th|en)\/news-and-articles\/(?:news\/\d+(?:-[^/]+)?|articles\/\d+-[^/]+)\/?$/i;
const SET_ANNOUNCEMENT_PATH = /^\/(?:th|en)\/market\/news-and-alert\/newsdetails\/?$/i;

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
  return { accepted: false, classification, reason };
}

function classifyPageUrl(parsed, title) {
  const path = parsed.pathname.replace(/\/{2,}/g, '/');
  const pathAndSearch = `${path}${parsed.search}`;
  if (PAGINATION_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_PATH');
  const pageParam = parsed.searchParams.get('page');
  if (/^\d+$/.test(pageParam || '') && (ARCHIVE_LISTING_PATH.test(path) || TERMINAL_LISTING_PATH.test(path) || GENERIC_TITLE.test(title))) {
    return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_QUERY');
  }
  if (AUTH_ACCOUNT_PATH.test(pathAndSearch)) return rejected(PAGE_CLASSIFICATION.AUTH_ACCOUNT, 'AUTH_ACCOUNT_PATH');
  if (SHAREHOLDER_PATH.test(path)) return rejected(PAGE_CLASSIFICATION.SHAREHOLDER_OWNERSHIP, 'SHAREHOLDER_PATH');
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
  if (!title || GENERIC_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.UNKNOWN, 'GENERIC_TITLE');
  if (PAGINATION_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.PAGINATION, 'PAGINATION_TITLE');
  if (SLUG_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.EMPTY_OR_SLUG, 'SLUG_TITLE');
  if (AUTH_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.AUTH_ACCOUNT, 'AUTH_ACCOUNT_TITLE');
  if (SHAREHOLDER_PAGE_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.SHAREHOLDER_OWNERSHIP, 'SHAREHOLDER_PAGE_TITLE');
  if (DATA_PAGE_TITLE.test(headline)) return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'DATA_PAGE_TITLE');
  if (SETTRADE_NON_NEWS_TITLE.test(title)) return rejected(PAGE_CLASSIFICATION.QUOTE_DATA_OVERVIEW, 'SETTRADE_DATA_PAGE_TITLE');
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
  const meaningfulHeadline = headline.length >= 8 && /[\p{L}\p{N}]/u.test(headline);
  if (!meaningfulHeadline) return rejected(PAGE_CLASSIFICATION.UNKNOWN, 'INSUFFICIENT_CONTENT');
  const sourceName = String(item.sourceName || '');
  const isOfficial = /ตลาดหลักทรัพย์|\bSET\b|bot\.or\.th|ธนาคารแห่งประเทศไทย/i.test(sourceName)
    || SET_ANNOUNCEMENT_PATH.test(parsed.pathname);
  const classification = isOfficial
    ? PAGE_CLASSIFICATION.OFFICIAL_ANNOUNCEMENT
    : item.brokerCategory || item.source === 'broker' ? PAGE_CLASSIFICATION.BROKER_ANALYSIS : PAGE_CLASSIFICATION.ARTICLE_NEWS;
  return { accepted: true, classification, reason: null };
}

module.exports = { PAGE_CLASSIFICATION, classifyNewsItem, settradePageClassification };
