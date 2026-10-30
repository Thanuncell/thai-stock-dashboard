'use strict';

const http = require('node:http');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { normalizeMarketSymbols, normalizeSymbol, normalizeWatchlistNewsStocks, normalizeWatchlistsPayload } = require('./lib/validation');
const { createAuthService } = require('./server/auth-service');
const { createCoverageRepository } = require('./server/coverage-service');
const { createControlledCoverage, createManualCoverageHandler } = require('./server/controlled-coverage');
const { invalidateVerifiedMarket } = require('./server/market-refresh');
const { createMarketOverviewService } = require('./server/market-overview-service');
const { createSettradeProvider } = require('./server/market-overview-providers/settrade');
const { createMarketService } = require('./server/market-service');
const { createNewsArchiveService } = require('./server/news-archive-service');
const { getAssessments } = require('./lib/news-evidence');
const { createNewsService } = require('./server/news-service');
const { createObservability } = require('./server/observability');
const {
  PROVIDER_POLICIES,
  createMemoryCache,
  createWatchlistNewsCacheKey,
  isTransientProviderError,
  retryWithBackoff
} = require('./server/reliability');
const { createWatchlistService } = require('./server/watchlist-service');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ico': 'image/x-icon'
};
const PUBLIC_FILES = new Set([
  '/index.html', '/app.js', '/auth.js', '/theme-init.js', '/client/domain.mjs', '/lib/news-content.js',
  '/style.css', '/analysis.css', '/about.html', '/privacy.html', '/terms.html', '/disclaimer.html'
]);

function configuredSupabaseOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch (_) {
    return null;
  }
}

const supabaseOrigin = configuredSupabaseOrigin(process.env.SUPABASE_URL);
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self'${supabaseOrigin ? ` ${supabaseOrigin}` : ''}`,
  "form-action 'self'"
].join('; ');
const SECURITY_HEADERS = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin'
};

