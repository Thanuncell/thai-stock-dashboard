'use strict';

const { normalizeSymbol } = require('../lib/validation');

function invalidateVerifiedMarket(cache, symbol, verification) {
  if (normalizeSymbol(symbol) !== symbol || !verification?.quoteReady || !verification?.chartReady
    || !['accepted', 'delayed'].includes(verification.guardStatus)
    || !Number.isFinite(Date.parse(verification.asOf || ''))) return false;
  cache.invalidate(key => {
    if (!key.startsWith('market:')) return false;
    const [symbols, active] = key.slice(7).split('|');
    return active === symbol || symbols.split(',').includes(symbol);
  });
  return true;
}

module.exports = { invalidateVerifiedMarket };
