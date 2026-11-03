'use strict';
// Shared by the server and browser; this module performs no I/O.
(function () {
// A document candidate is a content kind, not proof of its title/date/contents.
const DOCUMENT_TITLE = /(?:^|[\\/\s])[^\\/\s]*\.(?:pdf|docx?|xlsx?|pptx?)(?:\s*[-–—].*)?$/i;
// Presentation identity only. Never use this to rewrite persisted fingerprints.
function newsUrlIdentity(value) {
  let url;try { url=new URL(value); } catch { return null; }
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return null;
  url.hash='';
  url.hostname=url.hostname.replace(/^www\./,'');
  for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(key))url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname=url.pathname.replace(/\/$/,'')||'/';
  return url.href;
}
const GENERIC_TITLE = /^\s*-?\s*(?:SET|SETTRADE|ข่าว|ข่าวสาร|ข่าวล่าสุด|latest\s+news|news|ภาพรวม|ข้อมูลบริษัท)\s*$/i;
const SETTRADE_ARTICLE_PATH = /^\/(?:th|en)\/news-and-articles\/(?:news\/\d+(?:-[^/]+)?|articles\/\d+-[^/]+)\/?$/i;
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
function settradePageClassification(value = '') {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { return null; }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'settrade.com' && host !== 'www.settrade.com') return null;
  if (SETTRADE_ARTICLE_PATH.test(parsed.pathname)) return 'ARTICLE';
  return 'NON_NEWS';
}

