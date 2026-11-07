'use strict';

const { normalizeSymbol } = require('../lib/validation');
const { registryCompanyName } = require('./search-company-names');
const publishedMembership = require('./index-membership.json');

const setLists = 'https://www.set.or.th/th/market/information/securities-list/';
const sources = {
  SET50: setLists + 'constituents-list-set50-set100',
  SET100: setLists + 'constituents-list-set50-set100',
  SETHD: setLists + 'constituents-list-sethd',
  SETESG: setLists + 'constituents-list-setesg',
  mai: setLists + 'main'
};
const todayInThailand = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' });

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function readGroup(entry, today) {
  if (!entry || !validDate(entry.effectiveFrom) || !validDate(entry.effectiveThrough)
    || today < entry.effectiveFrom || today > entry.effectiveThrough
    || !Array.isArray(entry.symbols) || !entry.symbols.length) return null;
  const symbols = new Set(entry.symbols.map(value => typeof value === 'string' ? normalizeSymbol(value) : null));
  if (symbols.has(null) || symbols.size !== entry.symbols.length) return null;
  return { effectiveFrom: entry.effectiveFrom, effectiveThrough: entry.effectiveThrough, symbols };
}

// Owner Excel entries contain only workbook flags that agreed with the reference
// check. Listing transfers use separate dated notices.
// An absent, expired or conflicting list stays unavailable. No upstream fetch is performed.
function buildIndexCatalog(registry, membership = publishedMembership, today = todayInThailand.format(new Date())) {
  if (!Array.isArray(registry) || !registry.length) throw Error('Coverage registry unavailable');
  const stocks = new Map();
  for (const row of registry) {
    const symbol = normalizeSymbol(row?.symbol);
    if (!symbol || stocks.has(symbol)) throw Error('Invalid coverage registry symbol');
    stocks.set(symbol, { symbol, name: registryCompanyName(row) || '' });
  }
  const groups = Object.fromEntries(Object.keys(sources).map(key => [key, readGroup(membership[key], today)]));
  if (groups.mai) {
    for (const [symbol, transfer] of Object.entries(membership.listingTransfers || {})) {
      if (transfer?.market === 'SET' && validDate(transfer.effectiveFrom) && transfer.effectiveFrom <= today)
        groups.mai.symbols.delete(symbol);
    }
    if (!groups.mai.symbols.size) groups.mai = null;
  }
  if (groups.SET50 && groups.SET100 && [...groups.SET50.symbols].some(symbol => !groups.SET100.symbols.has(symbol))) {
    groups.SET50 = groups.SET100 = null;
  }
  // SETESG membership and a mai listing are independent classifications.
  for (const key of ['SET50', 'SET100', 'SETHD']) {
    if (groups.mai && groups[key] && [...groups.mai.symbols].some(symbol => groups[key].symbols.has(symbol))) {
      groups[key] = null;
      groups.mai.conflict = true;
    }
  }
  if (groups.mai?.conflict) groups.mai = null;
  const verified = new Set(Object.values(groups).flatMap(group => group ? [...group.symbols] : []));

  return {
    stocks: [...stocks.values()].map(stock => ({
      ...stock,
      membershipStatus: verified.has(stock.symbol) ? 'VERIFIED' : 'UNKNOWN'
    })),
    groups: Object.fromEntries(Object.entries(groups).map(([key, group]) => {
      const source = sources[key];
      if (!group) return [key, { source, available: false }];
      const { effectiveFrom, effectiveThrough } = group;
      const symbols = [...group.symbols].filter(symbol => stocks.has(symbol));
      return [key, { source, sourceType: membership.sourceType === 'OWNER_EXCEL' ? 'OWNER_EXCEL' : 'SET',
        available: true, effectiveFrom, effectiveThrough, symbols,
        outsideCoverage: group.symbols.size - symbols.length }];
    }))
  };
}

module.exports = { buildIndexCatalog };
