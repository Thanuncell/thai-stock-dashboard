'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allowedNewsUrl,
  resolveAllowedNewsRedirect
} = require('../lib/news-policy');

test('news allowlist permits HTTPS publisher hosts and their subdomains', () => {
  assert.equal(allowedNewsUrl('https://set.or.th/article')?.hostname, 'set.or.th');
  assert.equal(allowedNewsUrl('https://www.settrade.com/news')?.hostname, 'www.settrade.com');
});

test('news allowlist rejects non-HTTPS, deceptive hosts and embedded credentials', () => {
  assert.equal(allowedNewsUrl('http://set.or.th/article'), null);
  assert.equal(allowedNewsUrl('https://set.or.th.evil.example/article'), null);
  assert.equal(allowedNewsUrl('https://user:pass@set.or.th/article'), null);
  assert.equal(allowedNewsUrl('not a url'), null);
});

test('each redirect hop is resolved and revalidated', () => {
  assert.equal(
    resolveAllowedNewsRedirect('https://news.google.com/articles/1', '/articles/2')?.href,
    'https://news.google.com/articles/2'
  );
  assert.equal(
    resolveAllowedNewsRedirect('https://news.google.com/articles/1', 'https://www.kaohoon.com/story')?.hostname,
    'www.kaohoon.com'
  );
  assert.equal(
    resolveAllowedNewsRedirect('https://news.google.com/articles/1', 'https://evil.example/story'),
    null
  );
});
