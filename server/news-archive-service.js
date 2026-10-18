'use strict';

const { createHash } = require('node:crypto');
const { allowedNewsUrl } = require('../lib/news-policy');
const { newsFingerprint } = require('../lib/broker-news');
const { normalizeSymbol } = require('../lib/validation');

const RETENTION_DAYS = 365;
const MAX_PAGE_SIZE = 50;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SOURCE_KEYS = new Set(['all', 'thunhoon', 'kaohoon', 'settrade', 'official', 'infoquest', 'efinance', 'broker', 'other']);

function archiveFingerprint(item) {
  return createHash('sha256').update(newsFingerprint(item)).digest('hex');
}

function createNewsArchiveService({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const secretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  const baseUrl = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const configured = Boolean(/^https:\/\//.test(baseUrl) && secretKey);
  let lastCleanupAt = 0;

  function headers(extra = {}) {
    return { apikey: secretKey, Authorization: `Bearer ${secretKey}`, ...extra };
  }

  function toRow(item) {
    const safeUrl = allowedNewsUrl(item?.url);
    const publishedAt = Date.parse(item?.pubDate);
    const timestamp = Number(now());
    if (!safeUrl || !String(item?.title || '').trim() || !Number.isFinite(publishedAt)) return null;
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
      broker_firms: [...new Set((item.matchedBrokerFirms || []).map(value => String(value).slice(0, 12)))].slice(0, 10),
      analysis_summary: item.analysisSummary ? String(item.analysisSummary).slice(0, 450) : null,
      analysis_mode: item.analysisMode ? String(item.analysisMode).slice(0, 24) : null
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
    await request('news_archive?on_conflict=fingerprint', {
      method: 'POST',
      headers: headers({
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(rows)
    });
    const cleanupRan = await cleanupIfDue();
    return { configured: true, ingested: rows.length, cleanupRan };
  }

  async function list({ page = 1, pageSize = 10, source = 'all', symbol = '' } = {}) {
    const safePage = Math.max(1, Math.min(100000, Number.parseInt(page, 10) || 1));
    const safePageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number.parseInt(pageSize, 10) || 10));
    if (!configured) return { configured: false, items: [], page: safePage, pageSize: safePageSize, total: 0, maxAgeDays: RETENTION_DAYS, coverage: 'unavailable' };
    const safeSource = SOURCE_KEYS.has(source) ? source : 'all';
    const safeSymbol = normalizeSymbol(symbol);
    const params = new URLSearchParams({
      select: 'fingerprint,title,url,source,source_name,snippet,published_at,first_seen_at,fetched_at,matched_symbols,broker_firms,analysis_summary,analysis_mode',
      order: 'published_at.desc,id.desc'
    });
    if (safeSource === 'broker') params.set('broker_firms', 'not.eq.{}');
    else if (safeSource !== 'all') params.set('source', `eq.${safeSource}`);
    if (safeSymbol) params.set('matched_symbols', `cs.{${safeSymbol}}`);
    const start = (safePage - 1) * safePageSize;
    const end = start + safePageSize - 1;
    const response = await request(`news_archive?${params}`, {
      headers: headers({ Prefer: 'count=exact', 'Range-Unit': 'items', Range: `${start}-${end}` })
    });
    const rows = await response.json();
    const contentRange = response.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+|\*)$/);
    const total = totalMatch && totalMatch[1] !== '*' ? Number(totalMatch[1]) : rows.length;
    return {
      configured: true,
      items: rows.map(row => ({
        fingerprint: row.fingerprint,
        title: row.title,
        url: row.url,
        source: row.source,
        sourceName: row.source_name,
        snippet: row.snippet || '',
        pubDate: row.published_at,
        firstSeenAt: row.first_seen_at,
        fetchedAt: row.fetched_at,
        matchedSymbols: row.matched_symbols || [],
        matchedBrokerFirms: row.broker_firms || [],
        brokerCategory: Boolean(row.broker_firms?.length),
        analysisSummary: row.analysis_summary,
        analysisMode: row.analysis_mode
      })),
      page: safePage,
      pageSize: safePageSize,
      total,
      maxAgeDays: RETENTION_DAYS,
      coverage: 'up-to-365-days-subject-to-source-availability'
    };
  }

  return { configured, ingest, list };
}

module.exports = { CLEANUP_BATCH_SIZE, MAX_PAGE_SIZE, RETENTION_DAYS, archiveFingerprint, createNewsArchiveService };