function send(res, status, body, headers = {}) {
  observability.markPayload(res, body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64000) {
        reject(Error('ข้อมูลมีขนาดใหญ่เกินไป'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (_) { reject(Error('รูปแบบข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

const hits = new Map();
function limited(key, max, windowMs = 60000) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(time => now - time < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return true;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10000) hits.delete(hits.keys().next().value);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) {
    const recent = list.filter(time => now - time < 60000);
    if (recent.length) hits.set(key, recent);
    else hits.delete(key);
  }
}, 60000).unref();

const observability = createObservability();
const responseCache = createMemoryCache({ maxEntries: 200 });
const providerFetch = observability.observedFetch(globalThis.fetch);
const newsReliability = require('./server/news-source-reliability').createNewsSourceReliability({pausedSources:String(process.env.SETSCOPE_NEWS_PAUSED_SOURCES||'').split(',').map(x=>x.trim()).filter(Boolean),onEvent:fields=>observability.emit('news_source',fields)});
const articleFetch = newsReliability.wrap(observability.observedFetch(require('./lib/news-fetch').createNewsTransport()),'extraction');
const authService = createAuthService({ send, fetchImpl: providerFetch });
const coverageRepository = createCoverageRepository({ fetchImpl: providerFetch });
const marketService = createMarketService({ fetchImpl: providerFetch });
const searchRegistry = async () => {
    if (!coverageRepository.configured) return [];
    const result = await responseCache.get('search-registry', {ttlMs:300000,staleIfErrorMs:0,errorBackoffMs:5000}, () => coverageRepository.listSearchCandidates());
    return result.value;
  };
const stockSearchService = require('./server/search-service').createStockSearchService({
  providerSearch: (query, options) => marketService.search(query, options),
  registrySearch: searchRegistry
});
const manualCoverageHandler = createManualCoverageHandler({
  controller: createControlledCoverage({ fetchImpl: providerFetch,
    onVerified: (symbol, verification) => invalidateVerifiedMarket(responseCache, symbol, verification) }), readJson, send
});
class NewsQuarantine extends Map {
  revision = 0;
  set(key,value) { const old=this.get(key); if(!old||old.status!==value.status||old.reason!==value.reason)this.revision++; return super.set(key,value); }
  delete(key) { const removed=super.delete(key); if(removed)this.revision++; return removed; }
}
const newsQuarantine = new NewsQuarantine();
const articleLoader = require('./lib/news-resolver').createNewsArticleLoader({transport:articleFetch,allowGoogleRpc:process.env.SETSCOPE_GOOGLE_NEWS_RPC==='on'});
const {newsAssociationSymbols}=require('./lib/news-content');
const newsLinkReview = require('./server/news-link-review').createNewsLinkReview({loadArticle:articleLoader,registrySearch:searchRegistry});
let durableNewsIngest;
const newsService = createNewsService({ onDiscovered: async items => {
  try { await durableNewsIngest.captureDiscovered(items); }
  catch { console.warn('News queue discovery admission unavailable'); }
}, reliability:newsReliability, articleLoader, displayProject:newsLinkReview.project, fetchImpl: providerFetch, articleFetch, quarantine:newsQuarantine, registrySearch: searchRegistry });
const newsArchiveService = createNewsArchiveService({ displayOverlays:()=>newsLinkReview.queryOverlays, displayBlockedUrls:()=>newsLinkReview.withheldUrls, displayReview:newsLinkReview.review, displayProject:newsLinkReview.project, fetchImpl: providerFetch, quarantine:newsQuarantine });
const newsWorkStore = require('./server/news-work-store').createNewsWorkStore({ fetchImpl: providerFetch });
durableNewsIngest = require('./server/news-work').createDurableNewsIngest({ archive: newsArchiveService, store: newsWorkStore, review: newsService.reviewDiscovered });
const settradeProvider = createSettradeProvider({ fetchImpl: providerFetch });
const marketOverviewService = createMarketOverviewService({ provider: settradeProvider });
const watchlistService = createWatchlistService({ fetchImpl: providerFetch });
const newsAnalysisCalls = new Map();

async function loadCached(res, key, policy, load, options) {
  const result = await responseCache.get(key, policy, load, options);
  observability.markCache(res, result.meta);
  return result.value;
}

async function loadNewsAndArchive() {
  const data = await newsService.getNews();
  try { await durableNewsIngest.ingest(data.items, { assessments: getAssessments(data) }); }
  catch (error) { console.warn('News archive write unavailable'); }
  return {...data,items:await newsLinkReview.review(data.items)};
}

async function handleWatchlists(req, res, user) {
  if (req.method === 'GET') {
    res.setHeader('cache-control', 'no-store');
    try {
      const record = await watchlistService.load(user.id, req.headers.authorization);
      return send(res, 200, { record }, { 'cache-control': 'no-store' });
    } catch (error) {
      return send(res, 502, { error: 'โหลด Watchlist จาก Supabase ไม่สำเร็จ' });
    }
  }
  if (req.method === 'PUT') {
    try {
      const body = await readJson(req);
      const normalized = normalizeWatchlistsPayload(body);
      if (!normalized.ok) return send(res, 400, { error: normalized.error });
      await watchlistService.save(user.id, req.headers.authorization, normalized);
      return send(res, 200, { ok: true, syncedAt: new Date().toISOString() });
    } catch (error) {
      return send(res, 502, { error: 'บันทึก Watchlist ไป Supabase ไม่สำเร็จ' });
    }
  }
  res.writeHead(405);
  return res.end('Method Not Allowed');
}

async function handleNewsAnalysis(req, res, user) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }
  const now = Date.now();
  const calls = (newsAnalysisCalls.get(user.id) || []).filter(time => now - time < 60000);
  if (calls.length >= 10) return send(res, 429, { error: 'ส่งคำขอสรุปข่าวถี่เกินไป กรุณารอสักครู่' });
  calls.push(now);
  newsAnalysisCalls.set(user.id, calls);
  try {
    const body = await readJson(req);
    return send(res, 200, await newsService.analyse(Array.isArray(body.items) ? body.items : []));
  } catch (error) {
    return send(res, 502, { error: 'วิเคราะห์ข่าวไม่สำเร็จ' });
  }
}

function serveStatic(url, res) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (_) { return send(res, 400, { error: 'URL ไม่ถูกต้อง' }); }
  if (pathname === '/' || pathname === '/login' || pathname === '/login/' || pathname === '/register' || pathname === '/register/') {
    pathname = '/index.html';
  }
  if (!PUBLIC_FILES.has(pathname)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not found');
  }
  const file = path.resolve(ROOT, `.${pathname}`);
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Not found');
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      ...SECURITY_HEADERS
    });
    res.end(data);
  });
}

