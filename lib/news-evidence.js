'use strict';

const { createHash } = require('node:crypto');
const { allowedNewsUrl } = require('./news-policy');
const { normalizeSymbol } = require('./validation');
const POLICY = 'news-quality-1';
const IDENTITY = 'news-url-1';
const inspections = new WeakSet();
const evidence = new WeakMap();
const batches = new WeakMap();
const digest = value => createHash('sha256').update(value).digest('hex');

function newsAssociations(item) {
  const values = (input, normalize, limit) => [...new Set((Array.isArray(input) ? input : [])
    .map(normalize).filter(Boolean))].slice(0, limit);
  return {
    matchedSymbols: values(item.matchedSymbols, normalizeSymbol, 30),
    matchedBrokerFirms: values(item.matchedBrokerFirms, value => {
      const firm = String(value || '').trim().toUpperCase();
      return /^[A-Z0-9&.-]{1,12}$/.test(firm) ? firm : null;
    }, 10)
  };
}

function canonicalUrl(value) {
  const url = allowedNewsUrl(value);
  if (!url) return null;
  url.hash = '';
  url.hostname = url.hostname.replace(/^www\./, '');
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, '') || '/';
  return url.href;
}

function itemSubject(item) {
  return JSON.stringify([item.title || '', item.url || '', item.source || '', item.sourceName || '',
    item.snippet || '', Boolean(item.brokerCategory || item.source === 'broker'), item.pubDate || '',
    item.resolvedUrl || item.canonicalUrl || item.url || '', newsAssociations(item)]);
}

function registerInspection(result) {
  if (result.status === 'VERIFIED') inspections.add(result);
  return Object.freeze(result);
}

function issueEvidence(item, decision, { inspection, checkedAt = Date.now(), originalUrl = item.url, pathway = 'metadata' } = {}) {
  if (decision.basis === 'article' && decision.status === 'VERIFIED'
    && (!inspections.has(inspection) || canonicalUrl(item.url) !== inspection.resolvedUrl)) return null;
  if (inspection?.publishedAt && Date.parse(item.pubDate) !== Date.parse(inspection.publishedAt)) return null;
  const value = Object.freeze({ status: decision.status, reason: decision.reason, basis: decision.basis,
    ...(inspection?.publishedAt ? {displayPolicy:'news-display-1'} : {}) });
  evidence.set(value, Object.freeze({ subject: itemSubject(item), checkedAt: new Date(checkedAt).toISOString(),
    articlePublishedAt: inspection?.publishedAt || null,
    originalUrl: allowedNewsUrl(originalUrl)?.href || null, canonicalUrl: canonicalUrl(item.url), pathway }));
  return value;
}

function trustedEvidence(item, value = item.verification) {
  const record = value && evidence.get(value);
  return record && record.subject === itemSubject(item) ? record : null;
}

function projectEvidence(item, projected, value) {
  const record = trustedEvidence(item, value);
  if (!record || canonicalUrl(projected.url) !== record.canonicalUrl) return null;
  const copy = Object.freeze({ ...value });
  evidence.set(copy, Object.freeze({ ...record, subject: itemSubject(projected) }));
  return copy;
}

function mergeEvidenceAssociations(item, projected, contributors = []) {
  if (!trustedEvidence(item, item.verification) || item.verification.status !== 'VERIFIED') return projected;
  const trusted = [item, ...contributors].filter(value => trustedEvidence(value, value.verification)
    && value.verification.status === 'VERIFIED' && canonicalUrl(value.url) === canonicalUrl(item.url));
  const allowed = newsAssociations({ matchedSymbols: trusted.flatMap(value => value.matchedSymbols || []),
    matchedBrokerFirms: trusted.flatMap(value => value.matchedBrokerFirms || []) });
  const merged = newsAssociations(projected);
  const safe = { ...projected, matchedSymbols: merged.matchedSymbols.filter(value => allowed.matchedSymbols.includes(value)),
    matchedBrokerFirms: merged.matchedBrokerFirms.filter(value => allowed.matchedBrokerFirms.includes(value)) };
  safe.brokerCategory = Boolean(safe.matchedBrokerFirms.length);
  let proof = item;
  for (const candidate of trusted) {
    const sameSubject = itemSubject({ ...candidate, ...newsAssociations(item), brokerCategory: item.brokerCategory }) === itemSubject(item);
    if (sameSubject && (proof.verification.basis !== 'article' || candidate.verification.basis === 'article')
      && Date.parse(trustedEvidence(candidate).checkedAt) > Date.parse(trustedEvidence(proof).checkedAt)) proof = candidate;
  }
  return { ...safe, verification: projectEvidence(proof, safe, proof.verification) };
}

