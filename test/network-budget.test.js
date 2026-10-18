'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const realtimeSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'realtime-readiness.js'), 'utf8');

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
  assert.match(serverSource, /createWatchlistNewsCacheKey\(stocks\)/);
  assert.match(serverSource, /loadCached\(res,\s*cacheKey,\s*PROVIDER_POLICIES\.watchlistNews/);
  const watchlistHandler = serverSource.match(/async function handleWatchlists[\s\S]*?\n}\r?\n\r?\nasync function handleNewsAnalysis/)?.[0] || '';
  assert.doesNotMatch(watchlistHandler, /loadCached|responseCache/);
});
