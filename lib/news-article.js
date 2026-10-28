'use strict';
const { decodeXml, marketHtmlText } = require('./settrade-parser');
const { registerInspection, canonicalUrl } = require('./news-evidence');

function articleIdentity(value, base) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    return canonicalUrl(new URL(value, base).href);
  } catch { return null; }
}
function inspectNewsArticle(html, { url, title = '', strict = false } = {}) {
  const unknown = reason => ({ status: 'UNVERIFIED', reason, text: '' });
  const mismatch = () => ({ status: 'REJECTED', reason: 'ARTICLE_IDENTITY_MISMATCH', text: '' });
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
  let structured = '', contradictory = false, publishedAt = '', articleHeadline = '';
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const queue = [JSON.parse(match[1])];
      for (let count = 0; queue.length && count < 1000; count++) {
        const record = queue.shift();
        if (!record || typeof record !== 'object') continue;
        const types = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
        if (types.some(type => ['NewsArticle','Article','ReportageNewsArticle','AnalysisNewsArticle'].includes(type)) && typeof record.articleBody === 'string') {
          const values = [record.url, typeof record.mainEntityOfPage === 'string' ? record.mainEntityOfPage : record.mainEntityOfPage?.['@id'], record['@id']]
            .filter(value => typeof value === 'string' && value);
          const identities = values.map(value => articleIdentity(value, url));
          const wrong = identities.some(value => value !== expected);
          if (wrong) contradictory = true;
          const bound = !wrong && (identities.length > 0 || canonical.length > 0 && sameTitle(record.headline || record.name || ''));
          if (bound && record.articleBody.length > structured.length) {
            structured = marketHtmlText(record.articleBody); articleHeadline = record.headline || record.name || '';
            publishedAt = record.datePublished || '';
          }
        }
        queue.push(...Object.values(record).filter(value => value && typeof value === 'object'));
      }
    } catch { /* Validated HTML may still provide this same article. */ }
  }
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const body = marketHtmlText((article?.[1] || '').replace(/<(script|style|nav|footer|header|aside|form|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' '));
  const heading = marketHtmlText((article?.[1] || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
  const text = structured.length >= 80 ? structured : body.length >= 80 && (canonical.length > 0 || sameTitle(heading)) ? body : '';
  if (!text) return contradictory ? mismatch() : unknown('ARTICLE_IDENTITY_OR_TEXT_INSUFFICIENT');
  if (strict) {
    if (!sameTitle(articleHeadline || heading) && !(normalized(articleHeadline || heading).length>=2 && normalized(articleHeadline || heading)===normalized(title))) return unknown('ARTICLE_HEADLINE_UNVERIFIED');
    const metadataDate = links.find(tag => attr(tag, 'property').toLowerCase() === 'article:published_time');
    publishedAt ||= metadataDate ? attr(metadataDate, 'content') : attr((article?.[1] || '').match(/<time\b[^>]*>/i)?.[0] || '', 'datetime');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(publishedAt) || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) return unknown('ARTICLE_DATE_UNVERIFIED');
    publishedAt = new Date(publishedAt).toISOString();
  }
  return registerInspection({ ...(strict ? { publishedAt } : {}), status: 'VERIFIED', reason: 'ARTICLE_IDENTITY_VERIFIED', text: text.slice(0,7000), resolvedUrl: expected });
}
module.exports = { articleIdentity, inspectNewsArticle };
