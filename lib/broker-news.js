'use strict';

const BROKER_FIRMS = Object.freeze([
  { key: 'KS', companyName: 'บริษัทหลักทรัพย์ กสิกรไทย จำกัด (มหาชน)', aliases: ['หลักทรัพย์ กสิกรไทย', 'หลักทรัพย์กสิกรไทย', 'Kasikorn Securities', 'K Securities'] },
  { key: 'INVX', companyName: 'บริษัทหลักทรัพย์ อินโนเวสท์ เอกซ์ จำกัด', aliases: ['หลักทรัพย์ อินโนเวสท์ เอกซ์', 'หลักทรัพย์อินโนเวสท์ เอกซ์', 'Innovest X Securities', 'InnovestX'] },
  { key: 'BLS', companyName: 'บริษัทหลักทรัพย์ บัวหลวง จำกัด (มหาชน)', aliases: ['หลักทรัพย์ บัวหลวง', 'หลักทรัพย์บัวหลวง', 'Bualuang Securities'] },
  { key: 'FSS', companyName: 'บริษัทหลักทรัพย์ ฟินันเซีย ไซรัส จำกัด (มหาชน)', aliases: ['หลักทรัพย์ ฟินันเซีย ไซรัส', 'หลักทรัพย์ฟินันเซีย ไซรัส', 'Finansia Syrus Securities'] },
  { key: 'KKPS', companyName: 'บริษัทหลักทรัพย์ เกียรตินาคินภัทร จำกัด (มหาชน)', aliases: ['หลักทรัพย์ เกียรตินาคินภัทร', 'หลักทรัพย์เกียรตินาคินภัทร', 'Kiatnakin Phatra Securities'] },
  { key: 'KGI', companyName: 'บริษัทหลักทรัพย์ เคจีไอ (ประเทศไทย) จำกัด (มหาชน)', aliases: ['หลักทรัพย์ เคจีไอ (ประเทศไทย)', 'หลักทรัพย์เคจีไอ (ประเทศไทย)', 'KGI Securities (Thailand)'] },
  { key: 'YUANTA', companyName: 'บริษัทหลักทรัพย์ หยวนต้า (ประเทศไทย) จำกัด', aliases: ['หลักทรัพย์ หยวนต้า (ประเทศไทย)', 'หลักทรัพย์หยวนต้า', 'Yuanta Securities Thailand'] },
  { key: 'KSS', companyName: 'บริษัทหลักทรัพย์ กรุงศรี จำกัด (มหาชน)', aliases: ['หลักทรัพย์ กรุงศรี', 'หลักทรัพย์กรุงศรี', 'Krungsri Securities'] },
  { key: 'KTX', companyName: 'บริษัทหลักทรัพย์ กรุงไทย เอ็กซ์สปริง จำกัด', aliases: ['หลักทรัพย์ กรุงไทย เอ็กซ์สปริง', 'หลักทรัพย์กรุงไทย เอ็กซ์สปริง', 'Krungthai XSpring Securities'] },
  { key: 'LIB', companyName: 'บริษัทหลักทรัพย์ ลิเบอเรเตอร์ จำกัด', aliases: ['หลักทรัพย์ ลิเบอเรเตอร์', 'หลักทรัพย์ลิเบอเรเตอร์', 'Liberator Securities'] }
].map(item => Object.freeze({ ...item, aliases: Object.freeze([item.companyName, ...item.aliases]) })));

function searchable(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('th');
}

function matchBrokerFirms(value = '') {
  const text = searchable(value);
  if (!text) return [];
  return BROKER_FIRMS.filter(firm => firm.aliases.some(alias => text.includes(searchable(alias)))).map(firm => firm.key);
}

function decorateBrokerAttribution(item = {}) {
  const matchedBrokerFirms = [...new Set(matchBrokerFirms([item.sourceName, item.title, item.snippet].filter(Boolean).join(' ')))];
  return { ...item, brokerCategory: matchedBrokerFirms.length > 0, matchedBrokerFirms };
}

function newsFingerprint(item = {}) {
  try {
    const url = new URL(item.url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(key => url.searchParams.delete(key));
    url.hash = '';
    return `url:${url.href}`;
  } catch (_) {
    const title = searchable(item.title);
    const date = Number.isFinite(Date.parse(item.pubDate)) ? new Date(item.pubDate).toISOString().slice(0, 10) : '';
    return `title:${title}|${date}`;
  }
}

function dedupeNewsItems(items = []) {
  const unique = new Map();
  for (const item of items) {
    const key = newsFingerprint(item);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, item);
      continue;
    }
    const firms = [...new Set([...(existing.matchedBrokerFirms || []), ...(item.matchedBrokerFirms || [])])];
    unique.set(key, { ...existing, brokerCategory: firms.length > 0, matchedBrokerFirms: firms });
  }
  return [...unique.values()];
}

module.exports = { BROKER_FIRMS, decorateBrokerAttribution, dedupeNewsItems, matchBrokerFirms, newsFingerprint };
