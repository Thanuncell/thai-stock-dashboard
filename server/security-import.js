'use strict';

const { normalizeSymbol } = require('../lib/validation');
const { createHash } = require('node:crypto');

function existingIdentity(row) {
  const pairs = [['instrumentId', 'instrument_id'], ['instrumentType', 'instrument_type'], ['providerSymbol', 'provider_symbol'], ['market', 'listing_market'], ['issuer', 'issuer_name']];
  const ambiguousFields = pairs.some(([camel, snake]) => row[camel] != null && row[snake] != null
    && String(row[camel]).trim() !== String(row[snake]).trim());
  return {
    ...row,
    symbol: normalizeSymbol(row.symbol),
    instrumentId: row.instrument_id ?? row.instrumentId,
    instrumentType: row.instrument_type ?? row.instrumentType,
    providerSymbol: String(row.provider_symbol ?? row.providerSymbol ?? '').trim().toUpperCase(),
    market: String(row.listing_market ?? row.market ?? '').trim().toUpperCase(),
    issuer: row.issuer_name ?? row.issuer,
    ambiguousFields
  };
}

// Pure staging only. This module has no database, provider or apply operation.
function parseSecurityFile(input) {
  if (typeof input === 'string' && Buffer.byteLength(input) > 5 * 1024 * 1024) throw Error('Import file too large');
  const rows = typeof input === 'string' ? JSON.parse(input) : input;
  if (!Array.isArray(rows)) throw Error('Expected a JSON array of security records');
  if (rows.length > 10000) throw Error('Import exceeds staging limit');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('Invalid security record');
    return {
      symbol: normalizeSymbol(row.symbol),
      instrumentId: String(row.instrumentId || '').trim(),
      market: String(row.market || '').trim().toUpperCase(),
      instrumentType: String(row.instrumentType || '').trim().toUpperCase(),
      issuer: String(row.issuer || '').trim(),
      providerSymbol: String(row.providerSymbol || '').trim().toUpperCase(),
      source: String(row.source || '').trim(),
      effectiveDate: String(row.effectiveDate || '').trim(),
      rightsEvidence: String(row.rightsEvidence || '').trim(),
      classificationEvidence: String(row.classificationEvidence || '').trim(),
      rightsConfirmed: row.rightsConfirmed === true,
      classificationConfirmed: row.classificationConfirmed === true,
      ...(row.sourceDenied === true ? { sourceDenied: true } : {}),
      ...(row.acquisitionProhibited === true ? { acquisitionProhibited: true } : {})
    };
  });
}

