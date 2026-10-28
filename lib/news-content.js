'use strict';
// A document candidate is a content kind, not proof of its title/date/contents.
const DOCUMENT_TITLE = /(?:^|[\\/\s])[^\\/\s]*\.(?:pdf|docx?|xlsx?|pptx?)(?:\s*[-–—].*)?$/i;
function newsContentType(item = {}) {
  const title = String(item.title || '').slice(0, 1000);
  let document = DOCUMENT_TITLE.test(title) || /^(?:PDF|Microsoft\s+(?:Word|PowerPoint|Excel))(?:\s*[-:–—]|$)/i.test(title);
  const urls = [item.url, item.canonicalUrl, item.resolvedUrl].map(value => {
    try { return new URL(value); } catch { return null; }
  }).filter(Boolean);
  for (const url of urls) {
    let path = url.pathname + url.search;
    try { path = decodeURIComponent(path); } catch { /* Keep the encoded path. */ }
    document ||= /\.(?:pdf|docx?|xlsx?|pptx?)(?:$|[/?#&])/i.test(path);
  }
  if (!document) return 'ARTICLE_NEWS';
  const official = urls.some(url => /(?:^|\.)(?:set\.or\.th|settrade\.com|bot\.or\.th)$/i.test(url.hostname))
    || urls.some(url => url.hostname === 'news.google.com')
      && ['settrade','official'].includes(item.source)
      && /^(?:SET|SETTRADE(?:\.COM)?|BOT|Bank of Thailand|ตลาดหลักทรัพย์(?:แห่งประเทศไทย)?|ธนาคารแห่งประเทศไทย)$/i.test(String(item.sourceName || '').trim());
  return official ? 'OFFICIAL_DOCUMENT' : 'OTHER_DOCUMENT';
}
function isNewsDocument(item) { return newsContentType(item) !== 'ARTICLE_NEWS'; }
module.exports = { newsContentType, isNewsDocument };
