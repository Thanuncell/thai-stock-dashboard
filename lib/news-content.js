'use strict';
// Shared by the server and browser; this module performs no I/O.
(function () {
// A document candidate is a content kind, not proof of its title/date/contents.
const DOCUMENT_TITLE = /(?:^|[\\/\s])[^\\/\s]*\.(?:pdf|docx?|xlsx?|pptx?)(?:\s*[-–—].*)?$/i;
function newsContentType(item = {}) {
  item = item && typeof item === 'object' ? item : {};
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
// Declared document kinds may only restrict display, never grant evidence trust.
function isNewsDocumentForDisplay(item) {
  return ['OFFICIAL_DOCUMENT','OTHER_DOCUMENT'].includes(item?.contentType) || isNewsDocument(item);
}
function isSetNewsCandidate(item) {
  return ['settrade','official'].includes(item?.source) && /^(?:SET|SETTRADE(?:\.COM)?|ตลาดหลักทรัพย์(?:แห่งประเทศไทย)?)$/i.test(String(item?.sourceName||'').trim());
}
function newsSecuritySymbols(item) {
  if(!isSetNewsCandidate(item))return null;
  const proof=item.securityIdentification;
  try{const url=new URL(proof?.publisherUrl);if(proof.status!=='IDENTIFIED'||url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!/(?:^|\.)(?:set\.or\.th|settrade\.com)$/.test(url.hostname))return [];}catch{return [];}
  return [...new Set((Array.isArray(proof.symbols)?proof.symbols:[]).filter(x=>typeof x==='string'&&/^[A-Z0-9][A-Z0-9&.-]{0,19}$/.test(x)))].slice(0,10);
}
function newsAssociationSymbols(item) {
  const identified=newsSecuritySymbols(item);
  return identified?.length?identified:(Array.isArray(item?.matchedSymbols)?item.matchedSymbols:[]);
}
function newsDisplayBlocked(item) {
  return isNewsDocumentForDisplay(item) || ['DOCUMENT','NON_ARTICLE'].includes(item?.linkVerification?.kind);
}
function newsClickUrl(item) {
  if(item?.linkVerification?.status==='VERIFIED'&&item.linkVerification.kind==='ARTICLE'){
    try{const u=new URL(item.displayUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(?:^|\.)(?:thunhoon\.com|kaohoon\.com|settrade\.com|set\.or\.th|bot\.or\.th|efinancethai\.com|infoquest\.co\.th|bangkokbiznews\.com)$/.test(u.hostname))return u.href;}catch{/* Keep the original URL. */}
  }
  return /^https:\/\//i.test(String(item?.url||''))?item.url:'#';
}
const api = Object.freeze({ newsContentType, isNewsDocument, isNewsDocumentForDisplay, isSetNewsCandidate, newsSecuritySymbols, newsAssociationSymbols, newsDisplayBlocked, newsClickUrl });
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.defineProperty(globalThis, 'SETscopeNewsContent', { value: api });
})();
