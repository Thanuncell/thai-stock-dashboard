// SETscope v1.6.4 WS2: offline-only, deterministic screener core.
// No provider requests, persistence, account data, scheduler, or UI side effects.
import { computeTechnicalSeries, trustedMarketBars, TECHNICAL_DEFAULTS, THAI_NAMES } from './domain.mjs';

export const SCREENER_SCHEMA_VERSION = 'setscope-screener-1';
export const SCREENER_FILTERS = Object.freeze(['price', 'changePercent', 'rsi14', 'ema20', 'ema50', 'macd']);

const valid = value => typeof value === 'number' && Number.isFinite(value);
const SYMBOL = /^[A-Z0-9&.-]{1,20}$/;
const ELIGIBLE_GUARDS = new Set(['accepted', 'delayed']);
const ELIGIBLE_HISTORY = new Set(['usable', 'usable_with_warnings']);
const USABLE_STATES = new Set(['delayed', 'fresh', 'partial']);
const DEFAULT_PAGE_SIZE = 20;
const BANGKOK_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
});

function fail(message) { throw new TypeError(`SCREENER_CONTRACT: ${message}`); }
function asMillis(value) {
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function asIso(value) {
  const millis = asMillis(value);
  if (millis === null) fail('invalid observation time');
  return new Date(millis).toISOString();
}
function bangkokDay(value) {
  const millis = asMillis(value);
  if (millis === null) return null;
  const parts = BANGKOK_DATE_FORMAT.formatToParts(new Date(millis));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function validSession(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function stableFingerprint(value) {
  let hash = 2166136261;
  for (const char of JSON.stringify(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function safeMetric(value) { return valid(value) ? value : null; }
function blocked(symbol, reason, eligibility = false) {
  return { symbol, eligible: eligibility, state: reason, exclusionReasons: [reason],
    price: { close: null, previousClose: null, changePercent: null },
    technical: { ema20: null, ema50: null, rsi14: null, macd: null, macdSignal: null },
    available: { price: false, changePercent: false, ema20: false, ema50: false, rsi14: false, macd: false },
    confirmedBars: 0, sourceAsOf: null, candleTime: null };
}

export function screenerEligible(row) {
  return Boolean(row.active === true && row.symbol_verified === true && row.chart_ready === true
    && row.status === 'verified' && ELIGIBLE_GUARDS.has(row.guard_status)
    && row.provider === 'Yahoo Finance' && row.provider_symbol === `${row.symbol}.BK`);
}

/**
 * Build one row from already-guarded daily OHLCV evidence. Input is deliberately
 * independent of the Chart API and does not make external requests.
 * complete/availableAt must originate from the existing market-time contract.
 */
export function buildDailyScreenerRow(coverage, evidence, { sessionDate, observedAt } = {}) {
  const symbol = coverage?.symbol;
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) fail('invalid registry symbol');
  if (!validSession(sessionDate)) fail('invalid trading session');
  const cutoff = asMillis(observedAt);
  if (cutoff === null) fail('invalid observation time');
  if (!screenerEligible(coverage)) return frozen(blocked(symbol, 'COVERAGE_INELIGIBLE'));
  if (!evidence) return frozen(blocked(symbol, 'UNAVAILABLE', true));
  if (evidence.provider !== coverage.provider || evidence.providerSymbol !== coverage.provider_symbol
    || evidence.identityStatus !== 'accepted' || !ELIGIBLE_GUARDS.has(evidence.guardStatus)
    || !ELIGIBLE_HISTORY.has(evidence.historyStatus) || evidence.interval !== '1d'
    || !USABLE_STATES.has(evidence.dataState) || !Array.isArray(evidence.guardReasons)
    || evidence.guardReasons.length > 0) {
    return frozen(blocked(symbol, 'GUARD_BLOCKED', true));
  }
  const fetchedAt = asMillis(evidence.sourceFetchedAt);
  if (fetchedAt === null || fetchedAt > cutoff || (evidence.sessionDate && evidence.sessionDate !== sessionDate))
    return frozen(blocked(symbol, 'STALE_SESSION', true));
  if (!Array.isArray(evidence.bars) || evidence.bars.length === 0)
    return frozen(blocked(symbol, 'UNAVAILABLE', true));
  if (evidence.bars.length > 1000) fail('unbounded bar history');

  // trustedMarketBars accepts price-only inputs for other Chart use cases.
  // Screener requires explicit daily OHLC and an honest candle availability
  // contract. It must not upgrade a forged complete flag or malformed record.
  const validBar = bar => {
    if (!bar || typeof bar !== 'object' || !valid(bar.time) || bar.time <= 0
      || bar.time > fetchedAt || typeof bar.complete !== 'boolean') return false;
    const { open, high, low, close, volume } = bar;
    if (![open, high, low, close].every(v => valid(v) && v > 0)
      || high < low || open < low || open > high || close < low || close > high
      || (volume != null && (!valid(volume) || volume < 0))
      || (bar.guardStatus && bar.guardStatus !== 'accepted')) return false;
    const available = bar.availableAt == null ? null : asMillis(bar.availableAt);
    if (bar.availableAt != null && available === null) return false;
    if (available !== null && available <= bar.time) return false;
    if (bar.complete && (available === null || available > cutoff || available > fetchedAt)) return false;
    return true;
  };
  if (!evidence.bars.every(validBar)) return frozen(blocked(symbol, 'GUARD_BLOCKED', true));

  // Invalid or duplicate candles are not silently counted toward a warm-up.
  const history = trustedMarketBars(evidence.bars);
  if (history.length !== evidence.bars.length || history.some(bar => !valid(bar.time) || bar.time > cutoff))
    return frozen(blocked(symbol, 'GUARD_BLOCKED', true));
  const completed = history.filter(bar => bar.complete === true
    && asMillis(bar.availableAt) !== null && asMillis(bar.availableAt) <= cutoff);
  const latest = completed.at(-1);
  if (!latest || bangkokDay(latest.time) !== sessionDate || fetchedAt < asMillis(latest.availableAt)
    || completed.some((bar, i) => i > 0 && bangkokDay(completed[i - 1].time) === bangkokDay(bar.time)))
    return frozen(blocked(symbol, 'STALE_SESSION', true));

  // All technical formulas are imported from the existing Chart domain module.
  // Do not recalculate signals from unfinished or future candles.
  const series = computeTechnicalSeries(completed, TECHNICAL_DEFAULTS);
  const take = values => safeMetric(values?.at(-1));
  const close = safeMetric(latest.close);
  const previousClose = safeMetric(completed.at(-2)?.close);
  if (close === null || close <= 0) return frozen(blocked(symbol, 'GUARD_BLOCKED', true));
  const changePercent = previousClose !== null && previousClose > 0
    ? (close - previousClose) / previousClose * 100 : null;
  const technical = {
    ema20: take(series.ema20), ema50: take(series.ema50), rsi14: take(series.rsi),
    macd: take(series.macd), macdSignal: take(series.signal)
  };
  const available = {
    price: true, changePercent: valid(changePercent),
    ema20: valid(technical.ema20), ema50: valid(technical.ema50),
    rsi14: valid(technical.rsi14), macd: valid(technical.macd) && valid(technical.macdSignal)
  };
  return frozen({ symbol, eligible: true, state: 'READY', exclusionReasons: [],
    price: { close, previousClose, changePercent: safeMetric(changePercent) },
    technical, available, confirmedBars: completed.length,
    sourceAsOf: new Date(fetchedAt).toISOString(), candleTime: new Date(latest.time).toISOString() });
}

/** Build an immutable result. The caller owns staging and durable publication. */
export function buildScreenerSnapshot({ registry, evidenceBySymbol = {}, sessionDate,
  latestCompletedSessionDate, observedAt } = {}) {
  if (!validSession(latestCompletedSessionDate)) fail('missing latest completed trading session');
  if (sessionDate !== latestCompletedSessionDate) fail('snapshot session differs from latest completed trading session');
  const dayOfWeek = new Date(`${latestCompletedSessionDate}T00:00:00Z`).getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) fail('non-trading weekend session');
  if (!Array.isArray(registry) || registry.length > 1000) fail('invalid registry size');
  if (!evidenceBySymbol || typeof evidenceBySymbol !== 'object') fail('invalid evidence index');
  if (!validSession(sessionDate)) fail('invalid trading session');
  const generatedAt = asIso(observedAt);
  const seen = new Set(), providerSymbols = new Set();
  for (const item of registry) {
    if (!item || typeof item.symbol !== 'string' || !SYMBOL.test(item.symbol) || seen.has(item.symbol))
      fail('invalid or duplicate registry symbol');
    seen.add(item.symbol);
    if (typeof item.provider_symbol !== 'string' || providerSymbols.has(item.provider_symbol))
      fail('invalid or duplicate provider mapping');
    providerSymbols.add(item.provider_symbol);
  }
  const rows = registry.map(row => buildDailyScreenerRow(row,
    evidenceBySymbol instanceof Map ? evidenceBySymbol.get(row.symbol) : Object.hasOwn(evidenceBySymbol, row.symbol) ? evidenceBySymbol[row.symbol] : null,
    { sessionDate, observedAt: generatedAt }))
    .sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0);
  const counts = {
    registered: rows.length,
    eligible: rows.filter(row => row.eligible).length,
    ready: rows.filter(row => row.state === 'READY').length,
    unavailable: rows.filter(row => row.state === 'UNAVAILABLE').length,
    staleSession: rows.filter(row => row.state === 'STALE_SESSION').length,
    guardBlocked: rows.filter(row => row.state === 'GUARD_BLOCKED').length,
    coverageIneligible: rows.filter(row => row.state === 'COVERAGE_INELIGIBLE').length
  };
  const id = `${SCREENER_SCHEMA_VERSION}:${sessionDate}:${stableFingerprint(rows)}`;
  return frozen({ schemaVersion: SCREENER_SCHEMA_VERSION, id, sessionDate,
    latestCompletedSessionDate, generatedAt,
    state: counts.eligible > 0 && counts.ready === counts.eligible ? 'COMPLETE' : counts.ready ? 'PARTIAL' : 'UNAVAILABLE',
    counts, rows });
}

function boundRange(value, name, min = -Infinity, max = Infinity) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['min', 'max'].includes(key))) fail(`invalid ${name} filter`);
  const lower = value.min == null ? null : value.min;
  const upper = value.max == null ? null : value.max;
  if (lower !== null && (!valid(lower) || lower < min || lower > max)) fail(`invalid ${name} minimum`);
  if (upper !== null && (!valid(upper) || upper < min || upper > max)) fail(`invalid ${name} maximum`);
  if (lower === null && upper === null) return null;
  if (lower !== null && upper !== null && lower > upper) fail(`inverted ${name} range`);
  return { min: lower, max: upper };
}
function direction(value, name) {
  if (value == null || value === 'any') return null;
  if (value !== 'above' && value !== 'below') fail(`invalid ${name} comparison`);
  return value;
}
function sortValue(row, field) {
  if (field === 'symbol') return row.symbol;
  if (field === 'price') return row.price.close;
  if (field === 'changePercent') return row.price.changePercent;
  if (field === 'rsi14') return row.technical.rsi14;
  return null;
}

