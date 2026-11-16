import * as timeModule from '../lib/market-time.js';
const { temporalBars } = timeModule.default || globalThis.SETscopeMarketTime;
export const HISTORICAL_RANGES = Object.freeze(['1M', '3M', '6M', '1Y', 'ALL']);
const offset = 7 * 3600000;

function bucket(time, timeframe) {
  const date = new Date(time + offset);
  if (timeframe === 'M') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - offset;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - (date.getUTCDay() + 6) % 7) - offset;
}

// Input is the existing guarded daily history. Empty calendar periods produce no bars.
export function aggregateDailyBars(rows, timeframe) {
  if (timeframe === 'D') return rows.map(row => ({ ...row }));
  const groups = [];
  let key;
  for (const row of rows) {
    const nextKey = bucket(row.time, timeframe);
    if (nextKey !== key) {
      key = nextKey;
      groups.push({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
    } else {
      const bar = groups.at(-1);
      bar.high = Math.max(bar.high, row.high);
      bar.low = Math.min(bar.low, row.low);
      bar.close = row.close;
      bar.volume = bar.volume == null || row.volume == null ? null : bar.volume + row.volume;
    }
  }
  return groups;
}

function rangeStart(time, range) {
  if (range === 'ALL') return -Infinity;
  const date = new Date(time + offset), dateOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - ({ '1M': 1, '3M': 3, '6M': 6, '1Y': 12 }[range] || 12));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(dateOfMonth, last));
  return +date - offset;
}

export function marketTimeframe(market, timeframe, historicalRange) {
  if (timeframe === 'Auto') return market;
  const interval = { D: '1d', W: '1wk', M: '1mo' }[timeframe];
  const metadata = {}, histories = {};
  const cutoff = rangeStart(Date.parse(market.fetchedAt), historicalRange);
  for (const [field, metaKey] of [['history', 'history'], ['indicatorHistory', 'indicator'], ['levelsHistory', 'levels']]) {
    const meta = market.technicalMeta?.[metaKey] || market.technicalMeta?.history || {};
    // Never relabel an intraday response as daily, weekly or monthly data.
    const daily = meta.interval === '1d' ? market[field] || market.history || [] : [];
    metadata[metaKey] = { ...meta, interval, sourceInterval: meta.interval, aggregation: timeframe === 'D' ? undefined : 'daily-ohlcv' };
    const rows = temporalBars(aggregateDailyBars(daily, timeframe), { ...meta, interval, observedAt: meta.receivedAt || market.fetchedAt });
    // Include the whole real bucket intersecting the selected historical window.
    histories[field] = field === 'history' ? rows.filter(row => cutoff === -Infinity || (timeframe === 'D' ? row.time >= cutoff
      : bucket(row.time, timeframe) >= bucket(cutoff, timeframe))) : rows;
  }
  return { ...market, ...histories, technicalMeta: metadata };
}
