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

test('main page adds only the tested indicator module to the static request budget', () => {
  const scripts = [...indexSource.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ['auth.js', 'lib/indicators.js', 'app.js']);
});

test('cache keys include every public input and never cache watchlist responses globally', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSource, /`market:\$\{symbols\.join\(','\)\}\|\$\{active\}\|\$\{range\}`/);
  assert.match(serverSource, /cached\('wn:'\+cacheKey,300000/);
  assert.doesNotMatch(serverSource, /cached\([^\n]*watchlists/);
});
