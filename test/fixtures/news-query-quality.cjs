'use strict';
// Synthetic, pre-quality-change index. No network or original-row writes.
const { createHash } = require('node:crypto');
const { dedupeNewsGroups } = require('../../lib/broker-news');
const { canonicalUrl, issueEvidence, evidenceColumns, restoreEvidence } = require('../../lib/news-evidence');
const { newsPublisherKey } = require('../../lib/news-content');
const owner = require('./investing-owner-pages.json');
const accepted = require('./investing-news-quality.json').articles;
const OLD_POLICY = 'news-query-1:read:metadata';
const digest = value => createHash('sha256').update(value).digest('hex');
const rowItem = row => ({ fingerprint: row.fingerprint, title: row.title, url: row.url, source: row.source, sourceName: row.source_name,
  snippet: row.snippet, pubDate: row.published_at, matchedSymbols: row.matched_symbols, matchedBrokerFirms: row.broker_firms,
  brokerCategory: Boolean(row.broker_firms.length), analysisMode: row.analysis_mode, analysisSummary: row.analysis_summary });

function fixtureRows() {
  const at = Date.now() - 60000;
  const items = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'other-' + i, title: i >= 2 ? 'PTT quality-retain same-headline different-stories' : 'PTT quality-retain distinct-story-' + i,
      snippet: 'บริษัทเปิดเผยรายละเอียดผลประกอบการและการลงทุนตามข่าวต้นทาง', source: 'infoquest', sourceName: 'InfoQuest' })),
    ...accepted.map(row => ({ ...row, id: 'investing-' + row.id, source: 'other', sourceName: 'Investing.com' })),
    ...owner.cases.map(row => ({ ...row, title: row.title + ' - Investing.com', snippet: accepted[0].snippet, source: 'other', sourceName: 'Investing.com' })),
    { id: 'uncertain', title: accepted[1].title, snippet: 'Thailand stocks', source: 'other', sourceName: 'Investing.com' }
  ];
  const rows = items.map((item, i) => {
    const value = { ...item, url: 'https://news.google.com/rss/articles/query-quality-' + item.id,
      pubDate: new Date(at - i * 1000).toISOString(), matchedSymbols: ['PTT'], matchedBrokerFirms: [] };
    // This is deliberately the older positive decision, not current acceptance.
    const proof = issueEvidence(value, { status: 'VERIFIED', reason: 'NEWS_METADATA_EVIDENCE', basis: 'metadata' });
    const row = { id: i + 1, fingerprint: digest(item.id), title: value.title, url: value.url, source: value.source, source_name: value.sourceName,
      snippet: value.snippet, published_at: value.pubDate, fetched_at: value.pubDate, first_seen_at: value.pubDate,
      matched_symbols: ['PTT'], broker_firms: [], analysis_mode: 'ai', analysis_summary: 'Stored synthetic summary' };
    return { ...row, ...evidenceColumns(value, row, proof), verification_revision: 1 };
  });
  const first = rowItem(rows[4]), duplicate = { ...first, url: first.url + '?utm_source=duplicate' };
  const row = { ...rows[4], id: rows.length + 1, fingerprint: digest('duplicate'), url: duplicate.url };
  Object.assign(row, evidenceColumns(duplicate, row, issueEvidence(duplicate, { status: 'VERIFIED', reason: 'NEWS_METADATA_EVIDENCE', basis: 'metadata' })));
  rows.push(row);
  return rows;
}

function legacyGroups(rows) {
  const ordered = rows.slice().sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id);
  const items = ordered.map(row => { const item = rowItem(row); return { ...item, verification: restoreEvidence(item, row) }; });
  const raw = new Map(rows.map(row => [row.fingerprint, row]));
  return dedupeNewsGroups(items).map(group => {
    const item = group.item, first = raw.get(group.first.fingerprint);
    const key = digest(OLD_POLICY + '\0' + group.contributors.map(value => value.fingerprint).sort().join('\0'));
    return { projection: { group_key: key, aliases: group.aliases, order_published_at: first.published_at, order_id: String(first.id),
      winner_published_at: new Date(item.pubDate).toISOString(), winner_fingerprint: item.fingerprint, source: item.source, publisher: newsPublisherKey(item),
      blocked: false, broker: item.brokerCategory, symbols: item.matchedSymbols,
      search_fields: [item.title, item.sourceName, item.snippet, item.analysisSummary].map(value => String(value || '').toLocaleLowerCase('th')),
      url_identity: canonicalUrl(item.url), source_tier: item.source === 'infoquest' ? 2 : 0 },
      fingerprints: group.contributors.map(value => value.fingerprint) };
  });
}