async function handle(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
    observability.startRequest(req, res, url.pathname);
  }
  if (url.pathname === '/healthz') {
    return send(res, 200, {
      ok: true,
      service: 'setscope',
      uptimeSec: Math.round(process.uptime()),
      cacheEntries: responseCache.size(),
      time: new Date().toISOString()
    });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type'
    });
    return res.end();
  }

  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  const ip = process.env.TRUST_PROXY === '1' ? (forwarded || req.socket.remoteAddress) : req.socket.remoteAddress || 'unknown';
  if (url.pathname.startsWith('/api/') && limited(`ip:${ip}`, 300)) {
    return send(res, 429, { error: 'คำขอถี่เกินไป กรุณารอสักครู่' });
  }
  if (url.pathname === '/api/auth-config') return send(res, 200, authService.configPayload());
  if (url.pathname === '/api/automation/manual') return manualCoverageHandler(req, res);

  const user = url.pathname.startsWith('/api/') ? await authService.requireUser(req, res) : null;
  if (url.pathname.startsWith('/api/') && !user) return;
  if (url.pathname === '/api/watchlists') return handleWatchlists(req, res, user);
  if (url.pathname === '/api/news-analysis') return handleNewsAnalysis(req, res, user);

  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }
  if (url.pathname === '/api/coverage') {
    try {
      const data = await loadCached(res, 'coverage-summary', PROVIDER_POLICIES.coverage, () => coverageRepository.summary());
      return send(res, 200, data);
    } catch (_) {
      return send(res, 200, {
        configured: coverageRepository.configured,
        universe: null,
        currentVerified: null,
        technicalReady: null,
        lastChecked: null,
        provider: 'Yahoo Finance',
        dataState: 'unavailable'
      });
    }
  }
  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
    if (query.length < 1) return send(res, 200, { items: [] });
    try {
      const items = await loadCached(res, `search:${query.toLocaleLowerCase('th')}`, PROVIDER_POLICIES.search, () => retryWithBackoff(
        () => stockSearchService.search(query),
        { maxAttempts: 2, baseDelayMs: 100, shouldRetry: isTransientProviderError }
      ));
      return send(res, 200, { items, provider: 'Yahoo Finance' });
    }
    catch (error) { return send(res, 502, { error: 'ค้นหาหุ้นไม่สำเร็จ', items: [] }); }
  }
  if (url.pathname === '/api/market-overview' || url.pathname === '/api/settrade-overview') {
    try {
      const force = url.searchParams.get('refresh') === '1' && !limited(`refresh:${user.id}`, 3);
      const result = await marketOverviewService.getOverview(force);
      observability.markCache(res, result.meta);
      return send(res, 200, result.value);
    } catch (error) {
      return send(res, 502, { error: 'ดึงข้อมูลภาพรวมตลาดไม่สำเร็จ' });
    }
  }
  if (url.pathname === '/api/market') {
    try {
      const symbols = normalizeMarketSymbols(url.searchParams.has('symbols')
        ? url.searchParams.get('symbols')
        : 'PTT,AOT,ADVANC,KBANK,CPALL');
      const active = normalizeSymbol(url.searchParams.get('symbol') || symbols[0] || 'PTT');
      if (!active) return send(res, 400, { error: 'ชื่อย่อหุ้นไม่ถูกต้อง' });
      if (!symbols.includes(active)) symbols.push(active);
      const range = url.searchParams.get('range') || '1D';
      return send(res, 200, await loadCached(
        res,
        `market:${symbols.join(',')}|${active}|${range}`,
        PROVIDER_POLICIES.market,
        () => marketService.getMarket(symbols, active, range)
      ));
    } catch (error) {
      return send(res, 502, { error: 'ไม่สามารถดึงข้อมูลจากแหล่งข้อมูลได้' });
    }
  }
  if (url.pathname === '/api/news') {
    try { return send(res, 200, newsService.filterForDisplay(await loadCached(res, 'news', PROVIDER_POLICIES.news, loadNewsAndArchive))); }
    catch (error) { return send(res, 502, { error: 'ไม่สามารถดึงข้อมูลจากแหล่งข้อมูลได้' }); }
  }
  if (url.pathname === '/api/news-archive') {
    try {
      const page = url.searchParams.get('page') || '1';
      const pageSize = url.searchParams.get('pageSize') || '10';
      const source = require('./lib/news-content').normalizeNewsSources(url.searchParams.getAll('source'));
      const symbol = url.searchParams.get('symbol') || '';
      const query = String(url.searchParams.get('query') || '').trim().slice(0, 80);
      const featuredCount = url.searchParams.get('featuredCount') || '0';
      const excludeUrls = url.searchParams.getAll('exclude').slice(0, 10);
      const exclusionKey = createHash('sha256').update(JSON.stringify(excludeUrls)).digest('base64url').slice(0, 16);
      const cacheKey = `news-archive:${page}|${pageSize}|${source}|${symbol}|${query}|${featuredCount}|${exclusionKey}|${newsQuarantine.revision}|${newsLinkReview.revision}`;
      const data = await loadCached(res, cacheKey, PROVIDER_POLICIES.newsArchive, () => newsArchiveService.list({
        page, pageSize, source, symbol, query, excludeUrls, featuredCount
      }));
      const safe = newsService.filterForDisplay(data);
      const featuredResult = newsService.filterForDisplay({items:data.featured || []});
      const featured = featuredResult.items;
      const withheldUrls=[...new Set([...(safe.withheldUrls||[]),...(featuredResult.withheldUrls||[])])];
      const countExact=data.countExact===true&&safe.items.length===data.items.length&&featured.length===(data.featured||[]).length;
      return send(res, 200, { ...safe, countExact, matchingTotal:countExact?data.matchingTotal:null, ...(withheldUrls.length?{withheldUrls}:{}), featured, dataState: data.stale ? 'stale' : safe.dataState || (data.configured ? 'fresh' : 'unavailable') });
    } catch (error) {
      return send(res, 502, { error: 'โหลดคลังข่าวไม่สำเร็จ', items: [], dataState: 'unavailable' });
    }
  }
  if (url.pathname === '/api/watchlist-news') {
    try {
      const raw = url.searchParams.get('stocks') || url.searchParams.get('symbols') || '';
      const stocks = normalizeWatchlistNewsStocks(raw);
      const cacheKey = createWatchlistNewsCacheKey(stocks, user.id);
      const force = url.searchParams.get('refresh') === '1' && !limited(`watch-news-refresh:${user.id}`, 3);
      const data = await loadCached(res, cacheKey, PROVIDER_POLICIES.watchlistNews, () => newsService.getWatchlistNews(stocks, {ownerId:user.id,refresh:force}), {force});
      const scoped=new Set(stocks.map(stock=>stock.symbol));
      const reviewed={...data,items:(await newsLinkReview.review(data.items)).filter(item=>newsAssociationSymbols(item).some(symbol=>scoped.has(symbol)))};
      const safe=newsService.filterForDisplay(reviewed);
      if(Array.isArray(data.stockStatus))safe.stockStatus=data.stockStatus.map(status=>({...status,retained:safe.items.filter(item=>newsAssociationSymbols(item).includes(status.symbol)).length}));
      return send(res, 200, safe);
    } catch (error) {
      return send(res, 502, { error: 'ดึงข่าว Watchlist ไม่สำเร็จ' });
    }
  }
  return serveStatic(url, res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error('Request failed: unexpected request handler failure');
    if (res.destroyed) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    const badUrl = error instanceof URIError || error.code === 'ERR_INVALID_URL';
    send(res, badUrl ? 400 : 500, { error: badUrl ? 'URL ไม่ถูกต้อง' : 'เกิดข้อผิดพลาดภายในระบบ' });
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`SETscope running at http://${HOST}:${PORT}`));
}

module.exports = { handle, server, SECURITY_HEADERS };