function newsGenericTitle(value){return GENERIC_TITLE.test(value);}
function pageRejected(classification,reason){return {accepted:false,decision:'REJECT',classification,reason};}
function classifyPageUrl(parsed, title) {
  if(parsed.hostname==='news.google.com')return null;
  if(settradePageClassification(parsed.href)==='NON_NEWS')return pageRejected('QUOTE_DATA_OVERVIEW','SETTRADE_NON_ARTICLE_PATH');
  const path = parsed.pathname.replace(/\/{2,}/g, '/');
  let decodedPath = path;
  try { decodedPath = decodeURIComponent(path); } catch { /* Keep malformed escapes untrusted. */ }
  const articleRoute = /\/(?:news|analysis|articles?)\/(?:[^/]+\/)*[^/]+-\d+\/?$/i.test(decodedPath);
  if (/(?:^|\.)investing\.com$/i.test(parsed.hostname) && !articleRoute
    && /^\/(?:equities|indices|commodities|currencies|rates-bonds|bonds|etfs|funds|crypto|markets|economic-calendar|stock-screener|tools)(?:\/[^/]+)?(?:\/(?:news|analysis|historical-data|technical|charts?|commentary))?\/?$/i.test(decodedPath)) {
    return pageRejected('QUOTE_DATA_OVERVIEW', 'NON_ARTICLE_MARKET_DATA_PATH');
  }
  if (/(?:^|\.)investing\.com$/i.test(parsed.hostname) && /^\/brokers\/reviews?\//i.test(decodedPath)) {
    return pageRejected('SERVICE_MARKETING', 'BROKER_REVIEW_DIRECTORY');
  }
  const pathAndSearch = `${path}${parsed.search}`;
  const isSetHost = /(?:^|\.)(?:set\.or\.th|settrade\.com)$/i.test(parsed.hostname);
  if (isSetHost && SET_CAREER_PATH.test(path)) return pageRejected('CAREERS_RECRUITING', 'SET_CAREER_PATH');
  if (PAGINATION_PATH.test(path)) return pageRejected('PAGINATION', 'PAGINATION_PATH');
  const pageParam = parsed.searchParams.get('page');
  if (/^\d+$/.test(pageParam || '') && (ARCHIVE_LISTING_PATH.test(path) || TERMINAL_LISTING_PATH.test(path) || GENERIC_TITLE.test(title))) {
    return pageRejected('PAGINATION', 'PAGINATION_QUERY');
  }
  if (AUTH_ACCOUNT_PATH.test(pathAndSearch)) return pageRejected('AUTH_ACCOUNT', 'AUTH_ACCOUNT_PATH');
  if (SHAREHOLDER_PATH.test(path)) return pageRejected('SHAREHOLDER_OWNERSHIP', 'SHAREHOLDER_PATH');
  if (TRADING_CALENDAR_PATH.test(path)) return pageRejected('TRADING_CALENDAR', 'TRADING_CALENDAR_PATH');
  if (REPORT_REFERENCE_PATH.test(path)) return pageRejected('REPORT_REFERENCE', 'REPORT_REFERENCE_PATH');
  if (COMPANY_PROFILE_PATH.test(path)) return pageRejected('COMPANY_PROFILE', 'COMPANY_PROFILE_PATH');
  if (QUOTE_DATA_PATH.test(path)) return pageRejected('QUOTE_DATA_OVERVIEW', 'QUOTE_DATA_PATH');
  if (ARCHIVE_LISTING_PATH.test(path) || TERMINAL_LISTING_PATH.test(path)) {
    return pageRejected('ARCHIVE_LISTING', 'ARCHIVE_LISTING_PATH');
  }
  if (SERVICE_MARKETING_PATH.test(path)) return pageRejected('SERVICE_MARKETING', 'SERVICE_MARKETING_PATH');
  return null;
}

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
  if (isRemovedNewsPublisher(item)) return true;
  let reference = false;
  for (const value of [item?.url, item?.canonicalUrl, item?.resolvedUrl]) {
    try { reference ||= Boolean(classifyPageUrl(new URL(value), String(item?.title || ''))); } catch {}
  }
  const content = newsContentQuality(item);
  return isNewsDocumentForDisplay(item) || ['DOCUMENT','NON_ARTICLE'].includes(item?.linkVerification?.kind) || reference
    || Boolean(content && content.decision !== 'ACCEPT');
}
function newsClickUrl(item) {
  if(item?.linkVerification?.status==='VERIFIED'&&item.linkVerification.kind==='ARTICLE'){
    try{const u=new URL(item.displayUrl);if(u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&/(?:^|\.)(?:thunhoon\.com|kaohoon\.com|settrade\.com|set\.or\.th|bot\.or\.th|efinancethai\.com|infoquest\.co\.th|bangkokbiznews\.com|thansettakij\.com)$/.test(u.hostname))return u.href;}catch{/* Keep the original URL. */}
  }
  return /^https:\/\//i.test(String(item?.url||''))?item.url:'#';
}
// Filter identity is presentation metadata, never article verification or a storage source rewrite.
const NEWS_FILTER_SOURCES=Object.freeze(['all','thunhoon','kaohoon','settrade','official','infoquest','efinance','broker','other','bangkokbiznews','thansettakij']);
function normalizeNewsSources(value='all'){
 const parts=(Array.isArray(value)?value:[value]).flatMap(x=>String(x||'').toLowerCase().split(',')).map(x=>x.trim()).filter(x=>NEWS_FILTER_SOURCES.includes(x));
 return !parts.length||parts.includes('all')?'all':[...new Set(parts)].sort().join(',');
}
function newsPublisherKey(item={}){
 item=item&&typeof item==='object'?item:{};
 const name=String(item.sourceName||'').trim();
 const publishers=[
  ['bangkokbiznews',/^(?:กรุงเทพธุรกิจ|bangkokbiznews(?:\.com)?)$/i],
  ['investing',/^(?:investing(?:\.com)?(?: ประเทศไทย)?|อินเวสติ้ง(?:\.คอม)?)$/i],
  ['thansettakij',/^(?:ฐานเศรษฐกิจ|thansettakij(?:\.com)?)$/i],
  ['thunhoon',/^(?:ทันหุ้น|thunhoon(?:\.com)?)$/i],['kaohoon',/^(?:ข่าวหุ้น(?:ธุรกิจ)?|kaohoon(?:\.com)?)$/i],
  ['infoquest',/^(?:infoquest(?: news)?|(?:สำนักข่าว)?อินโฟเควสท์)$/i],['efinance',/efinance|อีไฟแนนซ์/i]
 ];
 const named=publishers.find(([,pattern])=>pattern.test(name));if(named)return named[0];
 if(NEWS_FILTER_SOURCES.includes(item.source)&&!['all','other','broker'].includes(item.source))return item.source;
 try{const host=new URL(item.url).hostname;
  for(const [key,domain]of [['bangkokbiznews','bangkokbiznews.com'],['investing','investing.com'],['thansettakij','thansettakij.com']])
   if(host===domain||host.endsWith('.'+domain))return key;
 }catch{}
 return item.source==='broker'?'broker':'other';
}
function newsMatchesSources(item,value='all'){
 if(!item||typeof item!=='object')return false;
 if(isRemovedNewsPublisher(item))return false;
 const selection=normalizeNewsSources(value);if(selection==='all')return true;
 const publisher=newsPublisherKey(item);
 return selection.split(',').some(key=>key==='broker'?Boolean(item.brokerCategory||item.source==='broker'):key==='other'?item.source==='other':publisher===key||item.source===key);
}

