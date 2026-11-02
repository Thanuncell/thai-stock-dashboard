'use strict';

const { readSettradeState } = require('./settrade-state');

// Reads only the HTML body already retrieved by the Overview provider.
// Source/page checks remain the caller's responsibility; no acquisition here.
function validSourceTime(timestamp) {
  if (typeof timestamp !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (!match || !Number.isFinite(Date.parse(timestamp))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const actual = new Date(Date.UTC(year, month - 1, day));
  const offset = match[7];
  const offsetOkay = offset === 'Z' || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) < 60);
  return offsetOkay && year >= 2000 && year <= 2100
    && actual.getUTCFullYear() === year && actual.getUTCMonth() + 1 === month && actual.getUTCDate() === day
    && hour < 24 && minute < 60 && second < 60;
}

const validNumber = value => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = value => value == null || validNumber(value);
const AOM_UNIT_BASIS = 'SET_AOM_BAHT_SHARES';

function parseHydratedMostActive(html) {
  const base = { items: [], asOf: '', outcome: 'NOT_APPLICABLE', metadataValid: false, invalidRows: 0, totalRows: 0, renderableRows: 0, unrenderableRows: 0, duplicateRows: 0, conflictingRows: 0 };
  if (typeof html !== 'string' || !/window\.__NUXT__\s*=/.test(html)) return base;
  const state = readSettradeState(html);
  if (!state) return { ...base, outcome: 'PARSER_MISMATCH' };
  const info = state?.state?.summary?.topRanking?.info;
  if (!info || info.rankingType !== 'mostActiveValue' || info.market !== 'SET'
    || !Array.isArray(info.stocks) || info.stocks.length > 100) {
    return { ...base, outcome: 'ACQUISITION_GAP' };
  }
  if (!validSourceTime(info.marketDateTime)) return { ...base, outcome: 'INVALID_DATA', totalRows: info.stocks.length };
  const items = [];
  let invalidRows = 0;
  for (const [index, row] of info.stocks.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.symbol !== 'string' || !/^[A-Z0-9&.-]{1,20}$/.test(row.symbol)
      || !validNumber(row.aomValue) || row.aomValue < 0
      || !validNumber(row.aomVolume) || row.aomVolume < 0
      || !['last', 'change', 'percentChange', 'low', 'high'].every(key => optionalNumber(row[key]))
      || ['last', 'low', 'high'].some(key => row[key] != null && row[key] < 0)
      || (row.low != null && row.high != null && row.low > row.high)) {
      invalidRows += 1;
      continue;
    }
    items.push({
      rank: index + 1, symbol: row.symbol,
      // Reviewed AOM definitions and retained source corroboration establish
      // the base-unit conversion. Preserve raw values and the evidence basis.
      turnoverMillion: row.aomValue / 1_000_000,
      volumeThousand: row.aomVolume / 1_000,
      sourceQuantities: { origin: 'SETTRADE_AOM', basis: AOM_UNIT_BASIS, verification: 'EVIDENCE_SUPPORTED',
        value: { sourceField: 'aomValue', raw: row.aomValue, unit: 'baht' },
        volume: { sourceField: 'aomVolume', raw: row.aomVolume, unit: 'shares' } },
      last: row.last ?? null, change: row.change ?? null,
      changePercent: row.percentChange ?? null,
      low: row.low ?? null, high: row.high ?? null
    });
  }
  const diagnostics = { invalidRows, unrenderableRows: 0, duplicateRows: 0, conflictingRows: 0 };
  // Preserve incomplete parsed rows for diagnostics, without giving them any
  // symbol/rank ownership. Only complete validated rows enter deduplication.
  const selected = deduplicateRenderableRows(items, diagnostics, true);
  const renderableRows = selected.filter(isRenderableActiveRow).length;
  return {
    items: selected, asOf: info.marketDateTime,
    sourceRankingPeriod: typeof info.rankingPeriod === 'string' && info.rankingPeriod.length <= 80 ? info.rankingPeriod : null,
    metadataValid: true, totalRows: info.stocks.length, ...diagnostics, renderableRows,
    outcome: renderableRows ? 'ACCEPT' : diagnostics.conflictingRows ? 'INVALID_DATA'
      : selected.length ? 'ACQUISITION_GAP' : diagnostics.invalidRows ? 'INVALID_DATA' : 'SOURCE_NO_DATA'
  };
}