function dryRunImport(input, { existing = [], protectedSymbols = [] } = {}) {
  const rows = parseSecurityFile(input);
  existing = existing.map(existingIdentity);
  const protectedSet = new Set(protectedSymbols.map(normalizeSymbol).filter(Boolean));
  const old = new Map();
  const duplicateExisting = new Set();
  const oldIdentities = new Map(), oldMappings = new Map();
  const index = (map, value, symbol) => {
    if (!value) return;
    if (!map.has(value)) map.set(value, new Set());
    map.get(value).add(symbol);
  };
  for (const row of existing) {
    const key = normalizeSymbol(row.symbol);
    if (!key) throw Error('Invalid existing symbol');
    if (old.has(key)) duplicateExisting.add(key);
    old.set(key, row);
    index(oldIdentities, row.instrumentId, key);
    index(oldMappings, row.providerSymbol, key);
  }
  const seen = new Map();
  const identities = new Map();
  const mappings = new Map();
  for (const row of rows) {
    seen.set(row.symbol, (seen.get(row.symbol) || 0) + 1);
    if (row.instrumentId) identities.set(row.instrumentId, (identities.get(row.instrumentId) || 0) + 1);
    if (row.providerSymbol) mappings.set(row.providerSymbol, (mappings.get(row.providerSymbol) || 0) + 1);
  }
  const entries = rows.map(row => {
    const prior = old.get(row.symbol);
    const otherIdentity = [...(oldIdentities.get(row.instrumentId) || [])].some(symbol => symbol !== row.symbol);
    const otherMapping = [...(oldMappings.get(row.providerSymbol) || [])].some(symbol => symbol !== row.symbol);
    const protectedAction = ['DR', 'DRX'].includes(prior?.instrumentType) ? 'PROTECTED_DR' : 'PROTECTED_LEGACY';
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate)
      && Number.isFinite(Date.parse(row.effectiveDate))
      && new Date(row.effectiveDate).toISOString().slice(0, 10) === row.effectiveDate;
    let action;
    if (protectedSet.has(row.symbol) || prior && prior.instrumentType !== 'COMMON_STOCK') action = protectedAction;
    else if (!row.symbol || row.sourceDenied || row.acquisitionProhibited || !row.classificationConfirmed
      || !row.source || !validDate || !row.classificationEvidence
      || !['SET', 'MAI', 'SET_OR_MAI'].includes(row.market) || row.instrumentType !== 'COMMON_STOCK'
      || !/^[A-Z0-9&.-]{1,32}\.BK$/.test(row.providerSymbol)
      || row.instrumentId.length > 200 || row.issuer.length > 300 || row.source.length > 1000
      || row.rightsEvidence.length > 1000 || row.classificationEvidence.length > 1000) action = 'UNVERIFIED';
    else if (prior?.ambiguousFields || seen.get(row.symbol) > 1 || identities.get(row.instrumentId) > 1 || mappings.get(row.providerSymbol) > 1
      || prior && (otherIdentity || otherMapping)
      || duplicateExisting.has(row.symbol)) action = 'CONFLICT';
    else if (!prior) {
      action = otherMapping ? 'CONFLICT' : otherIdentity ? 'RENAME_CANDIDATE' : 'ADD';
    } else if (!prior.instrumentId || prior.instrumentId !== row.instrumentId
      || (prior.providerSymbol || prior.provider_symbol) !== row.providerSymbol) action = 'CONFLICT';
    else if (prior.market !== row.market) action = 'MARKET_MOVE_CANDIDATE';
    else if (prior.issuer !== row.issuer) action = 'UPDATE_METADATA';
    else action = 'NO_CHANGE';
    return { symbol: row.symbol, action, staged: row };
  });
  for (const [symbol, prior] of old) {
    if (!seen.has(symbol)) entries.push({ symbol, action: protectedSet.has(symbol) || prior.instrumentType !== 'COMMON_STOCK'
      ? ['DR', 'DRX'].includes(prior.instrumentType) ? 'PROTECTED_DR' : 'PROTECTED_LEGACY'
      : 'MISSING_FROM_SOURCE' });
  }
  // Stable fingerprint of normalized input; changing input requires a new review.
  const canonical = rows.map(row => JSON.stringify(row)).sort();
  return {
    dryRun: true,
    writes: 0,
    inputKey: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    eligibleCommonStock: entries.filter(entry => ['ADD', 'NO_CHANGE', 'UPDATE_METADATA', 'MARKET_MOVE_CANDIDATE'].includes(entry.action)).length,
    entries
  };
}

function prepareImportAdds(input, { existing, protectedSymbols, approvedSymbols, reviewedInputKey } = {}) {
  const report = dryRunImport(input, { existing, protectedSymbols });
  if (!reviewedInputKey || reviewedInputKey !== report.inputKey || !Array.isArray(approvedSymbols)) throw Error('Exact import review required');
  const approved = new Set(approvedSymbols);
  if (approved.size !== approvedSymbols.length) throw Error('Duplicate approval');
  const additions = report.entries.filter(entry => approved.has(entry.symbol));
  if (additions.length !== approved.size || additions.some(entry => entry.action !== 'ADD')) throw Error('Only reviewed new identities may be staged');
  return additions.map(({ staged: row }) => ({
    symbol: row.symbol, provider_symbol: row.providerSymbol, provider: 'Yahoo Finance', active: true,
    instrument_id: row.instrumentId, instrument_type: row.instrumentType, listing_market: row.market,
    issuer_name: row.issuer, source_ref: row.source, source_effective_date: row.effectiveDate,
    rights_evidence: row.rightsEvidence, classification_evidence: row.classificationEvidence
  }));
}

module.exports = { parseSecurityFile, dryRunImport, prepareImportAdds };
