'use strict';

const GENERIC_TITLE = /^\s*-?\s*(?:SET|SETTRADE)\s*$/i;
const SLUG_TITLE = /^[a-z0-9]+(?:-[a-z0-9]+){1,}$/i;
const NON_NEWS_URL = /(?:^|[\/_-])(?:login|sign-?in|account|register|reset(?:-password)?|forgot(?:-password)?|otp|company-profile|stock-profile|stock-quote|quote|market-data|service)(?:[\/_?.#-]|$)/i;
const NON_NEWS_TITLE = /^(?:ข้อมูลรายบริษัท|ข้อมูลหลักทรัพย์|ข้อมูลหุ้น|company profile|stock quote)\b/i;
const SETTRADE_NON_NEWS_TITLE = /(?:^|\s+-\s+)(?:ภาพรวม|ราคาย้อนหลัง|ข้อมูลบริษัท|ข้อมูลทางการเงิน|ข้อมูลหลักทรัพย์|ข้อมูลสถิติ|สถิติ|สิทธิประโยชน์|factsheet|company(?:\s+profile)?|profile|financial(?:\s+data)?|market(?:\s+data)?|quote|statistics|ความคิดเห็นนักวิเคราะห์|กราฟเทคนิค|ข้อมูลความยั่งยืน(?:\s*\(ESG\))?|อันดับในหมวดธุรกิจ|ข่าวสารการลงทุน)(?:\s+-\s+(?:SETTRADE|SET))?\s*$/i;
const SETTRADE_ARTICLE_PATH = /^\/(?:th|en)\/news-and-articles\/(?:news\/\d+(?:-[^/]+)?|articles\/\d+-[^/]+)\/?$/i;

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

function classifyNewsItem(item = {}) {
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  const headline = headlinePart(title);
  if (!title || GENERIC_TITLE.test(title)) return { accepted: false, classification: 'NON_NEWS', reason: 'GENERIC_TITLE' };
  if (SLUG_TITLE.test(headline)) return { accepted: false, classification: 'NON_NEWS', reason: 'SLUG_TITLE' };
  if (NON_NEWS_TITLE.test(headline)) return { accepted: false, classification: 'NON_NEWS', reason: 'DATA_PAGE_TITLE' };
  if (SETTRADE_NON_NEWS_TITLE.test(title)) return { accepted: false, classification: 'NON_NEWS', reason: 'SETTRADE_DATA_PAGE_TITLE' };
  let parsed;
  const classificationUrl = item.resolvedUrl || item.canonicalUrl || item.url;
  try { parsed = new URL(String(classificationUrl || '')); } catch (_) { return { accepted: false, classification: 'NON_NEWS', reason: 'INVALID_URL' }; }
  if (settradePageClassification(parsed.href) === 'NON_NEWS') {
    return { accepted: false, classification: 'NON_NEWS', reason: 'SETTRADE_NON_ARTICLE_PATH' };
  }
  if (parsed.hostname !== 'news.google.com' && NON_NEWS_URL.test(`${parsed.pathname}${parsed.search}`)) {
    return { accepted: false, classification: 'NON_NEWS', reason: 'ACCOUNT_OR_DATA_PAGE' };
  }
  const meaningfulHeadline = headline.length >= 8 && /[\p{L}\p{N}]/u.test(headline);
  if (!meaningfulHeadline) return { accepted: false, classification: 'UNKNOWN', reason: 'INSUFFICIENT_CONTENT' };
  const sourceName = String(item.sourceName || '');
  const classification = /ตลาดหลักทรัพย์|\bSET\b|bot\.or\.th|ธนาคารแห่งประเทศไทย/i.test(sourceName)
    ? 'OFFICIAL_ANNOUNCEMENT'
    : item.brokerCategory || item.source === 'broker' ? 'BROKER_ANALYSIS' : 'ARTICLE_NEWS';
  return { accepted: true, classification, reason: null };
}

module.exports = { classifyNewsItem, settradePageClassification };
