'use strict';

const { createHash } = require('node:crypto');
const { allowedNewsUrl } = require('../lib/news-policy');
const { dedupeNewsItems, newsFingerprint } = require('../lib/broker-news');
const { normalizeSymbol } = require('../lib/validation');
const { reviewNewsItem } = require('../lib/news-quality');
const { withNewsRulesSummary } = require('../lib/news-summary');

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

function archiveFingerprint(item) {
  return createHash('sha256').update(newsFingerprint(item)).digest('hex');
}

function reviewArchivedNewsRow(row) {
  if (!allowedNewsUrl(row?.url) || !Number.isFinite(Date.parse(row?.published_at))) return { status: 'REJECTED', reason: 'INVALID_ARCHIVE_IDENTITY' };
  return reviewNewsItem({ title: row.title, url: row.url, source: row.source, sourceName: row.source_name, snippet: row.snippet || '' });
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
  maxScanRows = MAX_ARCHIVE_SCAN_ROWS
} = {}) {
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const configured = Boolean(/^https:\/\//.test(baseUrl) && secretKey);
  const safeScanChunkSize = Math.max(1, Math.min(1000, Number.parseInt(scanChunkSize, 10) || ARCHIVE_SCAN_CHUNK_SIZE));
  const safeMaxScanRows = Math.max(safeScanChunkSize, Math.min(100_000, Number.parseInt(maxScanRows, 10) || MAX_ARCHIVE_SCAN_ROWS));
  let lastCleanupAt = 0;
  let archiveSnapshot = null;
  let archiveSnapshotPending = null;
  let archiveSnapshotVersion = 0;

  function headers(extra = {}) {
    return { apikey: secretKey, ...(secretKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secretKey}` }), ...extra };
  }

  function toRow(item) {
    const safeUrl = allowedNewsUrl(item?.url);
    const publishedAt = Date.parse(item?.pubDate);
    const timestamp = Number(now());
    if (!safeUrl || !String(item?.title || '').trim() || !Number.isFinite(publishedAt) || reviewNewsItem(item).status !== 'VERIFIED') return null;
    if (publishedAt < timestamp - RETENTION_DAYS * 24 * 60 * 60 * 1000 || publishedAt > timestamp + 10 * 60 * 1000) return null;
    return {
      fingerprint: archiveFingerprint(item),
      title: String(item.title).trim().slice(0, 500),
      url: safeUrl.href.slice(0, 2000),
      source: SOURCE_KEYS.has(item.source) && item.source !== 'all' ? item.source : 'other',
      source_name: String(item.sourceName || item.source || 'ข่าวหุ้นไทย').trim().slice(0, 160),
      snippet: String(item.snippet || '').trim().slice(0, 1200),
      published_at: new Date(publishedAt).toISOString(),
      fetched_at: new Date(timestamp).toISOString(),
      matched_symbols: [...new Set((item.matchedSymbols || []).map(normalizeSymbol).filter(Boolean))].slice(0, 30),
      broker_firms: [...new Set((item.matchedBrokerFirms || []).map(value => String(value).slice(0, 12)))].slice(0, 10)
    };
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

  async function ingest(items = []) {
    if (!configured) return { configured: false, ingested: 0, cleanupRan: false };
    const rows = [...new Map(items.map(toRow).filter(Boolean).map(row => [row.fingerprint, row])).values()];
    if (!rows.length) return { configured: true, ingested: 0, cleanupRan: false };
    // Feed ingestion refreshes metadata only. Omitted analysis columns cannot
    // overwrite a persisted AI summary, even during concurrent conflict updates.
    const params = new URLSearchParams({ on_conflict: 'fingerprint', columns: Object.keys(rows[0]).join(',') });
    await request(`news_archive?${params}`, {
      method: 'POST',
      headers: headers({
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(rows)
    });
    archiveSnapshotVersion += 1;
    archiveSnapshot = null;
    const cleanupRan = await cleanupIfDue();
    return { configured: true, ingested: rows.length, cleanupRan };
  }

  function fromRow(row) {
    const safeUrl = allowedNewsUrl(row?.url);
    const item = {
      fingerprint: row?.fingerprint,
      title: row?.title,
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
    const verification = reviewArchivedNewsRow(row);
    return safeUrl && verification.status === 'VERIFIED' ? withNewsRulesSummary({ ...item, verification }) : null;
  }

  async function buildArchiveSnapshot() {
    const params = new URLSearchParams({
      select: 'fingerprint,title,url,source,source_name,snippet,published_at,first_seen_at,fetched_at,matched_symbols,broker_firms,analysis_summary,analysis_mode',
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
    const displayable = dedupeNewsItems(accepted);
    const review = planNewsArchiveCleanup(rows);
    return {
      items: displayable,
      rawTotal: rows.length,
      qualityFiltered: rows.length - accepted.length,
      quarantined: review.quarantined,
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
      .map(url => allowedNewsUrl(url)).filter(Boolean).map(url => newsFingerprint({ url: url.href })));
    return items.filter(item => {
      const sourceMatch = source === 'all' || (source === 'broker' ? item.brokerCategory : item.source === source);
      const symbolMatch = !symbol || item.matchedSymbols.includes(symbol);
      const searchMatch = !normalizedQuery || [item.title, item.sourceName, item.snippet, item.analysisSummary]
        .some(value => String(value || '').toLocaleLowerCase('th').includes(normalizedQuery));
      return sourceMatch && symbolMatch && searchMatch && !excluded.has(newsFingerprint(item));
    });
  }

  async function list({ page = 1, pageSize = 10, source = 'all', symbol = '', query = '', excludeUrls = [], featuredCount = 0 } = {}) {
    const safePage = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
    const safePageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(pageSize, 10) || 10));
    const safeFeaturedCount = Math.max(0, Math.min(MAX_FEATURED_COUNT, Number.parseInt(featuredCount, 10) || 0));
    if (!configured) return { configured: false, featured: [], items: [], page: safePage, pageSize: safePageSize, total: 0, maxAgeDays: RETENTION_DAYS, coverage: 'unavailable' };
    const safeSource = SOURCE_KEYS.has(source) ? source : 'all';
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
      qualityFiltered: snapshot.qualityFiltered,
      quarantined: snapshot.quarantined,
      rejected: snapshot.rejected,
      deduplicated: snapshot.deduplicated,
      maxAgeDays: RETENTION_DAYS,
      coverage: 'up-to-365-days-subject-to-source-availability'
    };
  }

  return { configured, ingest, list };
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
