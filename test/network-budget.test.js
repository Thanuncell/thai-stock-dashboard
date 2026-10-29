'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const realtimeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'realtime-readiness.js'), 'utf8');
const guardSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'data-guard.js'), 'utf8');
const overviewSafetySource = fs.readFileSync(path.join(__dirname, '..', 'server', 'market-overview-safety.js'), 'utf8');
const reliabilitySource = fs.readFileSync(path.join(__dirname, '..', 'server', 'reliability.js'), 'utf8');

test('polling intervals remain at the baseline request budget', () => {
  assert.equal((appSource.match(/setInterval\(getMarket, 60000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(getSettradeOverview, 300000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(\(\) => getNews\(\{ reason: 'poll' \}\), 300000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(\(\) => getWatchlistNews\(\{ reason: 'poll' \}\), 300000\)/g) || []).length, 1);
});

test('ES module split preserves the six-request main-page static budget', () => {
  const scripts = [...indexSource.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  const moduleImports = [...appSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['auth.js', 'app.js']);
  assert.deepEqual(moduleImports, ['./client/domain.mjs']);
  assert.equal(scripts.length + moduleImports.length + 3, 6);
});

test('realtime readiness adds no polling, sockets, timers or browser listeners', () => {
  assert.doesNotMatch(realtimeSource, /setInterval|setTimeout|WebSocket|EventSource|addEventListener/);
  assert.doesNotMatch(serverSource, /realtime-readiness/);
  assert.equal((appSource.match(/setInterval\(/g) || []).length, 4);
});

test('cache keys include every public input and never cache watchlist responses globally', () => {
  assert.match(serverSource, /`market:\$\{symbols\.join\(','\)\}\|\$\{active\}\|\$\{range\}`/);
  assert.match(serverSource, /createWatchlistNewsCacheKey\(stocks, user\.id\)/);
  assert.match(serverSource, /loadCached\(res,\s*cacheKey,\s*PROVIDER_POLICIES\.watchlistNews/);
  const watchlistHandler = serverSource.match(/async function handleWatchlists[\s\S]*?\n}\r?\n\r?\nasync function handleNewsAnalysis/)?.[0] || '';
  assert.doesNotMatch(watchlistHandler, /loadCached|responseCache/);
});

test('archive adds one bounded server-page read without increasing upstream polling', () => {
  assert.equal((appSource.match(/apiFetch\(`\/api\/news-archive\?\$\{params\}`(?:,\{signal:controller.signal\})?\)/g) || []).length, 1);
  assert.match(serverSource, /news-archive:\$\{page\}\|\$\{pageSize\}\|\$\{source\}\|\$\{symbol\}\|\$\{query\}\|\$\{featuredCount\}\|\$\{exclusionKey\}/);
  assert.equal((appSource.match(/setInterval\(/g) || []).length, 4);
  assert.doesNotMatch([appSource, indexSource].join('\n'), /SUPABASE_(?:SECRET|SERVICE_ROLE)_KEY/);
});

test('Preventive Data Guard adds no upstream validation request or browser polling', () => {
  assert.doesNotMatch(guardSource, /fetch\s*\(|query1\.finance\.yahoo\.com|setInterval|setTimeout/);
  assert.equal((appSource.match(/apiFetch\('\/api\/coverage'\)/g) || []).length, 1);
  assert.equal((appSource.match(/getCoverageSummary\(\); updateTradingViewChart\(\)/g) || []).length, 1);
  assert.match(appSource, /if \(!root \|\| coverageSummaryRequested\) return/);
  assert.equal((appSource.match(/setInterval\(/g) || []).length, 4);
});

test('Market Overview keeps five-minute polling while globally coalescing and spacing provider requests', () => {
  assert.equal((appSource.match(/setInterval\(getSettradeOverview, 300000\)/g) || []).length, 1);
  assert.match(reliabilitySource, /settrade:[\s\S]*?ttlMs: 300_000/);
  assert.match(overviewSafetySource, /minSpacingMs = Number\(process\.env\.MARKET_OVERVIEW_MIN_SPACING_MS\) \|\| 250/);
  assert.match(overviewSafetySource, /maxRequestsPerWindow = Number\(process\.env\.MARKET_OVERVIEW_MAX_REQUESTS_PER_WINDOW\) \|\| 7/);
  assert.match(overviewSafetySource, /let queue = Promise\.resolve\(\)/);
  assert.equal((appSource.match(/setInterval\(/g) || []).length, 4);
});