function memoryQuery(rows = fixtureRows()) {
  const raw = new Map(rows.map(row => [row.fingerprint, structuredClone(row)]));
  const groups = new Map(), indexed = new Map(), dirty = new Set(), calls = [];
  let policy = OLD_POLICY, sourceRevision = 1, indexRevision = 1;
  for (const group of legacyGroups(rows)) {
    groups.set(group.projection.group_key, group.projection);
    for (const fingerprint of group.fingerprints) indexed.set(fingerprint, { fingerprint, group_key: group.projection.group_key, quality_status: 'VERIFIED' });
  }
  const order = (a, b) => Date.parse(b.order_published_at) - Date.parse(a.order_published_at) || Number(b.order_id) - Number(a.order_id);
  const rpc = (name, args) => {
    const decorated = fingerprints => fingerprints.map(key => ({ ...raw.get(key), _query_digest: digest(JSON.stringify(raw.get(key))) }));
    if (name === 'news_archive_query_reset') { groups.clear(); indexed.clear(); dirty.clear(); for (const key of raw.keys()) dirty.add(key); policy = args.p_policy; indexRevision++; return true; }
    if (name === 'news_archive_query_work') { const keys = [...dirty].sort().slice(0, args.p_limit); return { policy, sourceRevision: String(sourceRevision), indexRevision: String(indexRevision), fingerprints: keys, rows: decorated(keys) }; }
    if (name === 'news_archive_query_components') {
      const keys = [...groups.values()].filter(group => group.aliases.some(alias => args.p_aliases.includes(alias)) || args.p_fingerprints.some(key => indexed.get(key)?.group_key === group.group_key)).map(group => group.group_key);
      return { sourceRevision: String(sourceRevision), indexRevision: String(indexRevision), groups: keys, rows: decorated([...indexed.values()].filter(row => keys.includes(row.group_key)).map(row => row.fingerprint)) };
    }
    if (name === 'news_archive_query_commit') {
      if (String(args.p_source_revision) !== String(sourceRevision) || String(args.p_index_revision) !== String(indexRevision)) return { committed: false };
      if (args.p_policy !== policy) throw Error('NEWS_QUERY_POLICY_MISMATCH');
      for (const key of args.p_removed) groups.delete(key);
      for (const [key, row] of indexed) if (args.p_removed.includes(row.group_key) || args.p_dirty.includes(key)) indexed.delete(key);
      for (const group of args.p_groups) groups.set(group.group_key, group);
      for (const row of args.p_rows) { indexed.set(row.fingerprint, row); dirty.delete(row.fingerprint); }
      for (const key of args.p_dirty) dirty.delete(key);
      indexRevision++; return { committed: true, pending: dirty.size };
    }
    if (name !== 'list_news_archive_query') throw Error('Unexpected fixture operation');
    if (policy !== args.p_policy) throw Error('NEWS_QUERY_POLICY_NOT_READY');
    if (dirty.size || indexed.size !== raw.size) throw Error('NEWS_QUERY_INDEX_NOT_READY');
    const eligible = [...groups.values()].filter(group => !group.blocked
      && (args.p_sources.includes('all') || args.p_sources.includes(group.publisher) || args.p_sources.includes(group.source))
      && (!args.p_symbol || group.symbols.includes(args.p_symbol))
      && (!args.p_query || group.search_fields.some(value => value.includes(args.p_query)))
      && !group.aliases.some(alias => args.p_exclude.includes(alias)));
    const featured = eligible.slice().sort((a, b) => b.source_tier - a.source_tier || Date.parse(b.winner_published_at) - Date.parse(a.winner_published_at) || order(a, b)).slice(0, args.p_featured);
    const latest = eligible.filter(group => !featured.includes(group)).sort(order);
    const page = latest.slice((args.p_page - 1) * args.p_page_size, args.p_page * args.p_page_size);
    return { total: latest.length, matchingTotal: eligible.length, countExact: true, page: args.p_page, pageSize: args.p_page_size,
      rawTotal: raw.size, qualityFiltered: [...indexed.values()].filter(row => !row.group_key).length,
      rejected: [...indexed.values()].filter(row => row.quality_status === 'REJECTED').length,
      quarantined: [...indexed.values()].filter(row => row.quality_status === 'UNVERIFIED').length,
      deduplicated: [...indexed.values()].filter(row => row.group_key).length - groups.size,
      pageKeys: page.map(group => group.group_key), featuredKeys: featured.map(group => group.group_key),
      groups: [...featured, ...page].map(group => ({ key: group.group_key, projection: group, rows: [...indexed.values()].filter(row => row.group_key === group.group_key).map(row => raw.get(row.fingerprint)) })) };
  };
  const fetchImpl = async (value, init) => {
    const url = new URL(value); if (url.origin !== 'https://query-quality.invalid') throw Error('Fixture origin required');
    if (!url.pathname.startsWith('/rest/v1/rpc/')) throw Error('Only derived-index RPCs are permitted');
    const name = url.pathname.split('/').at(-1), args = JSON.parse(init.body); calls.push({ name, args });
    try { return Response.json(rpc(name, args)); } catch (error) { throw error; }
  };
  return { rows, raw, groups, indexed, dirty, calls, fetchImpl, rpc, get policy() { return policy; } };
}
module.exports = { OLD_POLICY, fixtureRows, legacyGroups, memoryQuery };
