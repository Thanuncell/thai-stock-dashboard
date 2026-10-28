'use strict';

const { allowedNewsUrl, isGoogleNewsUrl, publisherMatches, resolveAllowedNewsRedirect } = require('../lib/news-policy');
const { BROKER_FIRMS, decorateBrokerAttribution, dedupeNewsItems, matchBrokerFirms, newsFingerprint } = require('../lib/broker-news');
const { decodeXml, marketHtmlText, xmlTag } = require('../lib/settrade-parser');
const { normalizeWatchlistNewsStocks } = require('../lib/validation');
const { reviewNewsItem, reviewNewsForDisplay } = require('../lib/news-quality');
const { inspectNewsArticle, articleIdentity } = require('../lib/news-article');
const { createNewsArticleLoader } = require('../lib/news-resolver');
const { createNewsTransport } = require('../lib/news-fetch');
const { newsAnalysisRequest, parseNewsAnalysis, safeAiDiagnostic } = require('../lib/news-analysis');
const { createWatchlistNewsCacheKey } = require('./reliability');
const { fallbackNewsSummary, withNewsRulesSummary } = require('../lib/news-summary');
const { createWatchlistNews, abortable } = require('./watchlist-news');
const { matchesWatchlistStock, watchlistStockQuery } = require('../lib/watchlist-news-identity');
const { issueEvidence, rememberAssessments, canonicalUrl } = require('../lib/news-evidence');

const FEEDS = Object.freeze([
  ['thunhoon', 'ทันหุ้น', 'site:thunhoon.com'],
  ['kaohoon', 'ข่าวหุ้น', 'site:kaohoon.com'],
  ['settrade', 'SETTRADE', 'site:settrade.com'],
  ['settrade', 'SET', 'site:set.or.th'],
  ['official', 'ธนาคารแห่งประเทศไทย', 'site:bot.or.th'],
  ['infoquest', 'Infoquest', '"Infoquest"'],
  ['efinance', 'efinance', 'site:efinancethai.com'],
  ['broker', 'โบรกเกอร์', BROKER_FIRMS.map(firm => `"${firm.companyName.replace(/^บริษัท/, '')}"`).join(' OR ')]
]);

const OUTLET_SOURCE = Object.freeze([
  [/ทันหุ้น|thunhoon/i, 'thunhoon'],
  [/ข่าวหุ้น|kaohoon/i, 'kaohoon'],
  [/^(?:SET|SETTRADE)$|ตลาดหลักทรัพย์/i, 'settrade'],
  [/ธนาคารแห่งประเทศไทย|bot\.or\.th/i, 'official'],
  [/Infoquest|อินโฟเควสท์/i, 'infoquest'],
  [/efinance|อีไฟแนนซ์/i, 'efinance']
]);

const GOOGLE_RSS_PREFIX = 'https://news.google.com/rss/search?q=';
const GOOGLE_RSS_BACKOFF_BASE_MS = 30_000;
const GOOGLE_RSS_BACKOFF_MAX_MS = 15 * 60 * 1000;
const GOOGLE_RSS_RETRY_AFTER_MAX_MS = 30 * 60 * 1000;
const NEWS_STALE_FALLBACK_MS = 30 * 60 * 1000;
const OPENAI_MIN_COOLDOWN_MS = 60_000;
const OPENAI_DEFAULT_COOLDOWN_MS = 5 * 60_000;
const RISKY_TARGET_CACHE_MS = 6 * 60 * 60 * 1000;
const RISKY_TARGET_UNVERIFIED_CACHE_MS = 5 * 60 * 1000;
const MAX_RISKY_TARGET_CHECKS = 3;
const MAX_RISKY_TARGET_BYTES = 256_000;

function sourceFromOutlet(name = '') {
  const mapped = (OUTLET_SOURCE.find(([pattern]) => pattern.test(name)) || [null, null])[1];
  return mapped || (matchBrokerFirms(name).length ? 'broker' : 'other');
}

function parseRetryAfter(value, timestamp) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, GOOGLE_RSS_RETRY_AFTER_MAX_MS);
  const date = Date.parse(text);
  if (!Number.isFinite(date) || date <= timestamp) return null;
  return Math.min(date - timestamp, GOOGLE_RSS_RETRY_AFTER_MAX_MS);
}

