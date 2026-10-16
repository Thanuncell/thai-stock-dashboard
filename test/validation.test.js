'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMarketSymbols,
  normalizeSymbol,
  normalizeWatchlistNewsStocks,
  normalizeWatchlistsPayload
} = require('../lib/validation');

test('symbol validation normalizes supported SET symbols and rejects paths', () => {
  assert.equal(normalizeSymbol(' ptt '), 'PTT');
  assert.equal(normalizeSymbol('BTS-W1'), 'BTS-W1');
  assert.equal(normalizeSymbol('../PTT'), null);
  assert.equal(normalizeSymbol(''), null);
  assert.equal(normalizeSymbol('A'.repeat(21)), null);
});

test('market symbol lists preserve order while filtering invalid values', () => {
  assert.deepEqual(normalizeMarketSymbols('PTT,../BAD,AOT,PTT'), ['PTT', 'AOT', 'PTT']);
});

test('watchlist payload enforces list and item limits without trusting user_id', () => {
  const tooManyLists = { watchlists: Array.from({ length: 6 }, (_, index) => ({ id: `l${index}`, items: [] })) };
  assert.equal(normalizeWatchlistsPayload(tooManyLists).ok, false);

  const items = Array.from({ length: 35 }, (_, index) => ({ symbol: `A${index}`, name: `Stock ${index}` }));
  items.splice(1, 0, { symbol: '../BAD', name: 'invalid' });
  const result = normalizeWatchlistsPayload({
    user_id: 'attacker-controlled',
    watchlists: [{ id: 'primary', name: '  Main  ', items }],
    activeWatchlistId: 'missing'
  });

  assert.equal(result.ok, true);
  assert.equal(result.watchlists.length, 1);
  assert.equal(result.watchlists[0].items.length, 29);
  assert.equal(result.watchlists[0].items.some(item => item.symbol.includes('/')), false);
  assert.equal(result.activeWatchlistId, 'primary');
  assert.equal(Object.hasOwn(result, 'user_id'), false);
});

test('watchlist news inputs are deduplicated, sorted and capped', () => {
  const requested = [
    { symbol: 'ptt', name: 'ปตท.' },
    { symbol: 'AOT', name: 'ท่าอากาศยานไทย' },
    { symbol: 'PTT', name: 'duplicate' },
    { symbol: '../BAD', name: 'invalid' }
  ];
  assert.deepEqual(normalizeWatchlistNewsStocks(requested), [
    { symbol: 'AOT', name: 'ท่าอากาศยานไทย' },
    { symbol: 'PTT', name: 'ปตท.' }
  ]);
});