function validActiveQuantities(row) {
  const q = row.sourceQuantities;
  if (!q) return [row.turnoverMillion, row.volumeThousand].every(value => validNumber(value) && value >= 0);
  if (!['SETTRADE_AOM', 'HTML_TABLE'].includes(q.origin)) return false;
  const rawAom = q.value?.unit === null && q.volume?.unit === null;
  const supportedAom = q.basis === AOM_UNIT_BASIS && q.verification === 'EVIDENCE_SUPPORTED'
    && q.value?.unit === 'baht' && q.volume?.unit === 'shares';
  if (q.origin === 'SETTRADE_AOM' && !rawAom && !supportedAom) return false;
  return [['value', 'turnoverMillion', 'million_baht', 'aomValue', 1_000_000], ['volume', 'volumeThousand', 'thousand_shares', 'aomVolume', 1_000]].every(([key, normalized, unit, field, divisor]) => {
    const quantity = q[key];
    if (!quantity || !validNumber(quantity.raw) || quantity.raw < 0 || typeof quantity.sourceField !== 'string') return false;
    if (q.origin === 'SETTRADE_AOM') return quantity.sourceField === field
      && (rawAom ? row[normalized] === null : row[normalized] === quantity.raw / divisor);
    if (quantity.unit === null) return row[normalized] === null;
    const labelled = key === 'value' ? /\(\s*(?:ล้านบาท|million\s*(?:baht|THB))\s*\)/i.test(quantity.sourceField) && !/พันล้านบาท/i.test(quantity.sourceField)
      : /\(\s*['’]?000(?:\s*(?:หุ้น|shares))?\s*\)|พันหุ้น|thousand\s*shares/i.test(quantity.sourceField);
    return labelled && quantity.unit === unit && row[normalized] === quantity.raw;
  });
}

function isValidatedActiveRow(row) {
  return typeof row?.symbol === 'string' && /^[A-Z0-9&.-]{1,20}$/.test(row.symbol)
    && Number.isSafeInteger(row.rank) && row.rank >= 1 && row.rank <= 100
    && validActiveQuantities(row)
    && [row.last, row.change, row.changePercent, row.low, row.high].every(optionalNumber)
    && [row.last, row.low, row.high].every(value => value == null || value >= 0)
    && !(row.low != null && row.high != null && row.low > row.high);
}

function isRenderableActiveRow(row) {
  return isValidatedActiveRow(row) && [row.last, row.change, row.changePercent].every(validNumber);
}

function deduplicateRenderableRows(rows, diagnostics, keepIncomplete = false) {
  const entries = [], symbols = new Map(), ranks = new Map();
  for (const row of rows) {
    if (!isValidatedActiveRow(row)) { diagnostics.invalidRows += 1; continue; }
    if (!isRenderableActiveRow(row)) {
      diagnostics.unrenderableRows += 1;
      if (keepIncomplete) entries.push({ row });
      continue;
    }
    const signature = JSON.stringify([row.rank, row.symbol, row.turnoverMillion, row.volumeThousand,
      row.last, row.change, row.changePercent, row.low ?? null, row.high ?? null, row.sourceQuantities || null]);
    const entry = { row, signature };
    entries.push(entry);
    for (const [groups, key] of [[symbols, row.symbol], [ranks, row.rank]]) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
  }
  // Inspect all complete occurrences before choosing any row. Conflicting
  // symbol/rank groups are suppressed in full; later rows cannot revive them.
  const conflicts = new Set();
  for (const groups of [symbols, ranks]) {
    for (const group of groups.values()) {
      if (new Set(group.map(entry => entry.signature)).size > 1) {
        for (const entry of group) conflicts.add(entry);
      }
    }
  }
  const signatures = new Set();
  return entries.filter(entry => {
    if (!entry.signature) return true;
    if (conflicts.has(entry)) {
      diagnostics.invalidRows += 1; diagnostics.conflictingRows += 1;
      return false;
    }
    if (signatures.has(entry.signature)) { diagnostics.duplicateRows += 1; return false; }
    signatures.add(entry.signature);
    return true;
  }).map(entry => entry.row);
}

function selectMostActiveResponse(html, table, pageVerified) {
  const outcome = table.__diagnostics?.result;
  const result = (items, asOf, reason, diagnostics = {}) => Object.defineProperty({ items, asOf }, '__diagnostics', {
    enumerable: false, value: { ...diagnostics, result: reason }
  });
  if (!pageVerified) return result([], '', 'PARSER_MISMATCH');
  const diagnostics = { ...table.__diagnostics, origin: 'HTML_TABLE', invalidRows: table.__diagnostics?.invalidRows || 0, unrenderableRows: 0, duplicateRows: 0, conflictingRows: 0 };
  if (outcome === 'INVALID_DATA') return result([], table.asOf, outcome, diagnostics);
  const tableItems = deduplicateRenderableRows(table.items, diagnostics);
  if (tableItems.length) return result(tableItems, table.asOf, 'ACCEPT', diagnostics);
  if (diagnostics.invalidRows) return result([], table.asOf, 'INVALID_DATA', diagnostics);
  const hydrated = parseHydratedMostActive(html);
  if (hydrated.outcome === 'NOT_APPLICABLE') {
    return result([], table.asOf, outcome === 'ACCEPT' ? 'PARSER_MISMATCH' : outcome, diagnostics);
  }
  // Keep the established API reason vocabulary. An acquisition gap in this
  // already-fetched body is a schema mismatch, never an instruction to fetch.
  const reason = hydrated.outcome === 'ACQUISITION_GAP' ? 'PARSER_MISMATCH' : hydrated.outcome;
  return result(reason === 'ACCEPT' ? hydrated.items.filter(isRenderableActiveRow) : [], hydrated.asOf, reason, {
    ...diagnostics, origin: 'HYDRATION', invalidRows: diagnostics.invalidRows + hydrated.invalidRows,
    sourceRankingPeriod: hydrated.sourceRankingPeriod,
    unrenderableRows: diagnostics.unrenderableRows + hydrated.unrenderableRows,
    duplicateRows: diagnostics.duplicateRows + hydrated.duplicateRows,
    conflictingRows: diagnostics.conflictingRows + hydrated.conflictingRows
  });
}

module.exports = { AOM_UNIT_BASIS, parseHydratedMostActive, validSourceTime, isRenderableActiveRow, selectMostActiveResponse };
