'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('polling intervals remain at the baseline request budget', () => {
  assert.equal((appSource.match(/setInterval\(getMarket, 60000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(getSettradeOverview, 300000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(getNews, 300000\)/g) || []).length, 1);
  assert.equal((appSource.match(/setInterval\(getWatchlistNews, 300000\)/g) || []).length, 1);
});

test('ES module split preserves the six-request main-page static budget', () => {
  const scripts = [...indexSource.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  const moduleImports = [...appSource.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['auth.js', 'app.js']);
  assert.deepEqual(moduleImports, ['./client/domain.mjs']);
  assert.equal(scripts.length + moduleImports.length + 3, 6);
});

test('cache keys include every public input and never cache watchlist responses globally', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /`market:\$\{symbols\.join\(','\)\}\|\$\{active\}\|\$\{range\}`/);
  assert.match(serverSource, /loadCached\(res,\s*'wn:'\s*\+\s*cacheKey,\s*PROVIDER_POLICIES\.watchlistNews/);
  const watchlistHandler = serverSource.match(/async function handleWatchlists[\s\S]*?\n}\r?\n\r?\nasync function handleNewsAnalysis/)?.[0] || '';
  assert.doesNotMatch(watchlistHandler, /loadCached|responseCache/);
});