/** Every selected filter must have finite evidence; missing is UNKNOWN, never 0.
 * Querying an existing snapshot has no calls to the provider or persistence. */
export function queryScreenerSnapshot(snapshot, filters = {}, options = {}) {
  if (!snapshot || snapshot.schemaVersion !== SCREENER_SCHEMA_VERSION || !Array.isArray(snapshot.rows))
    fail('invalid snapshot');
  const known = new Set(['search', ...SCREENER_FILTERS]);
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) fail('invalid filters');
  for (const name of Object.keys(filters)) if (!known.has(name)) fail(`unknown filter ${name}`);
  const price = boundRange(filters.price, 'price', 0);
  const change = boundRange(filters.changePercent, 'changePercent');
  const rsi = boundRange(filters.rsi14, 'rsi14', 0, 100);
  const ema20 = direction(filters.ema20, 'ema20');
  const ema50 = direction(filters.ema50, 'ema50');
  const macd = direction(filters.macd, 'macd');
  const search = String(filters.search ?? '').trim().toUpperCase();
  if (search.length > 80) fail('search too long');
  const sortBy = options.sortBy ?? 'symbol';
  const sortDirection = options.sortDirection ?? 'asc';
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!['symbol', 'price', 'changePercent', 'rsi14'].includes(sortBy)
    || !['asc', 'desc'].includes(sortDirection)
    || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100)
    fail('invalid sorting or pagination');

  let evaluated = 0, unevaluable = 0, matched = 0, excluded = 0, notMatched = 0;
  const results = [];
  for (const row of snapshot.rows) {
    if (row.state !== 'READY') { excluded++; continue; }
    if (search && !row.symbol.includes(search) && !THAI_NAMES[row.symbol]?.toUpperCase().includes(search)) continue;
    const needed = [
      ...(price ? [row.price.close] : []), ...(change ? [row.price.changePercent] : []),
      ...(rsi ? [row.technical.rsi14] : []), ...(ema20 ? [row.technical.ema20, row.price.close] : []),
      ...(ema50 ? [row.technical.ema50, row.price.close] : []),
      ...(macd ? [row.technical.macd, row.technical.macdSignal] : [])
    ];
    if (needed.some(value => !valid(value))) { unevaluable++; continue; }
    evaluated++;
    const inRange = (value, range) => !range || (range.min === null || value >= range.min) && (range.max === null || value <= range.max);
    const compare = (left, right, op) => !op || (op === 'above' ? left > right : left < right);
    if (inRange(row.price.close, price) && inRange(row.price.changePercent, change)
      && inRange(row.technical.rsi14, rsi)
      && compare(row.price.close, row.technical.ema20, ema20)
      && compare(row.price.close, row.technical.ema50, ema50)
      && compare(row.technical.macd, row.technical.macdSignal, macd)) {
      matched++; results.push(row);
    } else notMatched++;
  }
  results.sort((a, b) => {
    const av = sortValue(a, sortBy), bv = sortValue(b, sortBy);
    if (av === null || bv === null) return av === bv ? (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) : av === null ? 1 : -1;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp ? (sortDirection === 'asc' ? cmp : -cmp) : a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
  const totalPages = Math.ceil(results.length / pageSize);
  return frozen({ snapshotId: snapshot.id, sessionDate: snapshot.sessionDate,
    counts: { registered: snapshot.counts.registered, eligible: snapshot.counts.eligible,
      excluded, evaluated, unevaluable, matched, notMatched },
    page, pageSize, totalPages, rows: results.slice((page - 1) * pageSize, page * pageSize) });
}
