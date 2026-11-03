'use strict';

// Offline-only evidence feasibility adapter. Deliberately no fetch, URL allowlist
// mutation, issueEvidence, publisher enablement, or production registration.
// ELIGIBLE means the shared content predicate accepted a synthetic verified-shaped
// article excerpt; it is NOT trusted article evidence or display permission.
const {marketHtmlText,decodeXml}=require('./settrade-parser');
const {newsUrlIdentity}=require('./news-content');
const {classifyNewsItem}=require('./news-quality');

const ARTICLE_HOSTS=new Set(['investing.com','www.investing.com','th.investing.com']);
const ARTICLE_PATH=/^\/(?:news|analysis|articles?)\/(?:[^/]+\/)*[^/]+-\d+\/?$/i;
const ARTICLE_TYPES=new Set(['NewsArticle','Article','ReportageNewsArticle','AnalysisNewsArticle']);
const MAX_HTML_BYTES=1_500_000;
function hold(reason){return Object.freeze({stage:'OFFLINE_ONLY',status:'UNVERIFIED',reason,qualityDecision:'AMBIGUOUS'});}
function refused(reason){return Object.freeze({stage:'OFFLINE_ONLY',status:'REJECTED',reason,qualityDecision:'REJECT'});}
function safeArticleUrl(value){
  try{
    const url=new URL(String(value||''));
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!ARTICLE_HOSTS.has(url.hostname))return null;
    if(!ARTICLE_PATH.test(url.pathname))return null;
    if([...url.searchParams.keys()].some(key=>!/^utm_|^(?:fbclid|gclid)$/i.test(key)))return null;
    return url;
  }catch{return null;}
}
function safeGoogleWrapper(item){
  try{
    const url=new URL(String(item?.url||''));
    return item?.source==='other' && /^(?:Investing(?:\.com)?(?: ประเทศไทย)?)$/i.test(String(item.sourceName||'').trim())
      && url.protocol==='https:' && url.hostname==='news.google.com' && !url.username && !url.password
      && (!url.port||url.port==='443') && /^\/rss\/articles\/[A-Za-z0-9_-]{1,2048}$/.test(url.pathname);
  }catch{return false;}
}
function attr(tag,key){
  const match=[...String(tag).matchAll(/([a-zA-Z:-]+)\s*=\s*(["'])(.*?)\2/g)]
    .find(([,name])=>name.toLowerCase()===key);
  return decodeXml(match?.[3]||'');
}
function normalizedHeadline(value){
  return marketHtmlText(String(value||'')).normalize('NFKC')
    .replace(/\s+-\s+Investing\.com\s*$/i,'')
    .toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
}
function canonicalIdentity(value){
  const parsed=safeArticleUrl(value);
  return parsed?newsUrlIdentity(parsed.href):null;
}
function structuredArticles(html){
  const articles=[];
  for(const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    let parsed;
    try{parsed=JSON.parse(script[1]);}catch{continue;}
    const queue=[parsed];
    let visited=0;
    while(queue.length&&visited++<200&&articles.length<20){
      const record=queue.shift();
      if(!record||typeof record!=='object')continue;
      if(Array.isArray(record)){queue.push(...record.slice(0,100));continue;}
      const types=Array.isArray(record['@type'])?record['@type']:[record['@type']];
      if(types.some(type=>ARTICLE_TYPES.has(type)))articles.push(record);
      for(const value of Object.values(record))if(value&&typeof value==='object')queue.push(value);
    }
  }
  return articles;
}
function evaluateInvestingArticleOffline(rssItem,{articleUrl,html}={}){
  if(!safeGoogleWrapper(rssItem))return hold('RSS_PUBLISHER_OR_WRAPPER_UNVERIFIED');
  const publisher=safeArticleUrl(articleUrl);
  if(!publisher)return refused('PUBLISHER_ARTICLE_URL_NOT_ALLOWED');
  const expected=canonicalIdentity(publisher.href);
  if(typeof html!=='string'||Buffer.byteLength(html)>MAX_HTML_BYTES)return hold('ARTICLE_RESPONSE_INVALID');
  if(/<form\b[^>]*>[\s\S]*?<input\b[^>]*type=["']password["']/i.test(html)
    || /captcha|verify you are human|access denied/i.test(marketHtmlText(html.slice(0,20000))))return hold('ARTICLE_ACCESS_DENIED');
  const links=[...html.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(match=>match[0]);
  const canonical=links.filter(tag=>/\bcanonical\b/i.test(attr(tag,'rel'))
    || attr(tag,'property').toLowerCase()==='og:url')
    .map(tag=>canonicalIdentity(attr(tag,'href')||attr(tag,'content')));
  if(!canonical.length)return hold('ARTICLE_CANONICAL_REQUIRED');
  if(canonical.some(value=>!value||value!==expected))return refused('ARTICLE_CANONICAL_MISMATCH');
  const rssTitle=normalizedHeadline(rssItem.title);
  const headings=[...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map(match=>normalizedHeadline(match[1]));
  if(!rssTitle||headings.length!==1||headings[0]!==rssTitle)return hold('ARTICLE_HEADLINE_UNVERIFIED');
  const published=Date.parse(rssItem.pubDate);
  if(!Number.isFinite(published))return hold('RSS_PUBLICATION_DATE_INVALID');
  const records=structuredArticles(html);
  if(records.length!==1)return hold('ARTICLE_STRUCTURED_IDENTITY_UNVERIFIED');
  const record=records[0];
  const identities=[record.url,typeof record.mainEntityOfPage==='string'
    ?record.mainEntityOfPage:record.mainEntityOfPage?.['@id'],record['@id']]
    .filter(value=>typeof value==='string'&&value);
  if(!identities.length)return hold('ARTICLE_STRUCTURED_URL_REQUIRED');
  if(identities.some(value=>canonicalIdentity(value)!==expected))return refused('ARTICLE_STRUCTURED_URL_MISMATCH');
  if(normalizedHeadline(record.headline||record.name)!==rssTitle)return hold('ARTICLE_STRUCTURED_HEADLINE_MISMATCH');
  const articleDate=Date.parse(record.datePublished||'');
  if(!Number.isFinite(articleDate)||articleDate!==published)return hold('ARTICLE_PUBLICATION_DATE_MISMATCH');
  const body=marketHtmlText(String(record.articleBody||'').replace(/<(script|style|nav|aside|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi,' ')).trim();
  if(body.length<80||normalizedHeadline(body)===rssTitle)return hold('ARTICLE_TEXT_INSUFFICIENT');
  // This is deliberately a detached content-only candidate. Neither the original
  // RSS item nor its provenance/verification is mutated or promoted.
  const quality=classifyNewsItem({...rssItem,url:publisher.href,canonicalUrl:publisher.href,
    resolvedUrl:publisher.href,snippet:body.slice(0,1200)});
  return Object.freeze({stage:'OFFLINE_ONLY',status:quality.decision==='ACCEPT'?'ELIGIBLE'
    :quality.decision==='REJECT'?'REJECTED':'UNVERIFIED',
    reason:quality.reason||'CONTENT_ELIGIBLE_NOT_VERIFIED',qualityDecision:quality.decision,
    classification:quality.classification,language:quality.language||null,
    publisherUrl:publisher.href,publishedAt:new Date(articleDate).toISOString(),
    excerpt:body.slice(0,1200)});
}
module.exports={evaluateInvestingArticleOffline};
