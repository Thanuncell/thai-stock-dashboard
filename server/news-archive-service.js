'use strict';

const { createHash } = require('node:crypto');
const { allowedNewsUrl, p1DisplayGateEnabled, isSlugNewsTitle } = require('../lib/news-policy');
const { dedupeNewsItems, newsFingerprint } = require('../lib/broker-news');
const { normalizeSymbol } = require('../lib/validation');
const { annotateNewsContent, reviewNewsItem, reviewNewsForDisplay } = require('../lib/news-quality');
const { normalizeNewsSources, newsMatchesSources, isNewsDocumentForDisplay, newsDisplayBlocked, newsSecuritySymbols, newsAssociationSymbols } = require('../lib/news-content');
const { withNewsRulesSummary } = require('../lib/news-summary');
const { trustedEvidence, projectEvidence, evidenceColumns, validStoredEvidence, restoreEvidence, newsAssociations, rowSubjectHash, canonicalUrl } = require('../lib/news-evidence');
const EVIDENCE_FIELDS = ['verification_status','verification_reason','verification_basis','verification_policy_version',
  'verification_checked_at','verification_subject_hash','verification_revision','canonical_url','canonical_key','verification_provenance'];

function rowItem(row) {
  return { title: row.title, url: row.url, source: row.source, sourceName: row.source_name, snippet: row.snippet || '',
    pubDate: row.published_at, brokerCategory: Boolean(row.broker_firms?.length),
    matchedSymbols: row.matched_symbols || [], matchedBrokerFirms: row.broker_firms || [] };
}

const RETENTION_DAYS = 365;
const MAX_PAGE_SIZE = 50;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_SCAN_CHUNK_SIZE = 500;
const MAX_ARCHIVE_SCAN_ROWS = 20_000;
const FEATURED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FEATURED_COUNT = 5;
const SOURCE_KEYS = new Set(['all', 'thunhoon', 'kaohoon', 'settrade', 'official', 'infoquest', 'efinance', 'broker', 'other']);
const SOURCE_TIER = Object.freeze({ official: 4, settrade: 3, infoquest: 2, efinance: 2, thunhoon: 2, kaohoon: 2, broker: 1 });

function archiveFingerprint(item, verification = item?.verification) {
  const record = trustedEvidence(item, verification);
  if (record?.archiveFingerprint && /^[a-f0-9]{64}$/.test(record.archiveFingerprint)) return record.archiveFingerprint;
  const original = record?.originalUrl && allowedNewsUrl(record.originalUrl);
  const identity = original?.hostname === 'news.google.com' ? { url: original.href } : item;
  return createHash('sha256').update(newsFingerprint(identity)).digest('hex');
}

function mergeRowAssociations(target, first, second) {
  const merged = newsAssociations({ matchedSymbols: [...first.matched_symbols, ...second.matched_symbols],
    matchedBrokerFirms: [...first.broker_firms, ...second.broker_firms] });
  target.matched_symbols = merged.matchedSymbols; target.broker_firms = merged.matchedBrokerFirms;
  target.verification_subject_hash = rowSubjectHash(target);
}

function reviewArchivedNewsRow(row) {
  if (!allowedNewsUrl(row?.url) || !Number.isFinite(Date.parse(row?.published_at))) return { status: 'REJECTED', reason: 'INVALID_ARCHIVE_IDENTITY' };
  const item = rowItem(row), metadata = reviewNewsItem(item);
  if (metadata.status === 'REJECTED') return metadata;
  if (!EVIDENCE_FIELDS.some(key => key !== 'verification_revision' && row[key] !== null && row[key] !== undefined)) return metadata;
  if (!validStoredEvidence(row)) return { status: 'UNVERIFIED', reason: 'ARCHIVE_EVIDENCE_MISMATCH', basis: 'metadata' };
  return reviewNewsItem(item, restoreEvidence(item, row));
}

// Offline review plan only. Hiding is enforced by the same read predicate; no SQL or delete action.
function planNewsArchiveCleanup(rows = []) {
  const candidates = rows.map(row => ({ fingerprint: row.fingerprint, ...reviewArchivedNewsRow(row) }))
    .filter(item => item.status !== 'VERIFIED').map(item => ({ ...item, action: 'HIDE_PENDING_REVIEW' }));
  return { dryRun: true, writes: 0, totalRows: rows.length,
    quarantined: candidates.filter(item=>item.status==='UNVERIFIED').length,
    rejected: candidates.filter(item=>item.status==='REJECTED').length, candidates };
}