function rowSubjectHash(row) {
  const fields = [row.title, row.url, row.source, row.source_name, row.snippet || '',
    new Date(row.published_at).toISOString(), row.broker_firms?.length ? '1' : '0', row.canonical_url || ''];
  return digest(fields.map(value => `${Buffer.byteLength(String(value), 'utf8')}:${value}`).join(''));
}

function evidenceColumns(item, row, verification) {
  const record = trustedEvidence(item, verification);
  if (!record) return null;
  return {
    verification_status: verification.status, verification_reason: verification.reason,
    verification_basis: verification.basis, verification_policy_version: POLICY,
    verification_checked_at: record.checkedAt, verification_subject_hash: rowSubjectHash({ ...row, canonical_url: record.canonicalUrl }),
    canonical_url: record.canonicalUrl, canonical_key: digest(IDENTITY + ':' + record.canonicalUrl),
    verification_provenance: { identityVersion: IDENTITY, pathway: record.pathway,
      originalUrl: record.originalUrl, resolvedUrl: verification.basis === 'article' ? record.canonicalUrl : null,
      publisher: row.source_name,
      ...(record.articlePublishedAt ? {displayPolicy:'news-display-1',articlePublishedAt:record.articlePublishedAt} : {}) }
  };
}

function validStoredEvidence(row) {
  return Boolean(allowedNewsUrl(row.url)) && Number.isFinite(Date.parse(row.published_at))
    && ['VERIFIED', 'UNVERIFIED', 'REJECTED'].includes(row.verification_status)
    && ['metadata', 'article'].includes(row.verification_basis)
    && typeof row.verification_reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(row.verification_reason)
    && row.verification_policy_version === POLICY && Number.isFinite(Date.parse(row.verification_checked_at))
    && Number.isSafeInteger(Number(row.verification_revision)) && Number(row.verification_revision) > 0
    && row.verification_subject_hash === rowSubjectHash(row)
    && row.canonical_url === canonicalUrl(row.url)
    && row.canonical_key === digest(IDENTITY + ':' + row.canonical_url)
    && row.verification_provenance?.identityVersion === IDENTITY
    && row.verification_provenance.publisher === row.source_name
    && (row.verification_status !== 'VERIFIED' || (row.verification_basis === 'article'
      ? row.verification_reason === 'ARTICLE_IDENTITY_VERIFIED' && row.verification_provenance.resolvedUrl === row.canonical_url
      : row.verification_reason === 'NEWS_METADATA_EVIDENCE'));
}

function restoreEvidence(item, row) {
  if (!validStoredEvidence(row)) return null;
  const dateBound = row.verification_provenance?.displayPolicy === 'news-display-1'
    && Date.parse(row.verification_provenance.articlePublishedAt) === Date.parse(row.published_at);
  const value = Object.freeze({ status: row.verification_status, reason: row.verification_reason, basis: row.verification_basis,
    ...(dateBound ? {displayPolicy:'news-display-1'} : {}) });
  evidence.set(value, Object.freeze({ subject: itemSubject(item), checkedAt: row.verification_checked_at,
    articlePublishedAt: dateBound ? row.verification_provenance.articlePublishedAt : null,
    originalUrl: row.verification_provenance.originalUrl, canonicalUrl: row.canonical_url,
    pathway: row.verification_provenance.pathway }));
  return value;
}

function rememberAssessments(payload, assessments) { batches.set(payload, assessments); return payload; }
function getAssessments(payload) { return batches.get(payload) || []; }

module.exports = { POLICY, IDENTITY, canonicalUrl, newsAssociations, registerInspection, issueEvidence, trustedEvidence, projectEvidence, mergeEvidenceAssociations,
  rowSubjectHash, evidenceColumns, validStoredEvidence, restoreEvidence, rememberAssessments, getAssessments };
