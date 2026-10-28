'use strict';
const { inspectNewsArticle } = require('../../lib/news-article');
const { issueEvidence } = require('../../lib/news-evidence');
const { createNewsArchiveService } = require('../../server/news-archive-service');
const env = { SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SECRET_KEY: 'synthetic-fixture', SETSCOPE_NEWS_EVIDENCE: 'write', SETSCOPE_P1_DISPLAY_GATE: 'on', SETSCOPE_GOOGLE_NEWS_RPC: 'on' };

function article(overrides = {}) {
  const item = { title: 'Q3', url: 'https://thunhoon.com/article-123456', source: 'thunhoon', sourceName: 'Thunhoon',
    snippet: '', pubDate: new Date(Date.now()-1000).toISOString(), ...overrides };
  const inspection = inspectNewsArticle('<script type="application/ld+json">'+JSON.stringify({
    '@type':'NewsArticle',url:item.url,headline:item.title,datePublished:item.pubDate,articleBody:'Synthetic article identity and content fixture. '.repeat(5)
  })+'</script>', { url:item.url,title:item.title,strict:true });
  item.verification = issueEvidence(item, { status:'VERIFIED',reason:'ARTICLE_IDENTITY_VERIFIED',basis:'article' },
    { inspection, checkedAt: overrides.checkedAt || Date.now(), pathway:'fixture/article',originalUrl:item.url });
  return item;
}

function memoryTransport({ failWrite = false, failCleanup = false } = {}) {
  const rows = new Map(), calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input); calls.push({url,init});
    if (url.pathname.endsWith('/cleanup_news_archive')) {
      if (failCleanup) throw Error('fixture cleanup unavailable');
      return Response.json(0);
    }
    if (url.pathname.endsWith('/upsert_news_archive_evidence')) {
      if (failWrite) throw Error('fixture database unavailable');
      const outcomes = JSON.parse(init.body).p_rows.map(row => {
        const old = rows.get(row.fingerprint);
        if ((old?.verification_revision ?? -1)!==row.expected_revision) return {fingerprint:row.fingerprint,outcome:'conflict'};
        rows.set(row.fingerprint,{...old,...row,verification_revision:(old?.verification_revision||0)+1,first_seen_at:old?.first_seen_at||new Date().toISOString()});
        return {fingerprint:row.fingerprint,outcome:'persisted'};
      });
      return Response.json(outcomes);
    }
    const selected = [...rows.values()].filter(row => !url.searchParams.has('fingerprint') || url.searchParams.get('fingerprint').includes(row.fingerprint));
    const [start,end] = String(init.headers?.Range||'0-999').split('-').map(Number);
    return Response.json(selected.slice(start,end+1), {headers:{'content-range':`${start}-${Math.max(start,start+selected.length-1)}/${selected.length}`}});
  };
  return { rows,calls,fetchImpl,service:()=>createNewsArchiveService({env,fetchImpl}) };
}
module.exports = { env,article,memoryTransport };