function createNewsArchiveService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  scanChunkSize = ARCHIVE_SCAN_CHUNK_SIZE,
  maxScanRows = MAX_ARCHIVE_SCAN_ROWS,
  quarantine = new Map(),
  displayReview = async items=>items,
  displayProject = item=>item
} = {}) {
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const configured = Boolean(/^https:\/\//.test(baseUrl) && secretKey);
  const hardGate = p1DisplayGateEnabled(env);
  const evidenceMode = ['read', 'write'].includes(env.SETSCOPE_NEWS_EVIDENCE) ? env.SETSCOPE_NEWS_EVIDENCE : '';
  const safeScanChunkSize = Math.max(1, Math.min(1000, Number.parseInt(scanChunkSize, 10) || ARCHIVE_SCAN_CHUNK_SIZE));
  const safeMaxScanRows = Math.max(safeScanChunkSize, Math.min(100_000, Number.parseInt(maxScanRows, 10) || MAX_ARCHIVE_SCAN_ROWS));
  let lastCleanupAt = 0;
  let archiveSnapshot = null;
  let archiveSnapshotPending = null;
  let archiveSnapshotVersion = 0;

  function headers(extra = {}) {
    return { apikey: secretKey, ...(secretKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secretKey}` }), ...extra };
  }

  function toRow(item, verification = item?.verification, allowNegative = false) {
    const safeUrl = allowedNewsUrl(item?.url);
    const publishedAt = Date.parse(item?.pubDate);
    const timestamp = Number(now());
    const decision = reviewNewsItem(item, verification);
    if (!safeUrl || !String(item?.title || '').trim() || !Number.isFinite(publishedAt)
      || (decision.status !== 'VERIFIED' && !(allowNegative && trustedEvidence(item, verification)))) return null;
    if (publishedAt < timestamp - RETENTION_DAYS * 24 * 60 * 60 * 1000 || publishedAt > timestamp + 10 * 60 * 1000) return null;
    const row = {
      fingerprint: archiveFingerprint(item, verification),
      title: String(item.title).trim().slice(0, 500),
      url: safeUrl.href.slice(0, 2000),
      source: SOURCE_KEYS.has(item.source) && item.source !== 'all' ? item.source : 'other',
      source_name: String(item.sourceName || item.source || 'ข่าวหุ้นไทย').trim().slice(0, 160),
      snippet: String(item.snippet || '').trim().slice(0, 1200),
      published_at: new Date(publishedAt).toISOString(),
      fetched_at: new Date(timestamp).toISOString(),
      matched_symbols: [...new Set((Array.isArray(item.matchedSymbols) ? item.matchedSymbols : []).map(normalizeSymbol).filter(Boolean))].slice(0, 30),
      broker_firms: [...new Set((Array.isArray(item.matchedBrokerFirms) ? item.matchedBrokerFirms : []).map(value => String(value).slice(0, 12)))].slice(0, 10)
    };
    if (evidenceMode === 'write') {
      // Associations must have been observed before the trusted pipeline decision.
      // Deriving metadata acceptance here cannot authorize caller-supplied links.
      const associations = trustedEvidence(item, verification) ? newsAssociations(item) : newsAssociations({});
      row.matched_symbols = associations.matchedSymbols;
      row.broker_firms = associations.matchedBrokerFirms;
      const projected = rowItem(row);
      // Recheck the final stored shape, including truncation and broker attribution.
      const bound = projectEvidence(item, projected, decision);
      const finalDecision = reviewNewsItem(projected, bound);
      if (finalDecision.status !== decision.status) return null;
      const columns = evidenceColumns(projected, row, finalDecision);
      if (!columns) return null;
      Object.assign(row, columns);
    }
    return row;
  }

  async function request(path, init = {}) {
    const response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, { ...init, signal: init.signal || AbortSignal.timeout(12000) });
    if (!response.ok) throw Error(`News archive ${path.split('?')[0]} HTTP ${response.status}`);
    return response;
  }

  async function cleanupIfDue() {
    const timestamp = Number(now());
    if (timestamp - lastCleanupAt < CLEANUP_INTERVAL_MS) return false;
    await request('rpc/cleanup_news_archive', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ p_limit: CLEANUP_BATCH_SIZE })
    });
    lastCleanupAt = timestamp;
    return true;
  }

  function prepare(items = [], { assessments = [] } = {}) {
    const candidates = items.map(item => toRow(item)).filter(Boolean);
    if (evidenceMode === 'write') {
      for (const assessment of assessments.slice(0, 200)) {
        if (assessment.verification?.status === 'VERIFIED' || !trustedEvidence(assessment.item, assessment.verification)) continue;
        if(assessment.verification.status==='UNVERIFIED'&&reviewNewsItem(assessment.item,assessment.verification).status==='REJECTED')continue;
        const row = toRow(assessment.item, assessment.verification, true);
        if (row) candidates.push(row);
      }
    }
    const unique = new Map();
    for (const row of candidates) {
      const previous = unique.get(row.fingerprint);
      if (previous?.verification_status === 'VERIFIED' && row.verification_status === 'UNVERIFIED') continue;
      if (previous?.verification_checked_at && row.verification_checked_at
        && Date.parse(row.verification_checked_at) < Date.parse(previous.verification_checked_at)) continue;
      if (previous?.verification_status === 'REJECTED' && row.verification_status === 'VERIFIED' && row.verification_basis === 'metadata') continue;
      if (previous?.verification_basis === 'article' && previous.verification_status === 'VERIFIED'
        && row.verification_basis === 'metadata' && row.verification_status === 'VERIFIED') {
        if (previous.verification_subject_hash === row.verification_subject_hash) mergeRowAssociations(previous, previous, row);
        continue;
      }
      if (evidenceMode === 'write' && previous?.verification_status === 'VERIFIED' && row.verification_status === 'VERIFIED') {
        mergeRowAssociations(row, previous, row);
      }
      unique.set(row.fingerprint, row);
    }
    return [...unique.values()];
  }

  async function ingest(items = [], { assessments = [] } = {}) {
    if (!configured) return { configured: false, ingested: 0, cleanupRan: false };
    if (evidenceMode === 'read') return { configured: true, ingested: 0, cleanupRan: false, persistence: 'read-only' };
    const rows = prepare(items, { assessments });
    if (!rows.length) return { configured: true, ingested: 0, cleanupRan: false };
    // Feed ingestion refreshes metadata only. Omitted analysis columns cannot
    // overwrite a persisted AI summary, even during concurrent conflict updates.
    let ingested = rows.length, conflicts = 0, retained = 0;
    if (evidenceMode === 'write') {
      ingested = 0;
      for (let offset = 0; offset < rows.length; offset += 50) {
        const batch = rows.slice(offset, offset + 50);
        const params = new URLSearchParams({ select: 'fingerprint,verification_revision', fingerprint: `in.(${batch.map(row => row.fingerprint).join(',')})` });
        const current = await (await request(`news_archive?${params}`, { headers: headers() })).json();
        const revisions = new Map(current.map(row => [row.fingerprint, Number(row.verification_revision)]));
        const response = await request('rpc/upsert_news_archive_evidence', {
          method: 'POST', headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ p_rows: batch.map(row => ({ ...row, expected_revision: revisions.get(row.fingerprint) ?? -1 })) })
        });
        const outcomes = await response.json();
        if (!Array.isArray(outcomes) || outcomes.length !== batch.length
          || outcomes.some((outcome, index) => outcome.fingerprint !== batch[index].fingerprint
            || !['persisted','retained','conflict','not_inserted'].includes(outcome.outcome))) throw Error('News archive invalid write acknowledgement');
        ingested += outcomes.filter(row => row.outcome === 'persisted').length;
        conflicts += outcomes.filter(row => row.outcome === 'conflict').length;
        retained += outcomes.filter(row => row.outcome === 'retained').length;
      }
    } else {
      const params = new URLSearchParams({ on_conflict: 'fingerprint', columns: Object.keys(rows[0]).join(',') });
      await request(`news_archive?${params}`, {
      method: 'POST',
      headers: headers({
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(rows)
      });
    }
    archiveSnapshotVersion += 1;
    archiveSnapshot = null;
    let cleanupRan = false, cleanupUnavailable = false;
    try { if (ingested > 0) cleanupRan = await cleanupIfDue(); } catch { cleanupUnavailable = true; }
    return { configured: true, ingested, cleanupRan, ...(evidenceMode === 'write' ? { conflicts, retained } : {}),
      ...(cleanupUnavailable ? { cleanupUnavailable: true } : {}) };
  }

  function fromRow(row) {
    const safeUrl = allowedNewsUrl(row?.url);
    const item = {
      fingerprint: row?.fingerprint,
      title: row?.title,
      ...(row?.verification_provenance?.originalTitle?{rssTitle:row.verification_provenance.originalTitle}:{}),
      url: safeUrl?.href || '',
      source: row?.source,
      sourceName: row?.source_name,
      snippet: row?.snippet || '',
      pubDate: row?.published_at,
      firstSeenAt: row?.first_seen_at,
      fetchedAt: row?.fetched_at,
      matchedSymbols: row?.matched_symbols || [],
      matchedBrokerFirms: row?.broker_firms || [],
      brokerCategory: Boolean(row?.broker_firms?.length),
      analysisSummary: ['ai', 'rules'].includes(row?.analysis_mode) ? String(row?.analysis_summary || '').trim().slice(0, 450) : '',
      analysisMode: ['ai', 'rules'].includes(row?.analysis_mode) && String(row?.analysis_summary || '').trim() ? row.analysis_mode : ''
    };
    // Display-only exclusion, before snapshot count/dedup/pagination; never mutate a row.
    if (isNewsDocumentForDisplay(item)) return null;
    const verification = reviewArchivedNewsRow(row);
    const restored = {...item,verification};
    const discovery=trustedEvidence(restored)?.discovery;
    if(discovery)restored.discovery=discovery;
    const display = hardGate || restored.source==='thunhoon'&&isSlugNewsTitle(restored.title) ? reviewNewsForDisplay(restored,{now:Number(now())}) : verification;
    if (display.status !== 'VERIFIED') {
      if (hardGate) { quarantine.delete(newsFingerprint(item)); quarantine.set(newsFingerprint(item),{url:item.url,title:item.title,status:display.status,reason:display.reason}); while(quarantine.size>200)quarantine.delete(quarantine.keys().next().value); }
      return null;
    }
    return safeUrl ? annotateNewsContent(withNewsRulesSummary(restored),{now:Number(now())}) : null;
  }

  async function buildArchiveSnapshot() {
    const params = new URLSearchParams({
      select: 'fingerprint,title,url,source,source_name,snippet,published_at,first_seen_at,fetched_at,matched_symbols,broker_firms,analysis_summary,analysis_mode'
        + (evidenceMode ? ',' + EVIDENCE_FIELDS.join(',') : ''),
      order: 'published_at.desc,id.desc'
    });
    const rows = [];
    let exactTotal = null;
    let complete = false;
    for (let start = 0; start < safeMaxScanRows; start += safeScanChunkSize) {
      const end = Math.min(start + safeScanChunkSize - 1, safeMaxScanRows - 1);
      const response = await request(`news_archive?${params}`, {
        headers: headers({
          ...(start === 0 ? { Prefer: 'count=exact' } : {}),
          'Range-Unit': 'items',
          Range: `${start}-${end}`
        })
      });
      const chunk = await response.json();
      const totalMatch = String(response.headers.get('content-range') || '').match(/\/(\d+|\*)$/);
      if (totalMatch?.[1] && totalMatch[1] !== '*') {
        exactTotal = Number(totalMatch[1]);
        if (exactTotal > safeMaxScanRows) throw Error(`News archive exceeds bounded scan limit (${safeMaxScanRows})`);
      }
      rows.push(...chunk);
      if (!chunk.length || chunk.length < safeScanChunkSize || (exactTotal !== null && rows.length >= exactTotal)) {
        complete = true;
        break;
      }
    }
    if (!complete || (exactTotal !== null && rows.length < exactTotal)) {
      throw Error('News archive bounded scan ended before the complete dataset');
    }
    const accepted = rows.map(fromRow).filter(Boolean);
    const displayable = dedupeNewsItems(await displayReview(accepted));
    const review = planNewsArchiveCleanup(rows);
    return {
      items: displayable,
      rawTotal: rows.length,
      countExact: Number.isSafeInteger(exactTotal)&&rows.length===exactTotal,
      qualityFiltered: rows.length - accepted.length,
      quarantined: Math.max(review.quarantined, rows.length - accepted.length - review.rejected),
      rejected: review.rejected,
      deduplicated: accepted.length - displayable.length
    };
  }

  async function getArchiveSnapshot() {
    const timestamp = Number(now());
    if (archiveSnapshot && timestamp < archiveSnapshot.expiresAt) return archiveSnapshot;
    if (archiveSnapshotPending) return archiveSnapshotPending;
    const version = archiveSnapshotVersion;
    archiveSnapshotPending = buildArchiveSnapshot().then(snapshot => {
      const value = { ...snapshot, expiresAt: Number(now()) + ARCHIVE_SNAPSHOT_TTL_MS };
      if (version === archiveSnapshotVersion) archiveSnapshot = value;
      return value;
    }).finally(() => { archiveSnapshotPending = null; });
    return archiveSnapshotPending;
  }

  function eligibleItems(items, { source, symbol, query, excludeUrls }) {
    const normalizedQuery = String(query || '').trim().slice(0, 80).toLocaleLowerCase('th');
    const excluded = new Set((Array.isArray(excludeUrls) ? excludeUrls : []).slice(0, 10)
      .map(url => canonicalUrl(url)).filter(Boolean));
    return items.map(displayProject).filter(item => {
      if(newsDisplayBlocked(item))return false;
      const sourceMatch = newsMatchesSources(item,source);
      const identified=newsSecuritySymbols(item);
      const symbolMatch = !symbol || newsAssociationSymbols(item).includes(symbol);
      const searchMatch = !normalizedQuery || [item.title, item.sourceName, item.snippet, item.analysisSummary, ...(identified||[])]
        .some(value => String(value || '').toLocaleLowerCase('th').includes(normalizedQuery));
      return (!hardGate || reviewNewsForDisplay(item,{now:Number(now())}).status==='VERIFIED' && !quarantine.has(newsFingerprint(item))) && sourceMatch && symbolMatch && searchMatch && !excluded.has(canonicalUrl(item.url));
    });
  }

  async function list({ page = 1, pageSize = 10, source = 'all', symbol = '', query = '', excludeUrls = [], featuredCount = 0 } = {}) {
    const safePage = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
    const safePageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(pageSize, 10) || 10));
    const safeFeaturedCount = Math.max(0, Math.min(MAX_FEATURED_COUNT, Number.parseInt(featuredCount, 10) || 0));
    if (!configured) return { configured: false, featured: [], items: [], page: safePage, pageSize: safePageSize, total: 0, maxAgeDays: RETENTION_DAYS, coverage: 'unavailable' };
    const safeSource = normalizeNewsSources(source);
    const safeSymbol = normalizeSymbol(symbol);
    const snapshot = await getArchiveSnapshot();
    const displayable = eligibleItems(snapshot.items, {
      source: safeSource,
      symbol: safeSymbol,
      query,
      excludeUrls
    });
    const timestamp = Number(now());
    const featured = safeFeaturedCount > 0
      ? displayable.filter(item => {
        const published = Date.parse(item.pubDate);
        return Number.isFinite(published) && published >= timestamp - FEATURED_WINDOW_MS && published <= timestamp + 10 * 60 * 1000;
      }).sort((left, right) => (SOURCE_TIER[right.source] || 0) - (SOURCE_TIER[left.source] || 0)
        || Date.parse(right.pubDate) - Date.parse(left.pubDate)).slice(0, safeFeaturedCount)
      : [];
    const featuredKeys = new Set(featured.map(newsFingerprint));
    const paginated = featuredKeys.size ? displayable.filter(item => !featuredKeys.has(newsFingerprint(item))) : displayable;
    const start = (safePage - 1) * safePageSize;
    return {
      configured: true,
      featured,
      items: paginated.slice(start, start + safePageSize),
      page: safePage,
      pageSize: safePageSize,
      total: paginated.length,
      matchingTotal: displayable.length, countExact: snapshot.countExact, countCoverage:snapshot.countExact?'complete-archive-snapshot':'loaded-archive-snapshot', snapshotRows:snapshot.rawTotal, snapshotLimit:MAX_ARCHIVE_SCAN_ROWS,
      qualityFiltered: snapshot.qualityFiltered,
      quarantined: snapshot.quarantined,
      rejected: snapshot.rejected,
      deduplicated: snapshot.deduplicated,
      maxAgeDays: RETENTION_DAYS,
      coverage: 'up-to-365-days-subject-to-source-availability'
    };
  }

  return { configured, canQueue: configured && evidenceMode === 'write', ingest, list, prepare, restorePrepared: row => {
    if (!require('../lib/news-evidence').validStoredEvidence({...row,verification_revision:1})) throw Error('INVALID_PREPARED_NEWS');
    const item=rowItem(row);
    item.verification=restoreEvidence(item,{...row,verification_revision:1});
    const discovery=trustedEvidence(item)?.discovery;if(discovery)item.discovery=discovery;
    return item;
  } };
}

module.exports = {
  ARCHIVE_SCAN_CHUNK_SIZE,
  ARCHIVE_SNAPSHOT_TTL_MS,
  CLEANUP_BATCH_SIZE,
  MAX_ARCHIVE_SCAN_ROWS,
  MAX_PAGE_SIZE,
  RETENTION_DAYS,
  archiveFingerprint,
  createNewsArchiveService,
  planNewsArchiveCleanup,
  reviewArchivedNewsRow
};
