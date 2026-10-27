'use strict';

const SYMBOL_PATTERN = /^[A-Z0-9&.-]{1,20}$/;
const MAX_WATCHLISTS = 5;
const MAX_WATCHLIST_ITEMS = 30;

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

function normalizeMarketSymbols(value) {
  return String(value || '').split(',').map(normalizeSymbol).filter(Boolean).slice(0, MAX_WATCHLIST_ITEMS);
}

function normalizeWatchlistsPayload(body = {}) {
  const lists = body.watchlists;
  if (!Array.isArray(lists) || lists.length < 1 || lists.length > MAX_WATCHLISTS) {
    return { ok: false, error: 'ต้องมี Watchlist 1–5 รายการ' };
  }
  const watchlists = lists.map((list, index) => {
    const id = String(list.id || `list-${index + 1}`).slice(0, 40);
    const name = String(list.name || `Watchlist ${index + 1}`).trim().slice(0, 40);
    const items = (Array.isArray(list.items) ? list.items : []).slice(0, MAX_WATCHLIST_ITEMS)
      .filter(item => item && normalizeSymbol(item.symbol))
      .map(item => ({
        symbol: normalizeSymbol(item.symbol),
        name: String(item.name || item.symbol).slice(0, 100)
      }));
    return { id, name, items };
  });
  const activeWatchlistId = watchlists.some(list => list.id === body.activeWatchlistId)
    ? body.activeWatchlistId
    : watchlists[0].id;
  return { ok: true, watchlists, activeWatchlistId };
}

function normalizeWatchlistNewsStocks(rawStocks = '') {
  let stocks = [];
  try { stocks = Array.isArray(rawStocks) ? rawStocks : JSON.parse(rawStocks); }
  catch (_) { stocks = String(rawStocks).split(',').map(symbol => ({ symbol })); }
  const unique = new Map();
  for (const item of Array.isArray(stocks) ? stocks : []) {
    const symbol = normalizeSymbol(String(typeof item==='string'?item:item?.symbol||'').trim().replace(/\.BK$/i,'')), name = String(item?.name || '').trim().slice(0, 80);
    if (symbol && !unique.has(symbol)) unique.set(symbol, { symbol, name });
    if (unique.size >= MAX_WATCHLIST_ITEMS) break;
  }
  return [...unique.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

module.exports = {
  MAX_WATCHLIST_ITEMS,
  MAX_WATCHLISTS,
  normalizeMarketSymbols,
  normalizeSymbol,
  normalizeWatchlistNewsStocks,
  normalizeWatchlistsPayload
};