async function readBoundedText(response, limit = MAX_RISKY_TARGET_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) return String(await response.text()).slice(0, limit);
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = limit - size;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    size += chunk.byteLength;
    if (size >= limit) {
      reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function createNewsService({ env = process.env, fetchImpl = globalThis.fetch, logger = console, now = Date.now, analysisTimeoutMs = 30000, registrySearch, watchlistDeadlineMs = 30000, quarantine = new Map() } = {}) {
  if (!Number.isInteger(analysisTimeoutMs) || analysisTimeoutMs < 1 || analysisTimeoutMs > 30000) throw Error('Invalid AI timeout');
  const analysisCache = new Map();
  let openAiCooldownUntil = 0;
  let openAiInFlight = null;
  let openAiQuotaBlocked = false;
  const hardGate = ['read','write'].includes(env.SETSCOPE_NEWS_EVIDENCE);
  const blockedArticleOrigins = new Set();
  const loadArticle = createNewsArticleLoader({fetchImpl,now});
  const articleTransport = createNewsTransport({fetchImpl});
  const rssPending = new Map();
  const lastValidated = new Map();
  const riskyTargetCache = new Map();
  let rssQueue = Promise.resolve();
  let googleCooldownUntil = 0;
  let googleFailureCount = 0;
  let googleAccessDenied = false;

  function providerCooldownError(status = 0) {
    const error = Error(status ? `Google News RSS HTTP ${status}` : 'Google News RSS cooldown active');
    error.retryable = true;
    error.providerCooldown = true;
    error.status = status;
    return error;
  }

  function beginGoogleCooldown(response) {
    googleFailureCount = Math.min(googleFailureCount + 1, 6);
    const exponential = Math.min(GOOGLE_RSS_BACKOFF_MAX_MS, GOOGLE_RSS_BACKOFF_BASE_MS * (2 ** (googleFailureCount - 1)));
    const retryAfter = parseRetryAfter(response?.headers?.get('retry-after'), Number(now()));
    googleCooldownUntil = Math.max(googleCooldownUntil, Number(now()) + Math.max(exponential, retryAfter || 0));
  }

  function fetchGoogleRss(url, signal) {
    if (rssPending.has(url)) return rssPending.get(url);
    const task = rssQueue.catch(() => {}).then(async () => {
      if (signal?.aborted) throw providerCooldownError();
      if (googleAccessDenied) throw providerCooldownError(403);
      if (Number(now()) < googleCooldownUntil) throw providerCooldownError();
      const requestSignal = signal || AbortSignal.timeout(12000);
      let response;
      try {
        response = await abortable(fetchImpl(url, {
          headers: { 'user-agent': 'SETscope/1.0 news reader (local prototype)', accept: 'application/rss+xml, application/xml, text/xml' },
          signal: requestSignal
        }),requestSignal);
      } catch (error) {
        beginGoogleCooldown();
        const wrapped = providerCooldownError();
        wrapped.cause = error;
        throw wrapped;
      }
      if (response.status === 429 || response.status === 503) {
        beginGoogleCooldown(response);
        throw providerCooldownError(response.status);
      }
      if ([401,403].includes(response.status)){googleAccessDenied=true;throw providerCooldownError(response.status);}
      if (!response.ok) throw Error(`Google News RSS HTTP ${response.status}`);
      googleFailureCount = 0;
      googleCooldownUntil = 0;
      return abortable(readBoundedText(response,512000),requestSignal);
    });
    rssPending.set(url, task);
    rssQueue = task.then(() => undefined, () => undefined);
    task.finally(() => rssPending.delete(url)).catch(() => {});
    return task;
  }

  function rememberValidated(key, value) {
    lastValidated.delete(key);
    lastValidated.set(key, { value, storedAt: Number(now()) });
    while (lastValidated.size > 100) lastValidated.delete(lastValidated.keys().next().value);
  }

  function staleFallback(key, error) {
    const cached = lastValidated.get(key);
    if (!cached || Number(now()) - cached.storedAt > NEWS_STALE_FALLBACK_MS) return null;
    const errors = [...new Set([...(Array.isArray(cached.value.errors) ? cached.value.errors : []), error?.status ? `google-rss-${error.status}` : 'google-rss-unavailable'])];
    return { ...cached.value, items: cached.value.items.filter(item => !quarantine.has(newsFingerprint(item)) && (!hardGate || reviewNewsForDisplay(item, {now:Number(now())}).status === 'VERIFIED')),
      errors, stale: true, partial: true, dataState: 'stale' };
  }

  const articleCacheKey = item => hardGate ? JSON.stringify([item.url,item.title,item.pubDate,item.sourceName,item.matchedSymbols,item.matchedBrokerFirms]) : String(item.url || '');

  function cacheRiskyTarget(key, value, ttlMs) {
    riskyTargetCache.delete(key);
    riskyTargetCache.set(key, { value, expiresAt: Number(now()) + ttlMs });
    while (riskyTargetCache.size > 200) riskyTargetCache.delete(riskyTargetCache.keys().next().value);
    return value;
  }

  async function validateRiskyTarget(item, signal, budget) {
    const key = articleCacheKey(item);
    const cached = riskyTargetCache.get(key);
    if (cached && Number(now()) < cached.expiresAt) return cached.value;
    const observed = (status, reason, resolvedUrl = null) => {
      const subject = resolvedUrl ? { ...item, url: resolvedUrl } : item;
      const value = { status, reason, ...(resolvedUrl ? { resolvedUrl } : {}), verification: issueEvidence(subject,
        { status, reason, basis: 'article' }, { checkedAt: Number(now()), originalUrl: item.url, pathway: 'google-rss/article' }) };
      return cacheRiskyTarget(key, value, status === 'UNVERIFIED' ? RISKY_TARGET_UNVERIFIED_CACHE_MS : RISKY_TARGET_CACHE_MS);
    };
    const loaded = await loadArticle(item.url,{signal,budget});
    if (!loaded.response) return observed('UNVERIFIED',loaded.reason);
    const {target,response}=loaded;
    if (hardGate && !publisherMatches({...item,url:target.href})) return observed('UNVERIFIED','PUBLISHER_IDENTITY_UNVERIFIED');
    if (response.status === 404 || response.status === 410) return observed('REJECTED','ARTICLE_NOT_FOUND',canonicalUrl(target.href));
    if (!response.ok || (!hardGate && !/(?:^|\.)thunhoon\.com$/i.test(target.hostname))
      || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) return observed('UNVERIFIED','ARTICLE_NOT_VERIFIED');
    try {
      const html=await abortable(readBoundedText(response),signal);
      if(response.url&&articleIdentity(response.url)!==articleIdentity(target.href))return observed('UNVERIFIED','ARTICLE_RESPONSE_URL_MISMATCH');
      const inspected=inspectNewsArticle(html,{url:target.href,title:item.title,strict:hardGate});
      if(inspected.reason==='ARTICLE_ACCESS_DENIED'){loadArticle.blockOrigin(target);blockedArticleOrigins.add(target.origin);}
      const projected={...item,url:inspected.resolvedUrl||target.href,...(inspected.publishedAt?{pubDate:inspected.publishedAt}:{})};
      const verification=issueEvidence(projected,{status:inspected.status,reason:inspected.reason,basis:'article'},
        {inspection:inspected,originalUrl:item.url,checkedAt:Number(now()),pathway:'google-rss/article'});
      return cacheRiskyTarget(key,{status:inspected.status,reason:inspected.reason,resolvedUrl:projected.url,publishedAt:inspected.publishedAt,articleText:inspected.text,verification},
        inspected.status==='UNVERIFIED'?RISKY_TARGET_UNVERIFIED_CACHE_MS:RISKY_TARGET_CACHE_MS);
    } catch { return observed('UNVERIFIED','ARTICLE_NOT_VERIFIED'); }
  }

  function quarantineItem(item, evidence) {
    const key = newsFingerprint(item);
    quarantine.delete(key);
    quarantine.set(key, { url: item.url, title: item.title, status: evidence.status, reason: evidence.reason });
    while (quarantine.size > 200) quarantine.delete(quarantine.keys().next().value);
  }

  async function keepQualityItems(items, budget = { remaining: MAX_RISKY_TARGET_CHECKS }, stock = null) {
    const kept = [];
    kept.unverifiedCount = 0;
    kept.assessments = [];
    kept.withheldUrls = [];
    for (const original of items) {
      let item = original;
      let evidence = reviewNewsItem(item);
      const preliminary = reviewNewsForDisplay(item, {now:Number(now())});
      const risky = hardGate ? preliminary.status !== 'VERIFIED'
        && ['ARTICLE_PROOF_REQUIRED','ARTICLE_URL_REQUIRED'].includes(preliminary.reason)
        : evidence.status === 'UNVERIFIED' && (item.source === 'thunhoon' || /ทันหุ้น|thunhoon/i.test(item.sourceName || ''));
      const cached = riskyTargetCache.get(articleCacheKey(item));
      const cachedEvidence = cached && Number(now()) < cached.expiresAt;
      if (risky && !budget.signal?.aborted && (cachedEvidence || budget.remaining > 0)) {
        if (!cachedEvidence) budget.remaining -= 1;
        const validation = await validateRiskyTarget(item,budget.signal,budget);
        if (validation.resolvedUrl) item = { ...item, url: validation.resolvedUrl, ...(validation.publishedAt ? {pubDate:validation.publishedAt} : {}) };
        evidence = reviewNewsItem(item, validation.verification || validation);
        if (hardGate && stock && validation.status === 'VERIFIED'
          && !matchesWatchlistStock(stock, item.title+' '+(validation.articleText || ''))) {
          const key=newsFingerprint(item)+'|symbol:'+stock.symbol;
          quarantine.delete(key);quarantine.set(key,{url:item.url,title:item.title,status:'UNVERIFIED',reason:'STOCK_IDENTITY_UNVERIFIED'});
          while(quarantine.size>200)quarantine.delete(quarantine.keys().next().value);
          kept.withheldUrls.push(item.url);kept.unverifiedCount++;continue;
        }
      }
      if (hardGate && isGoogleNewsUrl(item.url)) {
        evidence = issueEvidence(item,{status:'UNVERIFIED',reason:evidence.status==='UNVERIFIED'?evidence.reason:'WRAPPER_UNRESOLVED',basis:'article'},
          {checkedAt:Number(now()),originalUrl:original.url,pathway:'google-rss/wrapper'});
      }
      const display = hardGate ? reviewNewsForDisplay(item, {now:Number(now()), verification:evidence}) : evidence;
      // Display uncertainty must not overwrite a committed G1 positive decision.
      kept.assessments.push({ item, verification: evidence });
      if (display.status !== 'VERIFIED') { if (display.status === 'UNVERIFIED') kept.unverifiedCount++; quarantineItem(item, evidence.status === 'UNVERIFIED' ? {...display,reason:evidence.reason} : display); kept.withheldUrls.push(item.url); continue; }
      if (evidence.status !== 'VERIFIED') { if (evidence.status === 'UNVERIFIED') kept.unverifiedCount++; quarantineItem(item, evidence); continue; }
      quarantine.delete(newsFingerprint(original));
      quarantine.delete(newsFingerprint(item));
      kept.push({ ...item, verification: evidence });
    }
    return kept;
  }

  async function getNews() {
    const cutoff = Number(now()) - 30 * 24 * 60 * 60 * 1000;
    const settled = [];
    const articleBudget = { remaining: MAX_RISKY_TARGET_CHECKS, httpRemaining: 12 };
    for (const [source, sourceName, query] of FEEDS) {
      try {
        const url = GOOGLE_RSS_PREFIX + encodeURIComponent(`${query} when:30d`) + '&hl=th&gl=TH&ceid=TH:th';
        const xml = await fetchGoogleRss(url);
        const channel = xml.match(/<channel(?:\s[^>]*)?>([\s\S]*?)<\/channel>/i)?.[1] || xml;
        const parsed = [...channel.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => {
          const block = match[1];
          const title = decodeXml(xmlTag(block, 'title'));
          const url = decodeXml(xmlTag(block, 'link'));
          const pubDate = decodeXml(xmlTag(block, 'pubDate'));
          const snippet = decodeXml(xmlTag(block, 'description')).slice(0, 1200);
          const outletName = decodeXml(xmlTag(block, 'source')) || sourceName;
          const outletSource = sourceFromOutlet(outletName);
          return decorateBrokerAttribution({
            source: outletSource,
            sourceName: outletName,
            discoverySource: source,
            title,
            url,
            pubDate,
            snippet
          });
        }).filter(item => {
          const published = Date.parse(item.pubDate);
          return item.title && allowedNewsUrl(item.url)
            && Number.isFinite(published) && published >= cutoff;
        }).sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate));
        const reviewed = await keepQualityItems(parsed, articleBudget);
        settled.push({ status: 'fulfilled', value: reviewed.slice(0, 8), uncertain: reviewed.unverifiedCount, assessments: reviewed.assessments });
      } catch (reason) {
        settled.push({ status: 'rejected', reason });
      }
    }
    const items = dedupeNewsItems(settled.flatMap(result => result.status === 'fulfilled' ? result.value : []))
      .sort((a, b) => Date.parse(b.pubDate) - Date.parse(a.pubDate)).map(withNewsRulesSummary).filter(Boolean);
    const errors = settled.map((result, index) => result.status === 'rejected' ? FEEDS[index][0] : null).filter(Boolean);
    const cooldownError = settled.find(result => result.status === 'rejected' && result.reason?.providerCooldown)?.reason;
    if (cooldownError) {
      const fallback = staleFallback('news', cooldownError);
      if (fallback) return rememberAssessments(fallback, settled.flatMap(entry => entry.assessments || []));
    }
    const uncertain = settled.some(result => result.uncertain > 0);
    if (!items.length && uncertain) {
      const fallback = staleFallback('news', Error('ARTICLE_UNVERIFIED'));
      if (fallback) return rememberAssessments(fallback, settled.flatMap(entry => entry.assessments || []));
    }
    const fetchedAt = new Date(Number(now())).toISOString();
    const asOfMs = items.map(item => Date.parse(item.pubDate)).filter(Number.isFinite)
      .reduce((latest, value) => Math.max(latest, value), 0);
    const unavailable = !items.length && (errors.length === FEEDS.length || uncertain);
    const result = {
      items,
      errors,
      fetchedAt,
      asOf: asOfMs ? new Date(asOfMs).toISOString() : null,
      source: 'Google News',
      stale: false,
      partial: (errors.length > 0 || uncertain) && !unavailable,
      dataState: unavailable ? 'unavailable' : errors.length || uncertain ? 'partial' : 'fresh',
      maxAgeDays: 30
    };
    if (!unavailable) rememberValidated('news', result);
    return rememberAssessments(result, settled.flatMap(entry => entry.assessments || []));
  }

  async function extractArticle(item) {
    let target = allowedNewsUrl(item.url);
    if (!target) return '';
    try {
      let response;
      for (let redirect = 0; redirect < 5; redirect++) {
        if (blockedArticleOrigins.has(target.origin) || loadArticle.isBlocked(target)) return '';
        response = await articleTransport(target, {
          maxBytes: 1_500_000,
          redirect: 'manual',
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; SETscope news summarizer/1.0)',
            accept: 'text/html,application/xhtml+xml'
          },
          signal: AbortSignal.timeout(9000)
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) return '';
        target = resolveAllowedNewsRedirect(target, location);
        if (!target) return '';
      }
      if ([401,403].includes(response.status)) {blockedArticleOrigins.add(target.origin);loadArticle.blockOrigin(target);}
      if(response.status===429)loadArticle.blockOrigin(target,300000);
      const finalUrl = allowedNewsUrl(response.url || target.href);
      if (!response.ok || !finalUrl || !/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '')) return '';
      if (articleIdentity(finalUrl.href) !== articleIdentity(target.href)) return '';
      const reader = response.body?.getReader();
      if (!reader) return '';
      const chunks = [];
      let size = 0;
      while (size < 1_500_000) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
        if (size >= 1_500_000) {
          reader.cancel().catch(() => {});
          break;
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const html = new TextDecoder().decode(bytes);
      const inspection = inspectNewsArticle(html, { url: finalUrl.href, title: item.title });
      if(inspection.reason==='ARTICLE_ACCESS_DENIED'){loadArticle.blockOrigin(target);blockedArticleOrigins.add(target.origin);}
      return inspection.status === 'VERIFIED' ? inspection.text : '';
    } catch (_) {
      return '';
    }
  }

  async function analyse(items = []) {
    const prepared = items.slice(0, 8).map(item => ({
      source: String(item?.source || '').slice(0,80), sourceName: String(item?.sourceName || item?.source || '').slice(0,160),
      title: String(item?.title || '').slice(0,300), url: String(item?.url || '').slice(0,2000), snippet: String(item?.snippet || '').slice(0,1200),
      // Caller-provided negative evidence may restrict analysis; VERIFIED can never grant trust.
      verification: ['UNVERIFIED','REJECTED'].includes(item?.verification?.status)
        ? {status:item.verification.status,reason:'ARTICLE_NOT_VERIFIED'} : undefined
    }));
    const cacheKey = item => newsFingerprint(item) + '|' + item.title + '|' + item.snippet;
    for (const [key, entry] of analysisCache) if (entry.expiresAt <= Number(now())) analysisCache.delete(key);
    const clean = prepared.filter(item => reviewNewsItem(item).status === 'VERIFIED');
    // Concurrent requests share the completed result rather than caching a competing fallback.
    if (openAiInFlight) await openAiInFlight;
    const fresh = [...new Map(clean.filter(item => !analysisCache.has(cacheKey(item))).map(item => [cacheKey(item), item])).values()];
    if (fresh.length && env.OPENAI_API_KEY && !openAiInFlight && !openAiQuotaBlocked && Number(now()) >= openAiCooldownUntil) {
      let release;
      openAiInFlight = new Promise(resolve => { release = resolve; });
      let timer;
      const controller = new AbortController();
      try {
        const material = (await Promise.all(fresh.map(async (item,id) => {
          const article = await extractArticle(item);
          return { id, cacheKey: cacheKey(item), source:item.source, title:item.title, articleText:article || item.snippet,
            basis:article?'article':item.snippet?'snippet':'headline' };
        }))).filter(item=>item.articleText);
        if (material.length) {
          const expired = new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('AI_TIMEOUT'));},analysisTimeoutMs);});
          const payload = await Promise.race([expired, (async()=>{
            const response = await fetchImpl('https://api.openai.com/v1/responses', {
              method:'POST', headers:{authorization:'Bearer '+env.OPENAI_API_KEY,'content-type':'application/json'},
              body:JSON.stringify(newsAnalysisRequest(material,env.OPENAI_MODEL || 'gpt-4.1-mini')), signal:controller.signal
            });
            if (response.status === 429) {
              const retryAfter = parseRetryAfter(response.headers.get('retry-after'), Number(now()));
              // Honor valid Retry-After up to the existing bounded header limit.
              openAiCooldownUntil = Math.max(openAiCooldownUntil, Number(now()) + Math.max(OPENAI_MIN_COOLDOWN_MS, retryAfter || OPENAI_DEFAULT_COOLDOWN_MS));
            }
            let body;
            try { body = JSON.parse(await readBoundedText(response,128000)); }
            catch { if (response.ok) throw Error('AI_INVALID_RESPONSE'); }
            if (!response.ok) {
              if (response.status === 429) {
                openAiQuotaBlocked = ['insufficient_quota','credit_balance_exhausted','billing_hard_limit_reached'].includes(body?.error?.code);
              }
              const error=Error('AI_HTTP_FAILURE');error.diagnostic=safeAiDiagnostic(response.status,body,material.length);throw error;
            }
            return body;
          })()]);
          const summaries=parseNewsAnalysis(payload,material);
          for (const item of material) analysisCache.set(item.cacheKey,{summary:summaries.get(item.id),mode:'ai',basis:item.basis,expiresAt:Number(now())+6*60*60*1000});
        }
      } catch (error) {
        if (error.message === 'AI_TIMEOUT') openAiCooldownUntil = Math.max(openAiCooldownUntil, Number(now()) + OPENAI_MIN_COOLDOWN_MS);
        // Never log raw API bodies, error messages, input news, tokens or headers.
        logger.warn('News AI analysis unavailable:',JSON.stringify(error.diagnostic || {status:0,code:error.message==='AI_TIMEOUT'?'TIMEOUT':'INVALID_RESPONSE'}));
      } finally { clearTimeout(timer); openAiInFlight = null; release(); }
    }
    const result=prepared.map(item=>{
      if(reviewNewsItem(item).status!=='VERIFIED')return {summary:'',mode:'unavailable',basis:'headline'};
      let cached=analysisCache.get(cacheKey(item));
      if(!cached){const summary=withNewsRulesSummary(item)?.analysisSummary || '';cached=summary?{summary,mode:'rules',basis:'snippet',expiresAt:Number(now())+5*60*1000}
        :{summary:'',mode:'unavailable',basis:'headline',expiresAt:Number(now())+5*60*1000};analysisCache.set(cacheKey(item),cached);}
      return {summary:cached.summary,mode:cached.mode,basis:cached.basis};
    });
    while(analysisCache.size>500)analysisCache.delete(analysisCache.keys().next().value);
    const modes=new Set(result.map(item=>item.mode));
    return {items:result,mode:modes.size===1?[...modes][0]:modes.size?'mixed':'unavailable',aiConfigured:Boolean(env.OPENAI_API_KEY)};
  }

  async function fetchWatchlistStock(stock,budget,parentSignal) {
    const controller=new AbortController(),relay=()=>controller.abort();
    parentSignal.addEventListener('abort',relay,{once:true});
    const timer=setTimeout(()=>controller.abort(),5000);
    let xml;
    try {
      const url=GOOGLE_RSS_PREFIX+encodeURIComponent(watchlistStockQuery(stock))+'&hl=th&gl=TH&ceid=TH:th';
      xml=await fetchGoogleRss(url,controller.signal);
    } finally {clearTimeout(timer);parentSignal.removeEventListener('abort',relay);}
    if(parentSignal.aborted)throw Error('WATCHLIST_DEADLINE');
    if(!/<rss(?:\s|>)/i.test(xml)||!/<\/rss\s*>/i.test(xml)||!/<channel(?:\s|>)/i.test(xml)||!/<\/channel\s*>/i.test(xml)
      ||(xml.match(/<item(?:\s|>)/gi)||[]).length!==(xml.match(/<\/item\s*>/gi)||[]).length)throw Error('Invalid Watchlist RSS response');
    const blocks=[...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item\s*>/gi)];
    const parsed=blocks.slice(0,100).map(match=>{
      const block=match[1],title=decodeXml(xmlTag(block,'title')),url=decodeXml(xmlTag(block,'link'));
      const pubDate=decodeXml(xmlTag(block,'pubDate')),snippet=decodeXml(xmlTag(block,'description')).slice(0,1200),outlet=decodeXml(xmlTag(block,'source'));
      return decorateBrokerAttribution({title,url,pubDate,snippet,source:sourceFromOutlet(outlet),sourceName:outlet||'ข่าวหุ้นไทย',
        matchedSymbols:matchesWatchlistStock(stock,title+' '+snippet)?[stock.symbol]:[]});
    }).filter(item=>item.title&&allowedNewsUrl(item.url)&&Number.isFinite(Date.parse(item.pubDate))
      &&Date.parse(item.pubDate)>=Number(now())-30*86400000&&Date.parse(item.pubDate)<=Number(now())+600000&&item.matchedSymbols.length);
    const quality=await keepQualityItems(parsed,budget,stock);
    return {items:quality.map(withNewsRulesSummary).filter(Boolean),unverifiedCount:quality.unverifiedCount,
      matchedCandidates:parsed.length,qualityExcluded:parsed.length-quality.length,limited:blocks.length>100,withheldUrls:quality.withheldUrls,
      rejectedKeys:parsed.filter(item=>reviewNewsItem(item).status==='REJECTED'||quarantine.get(newsFingerprint(item))?.status==='REJECTED').map(newsFingerprint)};
  }
  const getWatchlistNews=createWatchlistNews({fetchStock:fetchWatchlistStock,registrySearch,now,deadlineMs:watchlistDeadlineMs,
    isRejected:item=>hardGate ? quarantine.has(newsFingerprint(item)) : quarantine.get(newsFingerprint(item))?.status==='REJECTED',
    canDisplay:item=>!hardGate || reviewNewsForDisplay(item,{now:Number(now())}).status==='VERIFIED'});

  function filterForDisplay(payload) {
    const candidates=Array.isArray(payload?.items)?payload.items:[];
    const kept = candidates.filter(item => {
      const proof = reviewNewsForDisplay(item,{now:Number(now())});
      if (proof.status !== 'VERIFIED') { if(item?.url)quarantineItem(item,proof); return false; }
      return !quarantine.has(newsFingerprint(item));
    });
    // Only retract URLs already present in this response/owner scope; never export
    // the shared quarantine registry or another account's stock discoveries.
    const withheldUrls=[...new Set([...(Array.isArray(payload.withheldUrls)?payload.withheldUrls:[]),
      ...candidates.filter(item=>!kept.includes(item)).map(item=>item?.url)])].filter(url=>allowedNewsUrl(url)).slice(0,200);
    return { ...payload, ...(withheldUrls.length ? {withheldUrls} : {}), items:kept, ...(!payload.page && typeof payload.total==='number' ? {total:kept.length} : {}), ...(kept.length < candidates.length ? {partial:true,dataState:kept.length?'partial':'unavailable'} : {}) };
  }
  return { analyse, getNews, getWatchlistNews, filterForDisplay, quarantineReport: () => [...quarantine.values()].map(item=>({...item})) };
}

module.exports = { FEEDS, OUTLET_SOURCE, createNewsService, fallbackNewsSummary, parseRetryAfter, sourceFromOutlet };
