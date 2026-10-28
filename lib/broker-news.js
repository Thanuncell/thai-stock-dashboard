'use strict';
const { mergeEvidenceAssociations, trustedEvidence, canonicalUrl } = require('./news-evidence');

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

// Display grouping is separate from the persisted fingerprint. Only private,
// subject-bound article proof can link an opaque RSS URL to its publisher URL.
function articleProof(item) {
  const record = trustedEvidence(item);
  return record && item.verification.status === 'VERIFIED' && item.verification.basis === 'article'
    && item.verification.displayPolicy === 'news-display-1' && record.articlePublishedAt ? record : null;
}

function dedupeNewsItems(items = []) {
  const groups = [], aliases = new Map();
  for (const item of items) {
    const proof = articleProof(item);
    const keys = [canonicalUrl(item.url) || newsFingerprint(item)];
    const original = proof && canonicalUrl(proof.originalUrl);
    if (original && new URL(original).hostname === 'news.google.com') keys.push(original);
    const matches = [...new Set(keys.map(key => aliases.get(key)).filter(Boolean))];
    const group = matches[0] || { items: [], keys: new Set() };
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      group.items.push(...other.items);
      for (const key of other.keys) { group.keys.add(key); aliases.set(key,group); }
      other.items = [];
    }
    group.items.push(item);
    for (const key of keys) { group.keys.add(key); aliases.set(key,group); }
  }
  return groups.filter(group => group.items.length).map(({items: contributors}) => {
    const winner = contributors.find(articleProof) || contributors[0];
    if (contributors.length === 1) return winner;
    const firms = [...new Set(contributors.flatMap(item => item.matchedBrokerFirms || []))];
    const symbols = [...new Set(contributors.flatMap(item => item.matchedSymbols || []))];
    return mergeEvidenceAssociations(winner,
      { ...winner, brokerCategory: firms.length > 0, matchedBrokerFirms: firms, matchedSymbols: symbols }, contributors);
  });
}

module.exports = { BROKER_FIRMS, decorateBrokerAttribution, dedupeNewsItems, matchBrokerFirms, newsFingerprint };
