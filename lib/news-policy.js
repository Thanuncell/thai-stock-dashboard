'use strict';

const ALLOWED_NEWS_HOSTS = Object.freeze([
  'news.google.com',
  'thunhoon.com',
  'kaohoon.com',
  'settrade.com',
  'set.or.th',
  'bot.or.th',
  'efinancethai.com'
]);

function allowedNewsUrl(value) {
  try {
    const url = new URL(value);
    const allowedHost = ALLOWED_NEWS_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && !url.username && !url.password && allowedHost ? url : null;
  } catch (_) {
    return null;
  }
}

function resolveAllowedNewsRedirect(currentUrl, location) {
  if (!location) return null;
  try { return allowedNewsUrl(new URL(location, currentUrl).href); }
  catch (_) { return null; }
}

module.exports = { ALLOWED_NEWS_HOSTS, allowedNewsUrl, resolveAllowedNewsRedirect };
