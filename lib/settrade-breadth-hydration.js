'use strict';

const { readSettradeState } = require('./settrade-state');
const { validSourceTime } = require('./settrade-active-hydration');

// Named marketInfo fields use raw shares; the existing Overview API uses
// thousand shares. Do not assign meanings using HTML row order or colours.
function parseHydratedMaiBreadth(html, { pageIdentity = false } = {}) {
  const result = { group: null, outcome: 'NOT_APPLICABLE', reportedAsOf: null, invalidFields: [], missingFields: [] };
  if (typeof html !== 'string' || !/window\.__NUXT__\s*=/.test(html)) return result;
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, ' ');
  const denied = /cf-chl-|bot challenge|access denied|verify (?:that )?you are human/i.test(visible)
    || /<title[^>]*>[^<]*(?:captcha|challenge|login|sign in|เข้าสู่ระบบ)[^<]*<\/title>/i.test(visible)
    || /<input[^>]+type=["']password["']/i.test(visible);
  if (!pageIdentity || denied) return { ...result, outcome: 'PARSER_MISMATCH' };
  const state = readSettradeState(html);
  if (!state) return { ...result, outcome: 'PARSER_MISMATCH' };
  const info = state?.state?.summary?.index?.marketInfo?.mai;
  if (info == null) return result;
  if (typeof info !== 'object' || Array.isArray(info) || info.symbol !== 'mai') {
    return { ...result, outcome: 'PARSER_MISMATCH' };
  }
  if (!validSourceTime(info.marketDateTime)) return { ...result, outcome: 'INVALID_DATA', invalidFields: ['marketDateTime'] };
  result.reportedAsOf = info.marketDateTime;
  const items = [];
  for (const [label, amount, volume] of [
    ['Gainers', 'gainerAmount', 'gainerVolume'],
    ['Unchanges', 'unchangedAmount', 'unchangedVolume'],
    ['Losers', 'loserAmount', 'loserVolume']
  ]) {
    for (const key of [amount, volume]) {
      if (info[key] == null) result.missingFields.push(key);
      else if (typeof info[key] !== 'number' || !Number.isSafeInteger(info[key]) || info[key] < 0) result.invalidFields.push(key);
    }
    const valid = key => !result.missingFields.includes(key) && !result.invalidFields.includes(key);
    if (!valid(amount) && !valid(volume)) continue;
    items.push({ label, count: valid(amount) ? info[amount] : null, volumeThousand: valid(volume) ? info[volume] / 1000 : null });
  }
  result.group = items.length ? { market: 'mai', items } : null;
  result.outcome = result.invalidFields.length ? 'INVALID_DATA'
    : result.missingFields.length === 0 ? 'ACCEPT'
      : result.missingFields.length === 6 ? 'SOURCE_NO_DATA' : 'PARSER_MISMATCH';
  return result;
}

module.exports = { parseHydratedMaiBreadth };
