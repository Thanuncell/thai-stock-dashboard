'use strict';
const { decodeXml, marketHtmlText } = require('./settrade-parser');
const { registerInspection, canonicalUrl } = require('./news-evidence');
const { isNewsDocument } = require('./news-content');
const { isSlugNewsTitle } = require('./news-policy');

function articleIdentity(value, base) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    return canonicalUrl(new URL(value, base).href);
  } catch { return null; }
}
// Source-specific content container; never substitute related-story cards or the whole page.
function infoquestArticleBody(html, expected) {
  if (!/(?:^|\.)infoquest\.co\.th$/.test(new URL(expected).hostname)) return '';
  const clean=html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  const starts=[...clean.matchAll(/<div\b[^>]*class=["'][^"']*\belementor-widget-theme-post-content\b[^"']*["'][^>]*>/gi)];
  if(starts.length!==1)return '';
  const start=starts[0],tags=/<\/?div\b[^>]*>/gi;tags.lastIndex=start.index+start[0].length;
  let depth=1,match;
  while((match=tags.exec(clean))){depth+=/^<\//.test(match[0])?-1:1;if(depth===0)return clean.slice(start.index+start[0].length,match.index);}
  return '';
}
function nationArticleBody(html, expected) {
  if (!['bangkokbiznews.com','www.bangkokbiznews.com','thansettakij.com','www.thansettakij.com'].includes(new URL(expected).hostname)) return '';
  const clean=html.replace(/<(script|style|aside|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' '),parts=[];
  // Source-provided article paragraphs only; exclude related cards, ads and hydration data.
  for (const start of clean.matchAll(/<div\b[^>]*id=["']paragraph-\d+["'][^>]*>/gi)) {
    if(!/\bdata-news-content=["']company["']/i.test(start[0])||!/\bclass=["'][^"']*\bcontent-detail\b/i.test(start[0]))continue;
    const tags=/<\/?div\b[^>]*>/gi;tags.lastIndex=start.index+start[0].length;let depth=1,match;
    while((match=tags.exec(clean))){depth+=/^<\//.test(match[0])?-1:1;if(depth===0){parts.push(clean.slice(start.index+start[0].length,match.index));break;}}
  }
  return parts.join(' ');
}
function inspectNewsArticle(html, { url, title = '', strict = false, recoverHeadline = false } = {}) {
  const unknown = reason => ({ status: 'UNVERIFIED', reason, text: '' });
  const mismatch = () => ({ status: 'REJECTED', reason: 'ARTICLE_IDENTITY_MISMATCH', text: '' });
  if (isNewsDocument({url,title})) return unknown('DOCUMENT_NOT_ARTICLE');
  const expected = articleIdentity(url);
  if (!expected || typeof html !== 'string' || Buffer.byteLength(html) > 1_500_000) return unknown('ARTICLE_RESPONSE_INVALID');
  const visible = marketHtmlText(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  if (/captcha|verify you are human|access denied|^\s*(login|sign in)\s*$/i.test(visible)) return unknown('ARTICLE_ACCESS_DENIED');
  const attr = (tag, key) => decodeXml(tag.match(new RegExp('\\b'+key+'\\s*=\\s*["\']([^"\']*)["\']','i'))?.[1] || '');
  const links = [...html.matchAll(/<(?:link|meta)\b[^>]*>/gi)].map(m => m[0]);
  const canonical = links.filter(tag => /(?:^|\s)canonical(?:\s|$)/i.test(attr(tag, 'rel')) || attr(tag, 'property').toLowerCase() === 'og:url')
    .map(tag => articleIdentity(attr(tag, 'href') || attr(tag, 'content'), url));
  if (canonical.some(value => value !== expected)) return mismatch();
  const normalized = value => marketHtmlText(value).toLowerCase().replace(/\s+-\s+[^-]+$/, '').replace(/[^\p{L}\p{N}]/gu, '');
  const sameTitle = value => {
    const a = normalized(value), b = normalized(title);
    return a.length >= 8 && b.length >= 8 && (a === b || a.includes(b) || b.includes(a));
  };
  const pageUrl=new URL(expected);
  const infoquestHtmlPage=['infoquest.co.th','www.infoquest.co.th'].includes(pageUrl.hostname)
    && /^[/][0-9]{4}[/][0-9]+[/]?$/.test(pageUrl.pathname);
  let structured = '', contradictory = false, publishedAt = '', articleHeadline = '', identityHeadline = '', identityDate = '', structuredIdentity = false;
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const queue = [JSON.parse(match[1])];
      for (let count = 0; queue.length && count < 1000; count++) {
        const record = queue.shift();
        if (!record || typeof record !== 'object') continue;
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        // InfoQuest publishes some articles as HTML with a bound WebPage
        // date/name. That metadata cannot supply text or replace its article widget.
        const htmlPage=infoquestHtmlPage && types.includes('WebPage');
        if (htmlPage || types.some(type => ['NewsArticle','Article','ReportageNewsArticle','AnalysisNewsArticle'].includes(type))) {
          const values = [record.url, typeof record.mainEntityOfPage === 'string' ? record.mainEntityOfPage : record.mainEntityOfPage?.['@id'], record['@id']]
            .filter(value => typeof value === 'string' && value);
          const identities = values.map(value => articleIdentity(value, url));
          const wrong = identities.some(value => value !== expected);
          if (wrong && !htmlPage) contradictory = true;
          const bound = !wrong && (identities.length > 0 || canonical.length > 0 && sameTitle(record.headline || record.name || ''));
          if (bound && identities.length > 0 && sameTitle(record.headline || record.name || '')) {
            identityHeadline = record.headline || record.name; identityDate = record.datePublished || '';
          }
          if (!htmlPage && bound && typeof record.articleBody === 'string' && record.articleBody.length > structured.length) {
            structuredIdentity = identities.length>0;
            structured = marketHtmlText(record.articleBody); articleHeadline = record.headline || record.name || '';
            publishedAt = record.datePublished || '';
          }
        }
        queue.push(...Object.values(record).filter(value => value && typeof value === 'object'));
      }
    } catch { /* Validated HTML may still provide this same article. */ }
  }
  const bangkok=['bangkokbiznews.com','www.bangkokbiznews.com','thansettakij.com','www.thansettakij.com'].includes(new URL(expected).hostname);
  if(bangkok&&/"isAccessibleForFree"\s*:\s*false/i.test(html))return unknown('ARTICLE_ACCESS_DENIED');
  const sourceBody = canonical.length > 0 && identityHeadline ? (bangkok?nationArticleBody(html,expected):infoquestArticleBody(html,expected)) : '';
  if(bangkok&&!sourceBody)return unknown('ARTICLE_IDENTITY_OR_TEXT_INSUFFICIENT');
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(match=>marketHtmlText(match[1]));
  const boundSource = sourceBody && headings.length===1 && sameTitle(headings[0]) ? sourceBody : '';
  const article = boundSource ? [null,boundSource] : html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const body = marketHtmlText((article?.[1] || '').replace(/<(script|style|nav|footer|header|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  const heading = boundSource ? headings[0] : marketHtmlText((article?.[1] || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const text = structured.length >= 80 ? structured : body.length >= 80 && (canonical.length > 0 || sameTitle(heading)) ? body : '';
  if (!text) return contradictory ? mismatch() : unknown('ARTICLE_IDENTITY_OR_TEXT_INSUFFICIENT');
  if (boundSource) { articleHeadline ||= identityHeadline; publishedAt ||= identityDate; }
  let recoveredHeadline = '';
  if(recoverHeadline){
    const candidate=String(articleHeadline||heading||'').trim();
    const publisher=/(?:^|\.)thunhoon\.com$/.test(new URL(expected).hostname);
    const bodyBound=structured.length>=80?structuredIdentity:(html.match(/<article\b/gi)||[]).length===1;
    if(!strict||!publisher||!isSlugNewsTitle(title)||!canonical.length||!bodyBound||isSlugNewsTitle(candidate)||normalized(candidate).length<8)
      return unknown('ARTICLE_HEADLINE_UNVERIFIED');
    recoveredHeadline=candidate;
  }
  if (strict) {
    if (!recoveredHeadline && !sameTitle(articleHeadline || heading) && !(normalized(articleHeadline || heading).length>=2 && normalized(articleHeadline || heading)===normalized(title))) return unknown('ARTICLE_HEADLINE_UNVERIFIED');
    const metadataDate = links.find(tag => attr(tag, 'property').toLowerCase() === 'article:published_time');
    publishedAt ||= metadataDate ? attr(metadataDate, 'content') : attr((article?.[1] || '').match(/<time\b[^>]*>/i)?.[0] || '', 'datetime');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) return unknown('ARTICLE_DATE_UNVERIFIED');
    publishedAt = new Date(publishedAt).toISOString();
  }
  return registerInspection({ ...(recoveredHeadline ? {headline:recoveredHeadline} : {}), ...(strict ? { publishedAt } : {}), status: 'VERIFIED', reason: 'ARTICLE_IDENTITY_VERIFIED', text: text.slice(0,7000), resolvedUrl: expected });
}
module.exports = { articleIdentity, inspectNewsArticle };
