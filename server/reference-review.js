'use strict';

const { createHash } = require('node:crypto');
const { normalizeSymbol } = require('../lib/validation');
const { validDay } = require('./automation-policy');

// Offline proposal comparison only. No fetch, database write or automatic publish.
function reviewReferenceChanges({ kind, baseline, candidate, source, effectiveDate } = {}) {
  if (!['securityMaster','tickSize'].includes(kind) || !Array.isArray(baseline) || !Array.isArray(candidate)
    || baseline.length > 1000 || candidate.length > 1000 || !candidate.length || !validDay(effectiveDate)
    || typeof source !== 'string' || !/^https:\/\/[^\s]+$/.test(source)) throw Error('Invalid reference proposal');
  const sourceUrl = new URL(source);
  if (sourceUrl.username || sourceUrl.password) throw Error('Reference source cannot contain credentials');
  const allowed = kind === 'securityMaster' ? ['symbol','providerSymbol','market','instrumentType'] : ['from','to','tickSize'];
  function normalize(rows) {
    const result = rows.map(row => {
      if (!row || Object.keys(row).some(key => !allowed.includes(key))) throw Error('Invalid reference fields');
      if (kind === 'securityMaster') {
        if (normalizeSymbol(row.symbol) !== row.symbol || !/^[A-Z0-9&.-]{1,32}\.BK$/.test(row.providerSymbol)
          || !['SET','MAI'].includes(row.market) || row.instrumentType !== 'COMMON_STOCK') throw Error('Unconfirmed security identity');
      } else if (!Number.isFinite(row.from) || row.from < 0 || row.to !== null && (!Number.isFinite(row.to) || row.to <= row.from)
        || !Number.isFinite(row.tickSize) || row.tickSize <= 0) throw Error('Invalid tick range');
      return Object.fromEntries(allowed.map(key => [key,row[key]]));
    }).sort(kind === 'securityMaster' ? (a,b) => a.symbol.localeCompare(b.symbol) : (a,b) => a.from - b.from);
    if (kind === 'securityMaster') {
      if (new Set(result.map(row => row.symbol)).size !== rows.length || new Set(result.map(row => row.providerSymbol)).size !== rows.length) throw Error('Duplicate reference identity');
    } else if (result.some((row,index) => index && (result[index-1].to === null || result[index-1].to > row.from))) throw Error('Overlapping tick ranges');
    return result;
  }
  const before = normalize(baseline), after = normalize(candidate);
  return { kind, changed: JSON.stringify(before) !== JSON.stringify(after), reviewRequired: true,
    sourceOrigin: sourceUrl.origin, effectiveDate, candidateHash: createHash('sha256').update(JSON.stringify(after)).digest('hex'),
    baselineCount: before.length, candidateCount: after.length, applied: false };
}
module.exports = { reviewReferenceChanges };