// Publisher identity remains available for historical rows and old URLs.
function isRemovedNewsPublisher(item = {}) {
  if (item?.source === 'investing' || /^(?:investing(?:\.com)?(?: ประเทศไทย)?|อินเวสติ้ง(?:\.คอม)?)$/i.test(String(item?.sourceName || '').trim())
    || /\s[-–—]\sInvesting\.com\s*$/i.test(String(item?.title || ''))) return true;
  return [item?.url, item?.resolvedUrl, item?.canonicalUrl, item?.displayUrl].some(value => {
    try { return /(?:^|\.)investing\.com$/i.test(new URL(value).hostname); } catch { return false; }
  });
}

// Publisher content requirements extend the shared quality predicate. They do
// not enable acquisition, grant article verification, or trust RSS locale tags.
const NEWS_CONTENT_POLICIES = Object.freeze({ investing: Object.freeze({ languages: ['th', 'en'], market: 'TH' }) });
function newsContentQuality(item = {}) {
  item = item && typeof item === 'object' ? item : {};
  const publisher = [item.url, item.resolvedUrl, item.canonicalUrl].some(value => {
    try { return /(?:^|\.)investing\.com$/i.test(new URL(value).hostname); } catch { return false; }
  }) ? 'investing' : newsPublisherKey(item);
  const policy = NEWS_CONTENT_POLICIES[publisher];
  if (!policy) return null;
  const hold = reason => ({ accepted: false, decision: 'AMBIGUOUS', classification: 'UNKNOWN', reason });
  const reject = reason => pageRejected('ARTICLE_NEWS', reason);
  const rawTitle = String(item.title || '').slice(0, 1000);
  const headline = rawTitle.normalize('NFKC').replace(/\s+-\s+Investing\.com\s*$/i, '').trim();
  const reference = /^(?:ราคาหุ้น\s+[^\s]+(?:\s*\([^)]+\))?|.+\b(?:stock price|share price|currency quote|bond yield|index futures|indices|markets|perpetual futures)(?:\s+(?:ข่าว|news))?|.+ข่าวกองทุนอีทีเอฟ|.+\([^)]*\)\s+ตลาด|.+\d+(?:\.\d+)?\s+\d{1,2}-[A-Za-z]{3}-\d{4}(?:\s+(?:กราฟพันธบัตร(?:ขั้นสูง)?|กระดานสนทนา))?|Mexican Peso.+กราฟพันธบัตร)$/i;
  const companyReference = /^[\p{L}\p{N} .&'-]+\s+\([A-Za-z0-9._/-]{1,20}\)$/u.test(headline)
    && !/รายงาน|ประกาศ|เผย|กำไร|พุ่ง|ร่วง|\b(?:reports?|earnings|announces?|rises?|falls?)\b/i.test(headline);
  const narrativeTitle = /รายงาน|ประกาศ|เผย|พุ่ง|ร่วง|ปรับขึ้น|ปรับลง|\b(?:reports?|announces?|rises?|rose|falls?|fell|assess(?:es)?|warns?|cuts?|raises?|approves?|rejects?|plans?)\b/i.test(headline);
  let articleRoute = false;
  try {
    const url = new URL(item.url);
    articleRoute = /(?:^|\.)investing\.com$/i.test(url.hostname)
      && /\/(?:news|analysis|articles?)\/(?:[^/]+\/)*[^/]+-\d+\/?$/i.test(url.pathname);
  } catch {}
  if (!articleRoute && !narrativeTitle && (reference.test(headline) || companyReference)) return pageRejected('QUOTE_DATA_OVERVIEW', 'NON_ARTICLE_MARKET_DATA_TITLE');
  if (/^รีวิว\s+\S+\s+ในไทย\s+ปี\s+\d{4}$/u.test(headline)) return pageRejected('SERVICE_MARKETING', 'BROKER_REVIEW_TITLE');
  const snippet = String(item.snippet || '').slice(0, 1200).normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const letters = snippet.match(/\p{L}/gu) || [];
  const normalized = value => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (letters.length < 30 || normalized(snippet) === normalized(headline)
    || normalized(snippet) === normalized(rawTitle)) return hold('CONTENT_EVIDENCE_INSUFFICIENT');
  const thai = letters.filter(letter => /\p{Script=Thai}/u.test(letter)).length;
  const latin = letters.filter(letter => /\p{Script=Latin}/u.test(letter)).length;
  const other = letters.length - thai - latin;
  const words = snippet.toLowerCase().match(/[a-z]+/g) || [];
  const english = new Set(words.filter(word => /^(?:the|and|of|to|in|on|as|with|for|was|were|said|that|from|while|after|by|its|has|have|had|is|are)$/i.test(word))).size;
  const foreign = new Set(words.filter(word => /^(?:las|los|del|una|para|por|con|les|des|une|dans|avec|und|der|die|das|mit|den)$/i.test(word))).size;
  if (other > letters.length * 0.25 || thai < letters.length * 0.35 && foreign >= 3 && foreign > english) return reject('CONTENT_LANGUAGE_UNSUPPORTED');
  const language = thai >= 20 && thai >= letters.length * 0.35 ? 'th'
    : latin >= letters.length * 0.8 && english >= 3 ? 'en' : null;
  if (!policy.languages.includes(language)) return hold('CONTENT_LANGUAGE_UNVERIFIED');
  const text = snippet;
  const relevant = /ตลาดหุ้นไทย|หุ้นไทย|เศรษฐกิจไทย|ธนาคารแห่งประเทศไทย|เงินบาท|ตลาดหลักทรัพย์แห่งประเทศไทย|ปตท\.?|\bThai\s+(?:stocks?|shares?|equities|economy|economic|market|baht|banks?)\b|\bBank of Thailand\b|\bSET(?:50|100)?\s+(?:index|market)\b/i.test(text)
    || /\bThailand\b|ประเทศไทย/i.test(text) && /\b(?:stocks?|shares?|equities|economy|economic|banks?|earnings|revenue|exports?|inflation|investment|growth)\b|หุ้น|เศรษฐกิจ|ธนาคาร|กำไร|ลงทุน|รายได้|ส่งออก|เงินเฟ้อ/i.test(text)
    || language === 'th' && /\bPTT\b/.test(text) && /กำไร|ผลประกอบการ|แผนลงทุน/.test(text);
  if (policy.market === 'TH' && !relevant) {
    if (/\bUS\b|\bAmerican\b|\bChina\b|\bChinese\b|\bJapan\b|สหรัฐ|จีน|ญี่ปุ่น/i.test(text)) return reject('CONTENT_MARKET_IRRELEVANT');
    return hold('CONTENT_MARKET_UNVERIFIED');
  }
  return { accepted: true, decision: 'ACCEPT', classification: 'ARTICLE_NEWS', reason: null, language };
}

const api = Object.freeze({ NEWS_FILTER_SOURCES, normalizeNewsSources, newsPublisherKey, newsMatchesSources, newsGenericTitle, settradePageClassification, newsPageUrlClassification:classifyPageUrl, newsUrlIdentity, isRemovedNewsPublisher, newsContentQuality, newsContentType, isNewsDocument, isNewsDocumentForDisplay, isSetNewsCandidate, newsSecuritySymbols, newsAssociationSymbols, newsDisplayBlocked, newsClickUrl });
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.defineProperty(globalThis, 'SETscopeNewsContent', { value: api });
})();
