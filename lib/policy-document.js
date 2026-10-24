'use strict';

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

const ALLOWED_DOCUMENT_TYPES = new Set(['terms', 'data-use-policy', 'robots', 'access-notice']);
const ALLOWED_PUBLISHERS = new Set(['SET']);
const BLOCKED_PAGE_PATTERNS = [
  /captcha|recaptcha|access denied|forbidden/i,
  /(?:sign|log)[ -]?in|authentication|password/i,
  /market overview|ภาพรวมตลาด|ข่าว(?:หุ้น|ล่าสุด)?/i
];

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function assertPublicHttpsUrl(input, permittedHosts) {
  let url;
  try { url = new URL(String(input)); }
  catch (_) { throw Error('INVALID_DOCUMENT_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw Error('UNSAFE_DOCUMENT_URL');
  const hostname = url.hostname.toLowerCase();
  if (isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw Error('UNSAFE_DOCUMENT_HOST');
  }
  if (!permittedHosts.includes(hostname)) throw Error('DOCUMENT_HOST_NOT_PERMITTED');
  return url;
}

function validateRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw Error('EMPTY_DOCUMENT_REGISTRY');
  const ids = new Set();
  return entries.map(entry => {
    const sourceId = String(entry?.sourceId || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(sourceId) || ids.has(sourceId)) throw Error('INVALID_SOURCE_ID');
    ids.add(sourceId);
    if (!ALLOWED_PUBLISHERS.has(entry.publisher)) throw Error('UNAPPROVED_DOCUMENT_PUBLISHER');
    if (!ALLOWED_DOCUMENT_TYPES.has(entry.docType)) throw Error('UNSUPPORTED_DOCUMENT_TYPE');
    const permittedHosts = [...new Set((entry.permittedHosts || []).map(host => String(host).toLowerCase()))];
    if (permittedHosts.length === 0) throw Error('MISSING_PERMITTED_HOST');
    const canonicalUrl = assertPublicHttpsUrl(entry.canonicalUrl, permittedHosts).toString();
    const expectedMarkers = [...new Set((entry.expectedMarkers || []).map(value => String(value).trim()).filter(Boolean))];
    if (expectedMarkers.length < 2) throw Error('INSUFFICIENT_IDENTITY_MARKERS');
    const rightsStatus = String(entry.rightsEvidence?.status || 'UNVERIFIED').toUpperCase();
    if (!['APPROVED', 'UNVERIFIED', 'BLOCKED'].includes(rightsStatus)) throw Error('INVALID_RIGHTS_STATUS');
    return Object.freeze({
      sourceId,
      publisher: entry.publisher,
      canonicalUrl,
      permittedHosts: Object.freeze(permittedHosts),
      docType: entry.docType,
      expectedMarkers: Object.freeze(expectedMarkers),
      rightsEvidence: Object.freeze({ status: rightsStatus, checkedAt: entry.rightsEvidence?.checkedAt || null }),
      enabled: entry.enabled === true
    });
  });
}

function stripHtml(input, { removeTemplate = true } = {}) {
  let value = String(input || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  if (removeTemplate) value = value.replace(/<(nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function layoutFingerprint(input) {
  return String(input || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/>[^<]+</g, '><')
    .replace(/\s(?:id|class|style|data-[\w-]+)=(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function boundedEvidence(text, limit = 240) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function validateDocumentIdentity(entry, response, { maxBytes = 512_000 } = {}) {
  if (!response || typeof response !== 'object') return { matched: false, status: 'FETCH_FAILURE', reason: 'MISSING_RESPONSE' };
  const status = Number(response.status);
  if (!Number.isFinite(status) || status < 200 || status >= 400) {
    return { matched: false, status: 'FETCH_FAILURE', reason: `HTTP_${Number.isFinite(status) ? status : 0}` };
  }
  let finalUrl;
  try { finalUrl = assertPublicHttpsUrl(response.url || entry.canonicalUrl, entry.permittedHosts).toString(); }
  catch (error) { return { matched: false, status: 'DOCUMENT_MISMATCH', reason: error.message }; }
  const redirects = Array.isArray(response.redirects) ? response.redirects : [];
  if (redirects.length > 4) return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'TOO_MANY_REDIRECTS' };
  try { redirects.forEach(url => assertPublicHttpsUrl(url, entry.permittedHosts)); }
  catch (error) { return { matched: false, status: 'DOCUMENT_MISMATCH', reason: error.message }; }
  const contentType = String(response.contentType || 'text/html').toLowerCase();
  if (!/^(?:text\/(?:html|plain)|application\/pdf)(?:;|$)/.test(contentType)) {
    return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }
  const body = String(response.body || '');
  if (Buffer.byteLength(body, 'utf8') === 0) return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'EMPTY_DOCUMENT' };
  if (Buffer.byteLength(body, 'utf8') > maxBytes) return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'DOCUMENT_TOO_LARGE' };
  const allText = stripHtml(body, { removeTemplate: false });
  if (BLOCKED_PAGE_PATTERNS.some(pattern => pattern.test(allText))) {
    return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'WRONG_PAGE_CLASS' };
  }
  const lower = allText.toLocaleLowerCase('th-TH');
  const markerMatches = entry.expectedMarkers.filter(marker => lower.includes(marker.toLocaleLowerCase('th-TH')));
  if (markerMatches.length < Math.min(2, entry.expectedMarkers.length)) {
    return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'IDENTITY_MARKERS_MISSING', markerMatches };
  }
  const normalizedText = stripHtml(body);
  if (normalizedText.length < 40) return { matched: false, status: 'DOCUMENT_MISMATCH', reason: 'INSUFFICIENT_DOCUMENT_CONTENT' };
  return {
    matched: true,
    status: 'MATCHED_DOCUMENT',
    finalUrl,
    markerMatches,
    rawHash: hash(body),
    contentHash: hash(normalizedText.toLocaleLowerCase('th-TH')),
    layoutHash: hash(layoutFingerprint(body)),
    normalizedText,
    evidence: boundedEvidence(normalizedText)
  };
}

function classifyObservation(previous, current) {
  if (!current?.matched) return { status: current?.status || 'FETCH_FAILURE', reason: current?.reason || 'UNKNOWN_FAILURE' };
  if (!previous) return { status: 'FIRST_VERIFIED_BASELINE', changeType: 'BASELINE' };
  if (previous.sourceId !== current.sourceId) return { status: 'DOCUMENT_MISMATCH', reason: 'SOURCE_ID_MISMATCH' };
  if (previous.contentHash !== current.contentHash) {
    return {
      status: 'CHANGED',
      changeType: 'CONTENT_CHANGE',
      before: boundedEvidence(previous.normalizedText),
      after: boundedEvidence(current.normalizedText)
    };
  }
  if (previous.layoutHash !== current.layoutHash || previous.rawHash !== current.rawHash || previous.finalUrl !== current.finalUrl) {
    return { status: 'CHANGED', changeType: previous.finalUrl !== current.finalUrl ? 'DOCUMENT_MOVED' : 'LAYOUT_CHANGE' };
  }
  return { status: 'UNCHANGED', changeType: 'NONE' };
}

module.exports = {
  assertPublicHttpsUrl,
  classifyObservation,
  hash,
  stripHtml,
  validateDocumentIdentity,
  validateRegistry
};
