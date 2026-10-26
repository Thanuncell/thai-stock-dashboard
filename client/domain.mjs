'use strict';

export const DEFAULT_WATCHLIST = [
  { symbol: 'PTT', name: 'ปตท.' },
  { symbol: 'AOT', name: 'ท่าอากาศยานไทย' },
  { symbol: 'ADVANC', name: 'แอดวานซ์ อินโฟร์' },
  { symbol: 'KBANK', name: 'ธนาคารกสิกรไทย' },
  { symbol: 'CPALL', name: 'ซีพี ออลล์' }
];
export const MAX_WATCHLIST = 30;
export const MAX_WATCHLISTS = 5;
export const THAI_NAMES = Object.fromEntries(DEFAULT_WATCHLIST.map(item => [item.symbol, item.name]));
export const NEWS_SOURCES = Object.freeze(['all', 'thunhoon', 'kaohoon', 'settrade', 'official', 'infoquest', 'efinance', 'broker']);
export const CHART_RANGES = Object.freeze(['1D', '1W', '1M', '3M', '1Y']);
const ROUTES = Object.freeze(['overview', 'chart', 'news', 'watchlist']);

export function chartGeometry({ rowCount = 0, hostWidth = 640 } = {}) {
  const count = Math.max(1, Number.parseInt(rowCount, 10) || 1);
  const width = Math.max(320, Math.floor(Number(hostWidth) || 640));
  const left = width < 520 ? 52 : 66;
  const right = width < 520 ? 10 : 16;
  const plotWidth = Math.max(1, width - left - right);
  const step = plotWidth / count;
  const candleWidth = Math.max(1, Math.min(12, step * 0.62));
  return { width, left, right, plotWidth, step, candleWidth, x: index => left + step * index + step / 2 };
}

export function defaultChartViewport({ rowCount = 0, hostWidth = 640, range = '1D' } = {}) {
  const total = Math.max(0, Number.parseInt(rowCount, 10) || 0);
  if (!total) return { start: 0, end: 0, followLatest: true };
  const compact = Number(hostWidth) < 520;
  const preferred = range === '1Y' ? (compact ? 56 : 90) : compact ? 42 : 68;
  const visible = Math.min(total, Math.max(12, preferred));
  return { start: total - visible, end: total, followLatest: true };
}

export function normalizeChartViewport(viewport, rowCount, options = {}) {
  const total = Math.max(0, Number.parseInt(rowCount, 10) || 0);
  if (!total) return { start: 0, end: 0, followLatest: true };
  if (!viewport || !Number.isFinite(Number(viewport.start)) || !Number.isFinite(Number(viewport.end))) {
    return defaultChartViewport({ rowCount: total, hostWidth: options.hostWidth, range: options.range });
  }
  const minimum = Math.min(total, Math.max(4, Number.parseInt(options.minimumBars, 10) || 12));
  const span = Math.min(total, Math.max(minimum, Math.round(Number(viewport.end) - Number(viewport.start))));
  const followLatest = options.followLatest ?? Boolean(viewport.followLatest);
  const requestedStart = followLatest ? total - span : Math.round(Number(viewport.start));
  const start = Math.max(0, Math.min(total - span, requestedStart));
  return { start, end: start + span, followLatest: followLatest && start + span === total };
}

export function zoomChartViewport(viewport, rowCount, factor, anchorRatio = .5, options = {}) {
  const current = normalizeChartViewport(viewport, rowCount, options);
  const total = Math.max(0, Number.parseInt(rowCount, 10) || 0);
  if (!total) return current;
  const minimum = Math.min(total, Math.max(4, Number.parseInt(options.minimumBars, 10) || 12));
  const ratio = Math.max(0, Math.min(1, Number(anchorRatio) || 0));
  const currentSpan = current.end - current.start;
  const nextSpan = Math.max(minimum, Math.min(total, Math.round(currentSpan * (Number(factor) || 1))));
  const anchor = current.start + currentSpan * ratio;
  const start = Math.round(anchor - nextSpan * ratio);
  return normalizeChartViewport({ start, end: start + nextSpan, followLatest: false }, total, { ...options, followLatest: false });
}

export function panChartViewport(viewport, rowCount, deltaBars, options = {}) {
  const current = normalizeChartViewport(viewport, rowCount, options);
  const span = current.end - current.start;
  const total = Math.max(0, Number.parseInt(rowCount, 10) || 0);
  const start = current.start + Math.round(Number(deltaBars) || 0);
  const next = normalizeChartViewport({ start, end: start + span, followLatest: false }, total, { ...options, followLatest: false });
  return { ...next, followLatest: next.end === total };
}

export function chartPriceAxis(rows = [], extraValues = []) {
  const values = [
    ...(rows || []).flatMap(row => [toFiniteNumber(row?.low), toFiniteNumber(row?.high)]),
    ...(extraValues || []).map(toFiniteNumber)
  ].filter(value => value !== null && value > 0);
  if (!values.length) return null;
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max((high - low) * .08, high * .003, .01);
  return { min: low - pad, max: high + pad, pad };
}

const formatNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

export function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function coverageDisplayState(data = {}) {
  const unavailable = reason => ({ ready: false, reason, universe: null, currentVerified: null });
  if (data?.configured !== true) return unavailable('unavailable');
  if (!['fresh','stale'].includes(data.dataState)) return unavailable('unavailable');
  if (data.provider !== 'Yahoo Finance' || !Number.isFinite(Date.parse(data.lastChecked))) return unavailable('invalid');
  const universe = data.universe;
  const currentVerified = Object.hasOwn(data, 'currentUsable') ? data.currentUsable : data.currentVerified;
  if (!Number.isSafeInteger(universe) || universe < 0
    || !Number.isSafeInteger(currentVerified) || currentVerified < 0
    || currentVerified > universe) return unavailable('invalid');
  const details={};
  for(const key of ['historicalVerified','retainedUsable','stale','temporaryFailed','confirmedUnavailable']) {
    if(Object.hasOwn(data,key)) {
      if(!Number.isSafeInteger(data[key]) || data[key]<0) return unavailable('invalid');
      details[key]=data[key];
    }
  }
  return { ready: true, reason: data.dataState==='stale'?'stale':null, universe, currentVerified, ...details };
}

export function resolveMarketBannerFields(overviewIndex, marketIndex) {
  const overview = overviewIndex && typeof overviewIndex === 'object' ? overviewIndex : {};
  const market = marketIndex && typeof marketIndex === 'object' ? marketIndex : {};
  const nonNegative = value => {
    const number = toFiniteNumber(value);
    return number !== null && number >= 0 ? number : null;
  };
  const positive = value => {
    const number = toFiniteNumber(value);
    return number !== null && number > 0 ? number : null;
  };
  const range = row => {
    const high = positive(row?.high), low = positive(row?.low);
    return high !== null && low !== null && high >= low ? { high, low } : null;
  };

  const overviewAccepted = positive(overview.last) !== null;
  const overviewVolume = nonNegative(overview.volumeThousand);
  const marketRawVolume = nonNegative(market.volume);
  const overviewRange = range(overview), marketRange = range(market);
  const overviewTurnover = nonNegative(overview.turnoverMillion);
  const marketTurnover = nonNegative(market.turnoverMillionBaht);

  return {
    index: overviewAccepted ? overview : null,
    volumeThousand: overviewVolume ?? (marketRawVolume === null ? null : marketRawVolume / 1000),
    high: (overviewRange || marketRange)?.high ?? null,
    low: (overviewRange || marketRange)?.low ?? null,
    turnoverMillion: overviewTurnover ?? marketTurnover,
    sources: {
      index: overviewAccepted ? 'overview' : null,
      volume: overviewVolume !== null ? 'overview' : marketRawVolume !== null ? 'market' : null,
      range: overviewRange ? 'overview' : marketRange ? 'market' : null,
      turnover: overviewTurnover !== null ? 'overview' : marketTurnover !== null ? 'market' : null
    }
  };
}

export function marketOverviewStatus(data = {}) {
  const fieldStates = Object.values(data.fieldStatus || {});
  const indexStatus = data.fieldStatus?.indices;
  const indexAsOf = ['PASS', 'LKG'].includes(indexStatus?.state) ? indexStatus.asOf : null;
  const usesLkg = data.dataState === 'stale' || data.stale
    || fieldStates.some(field => field?.state === 'LKG' || field?.stale);
  const suffix = usesLkg ? ' · ข้อมูลที่บันทึกล่าสุด (LKG)' : '';
  return `แหล่งข้อมูล SETTRADE · อัปเดตล่าสุด: ${stamp(indexAsOf || data.fetchedAt || data.asOf)}${suffix}`;
}

export function quoteChange(last, prior) {
  const current = toFiniteNumber(last);
  const previous = toFiniteNumber(prior);
  if (current === null || previous === null) return { change: null, percent: null };
  const change = current - previous;
  return { change, percent: previous === 0 ? null : change / previous * 100 };
}

export function summarizeBreadth(groups = []) {
  let up = null;
  let down = null;
  for (const item of groups.flatMap(group => group.items || [])) {
    const count = toFiniteNumber(item.count);
    if (count === null) continue;
    if (/gainers/i.test(item.label || '')) up = (up ?? 0) + count;
    if (/losers/i.test(item.label || '')) down = (down ?? 0) + count;
  }
  return { up, down, comparable: up !== null && down !== null };
}

export function pageFromHash(hash = '') {
  const key = String(hash || '').replace(/^#/, '');
  if (['overview', 'chart', 'news', 'watchlist'].includes(key)) return key;
  if (key === 'chart-section') return 'chart';
  if (key === 'news-section') return 'news';
  if (key === 'top') return 'overview';
  return 'overview';
}

function positivePage(value) {
  const page = Number.parseInt(String(value || ''), 10);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 100000) : 1;
}

function validSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase().replace(/\.BK$/, '');
  return /^[A-Z0-9&.-]{1,20}$/.test(symbol) ? symbol : 'PTT';
}

function validWatchlistId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(id) ? id : '';
}

export function parseNavigationState(value, fallback = {}) {
  let url;
  try { url = new URL(String(value || ''), 'https://setscope.local/'); }
  catch (_) { url = new URL('https://setscope.local/#overview'); }
  const route = pageFromHash(url.hash);
  if (route === 'overview') return { route };
  if (route === 'chart') {
    const range = String(url.searchParams.get('range') || fallback.range || '1D').toUpperCase();
    return {
      route,
      symbol: validSymbol(url.searchParams.get('symbol') || fallback.symbol || 'PTT'),
      range: CHART_RANGES.includes(range) ? range : '1D'
    };
  }
  if (route === 'news') {
    const source = String(url.searchParams.get('source') || fallback.source || 'all').toLowerCase();
    return {
      route,
      query: String(url.searchParams.get('s') ?? fallback.query ?? '').trim().slice(0, 80),
      source: NEWS_SOURCES.includes(source) ? source : 'all',
      newsPage: positivePage(url.searchParams.get('newsPage') || fallback.newsPage)
    };
  }
  return {
    route,
    watchlistId: validWatchlistId(url.searchParams.get('watchlist') || fallback.watchlistId),
    watchPage: positivePage(url.searchParams.get('watchPage') || fallback.watchPage)
  };
}

export function navigationUrl(state = {}, pathname = '/') {
  const route = ROUTES.includes(state.route) ? state.route : 'overview';
  const params = new URLSearchParams();
  if (route === 'chart') {
    params.set('symbol', validSymbol(state.symbol));
    const range = String(state.range || '1D').toUpperCase();
    params.set('range', CHART_RANGES.includes(range) ? range : '1D');
  } else if (route === 'news') {
    const query = String(state.query || '').trim().slice(0, 80);
    const source = String(state.source || 'all').toLowerCase();
    const page = positivePage(state.newsPage);
    if (query) params.set('s', query);
    if (NEWS_SOURCES.includes(source) && source !== 'all') params.set('source', source);
    if (page > 1) params.set('newsPage', String(page));
  } else if (route === 'watchlist') {
    const watchlistId = validWatchlistId(state.watchlistId);
    const page = positivePage(state.watchPage);
    if (watchlistId) params.set('watchlist', watchlistId);
    if (page > 1) params.set('watchPage', String(page));
  }
  const base = String(pathname || '/').startsWith('/') ? String(pathname || '/') : '/';
  return `${base}${params.size ? `?${params}` : ''}#${route}`;
}

export function normalizeLists(lists) {
  return lists.slice(0, MAX_WATCHLISTS).map((list, index) => ({
    id: String(list.id || `list-${index + 1}`).slice(0, 40),
    name: String(list.name || `Watchlist ${index + 1}`).trim().slice(0, 40) || `Watchlist ${index + 1}`,
    items: (Array.isArray(list.items) ? list.items : [])
      .filter(item => item && /^[A-Z0-9&.-]{1,20}$/.test(String(item.symbol || '')))
      .slice(0, MAX_WATCHLIST)
  }));
}

export function mergeWatchlists(localLists, cloudLists) {
  if (Array.isArray(cloudLists) && cloudLists.length) return normalizeLists(cloudLists);
  return localLists;
}

export function resolveActiveWatchlistId(lists, { requestedId = '', cloudId = '', localId = '' } = {}) {
  const available = new Set((Array.isArray(lists) ? lists : []).map(list => String(list?.id || '')));
  return [requestedId, cloudId, localId].map(value => String(value || '')).find(value => available.has(value))
    || String(lists?.[0]?.id || 'list-1');
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

export function stamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(+date) ? value : date.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short'
  });
}

export function newsKey(item) {
  return String(item.fingerprint || item.url || `${item.title || ''}|${item.pubDate || ''}`);
}

export function sentimentHeadline(headline) {
  const text = String(headline || '');
  const positive = /(กำไรเพิ่ม|กำไรพุ่ง|โตเด่น|เติบโต|บวก|รับอานิสงส์|ปรับขึ้น|เพิ่มขึ้น|ยอดขายโต|ซื้อคืน|ปันผลเพิ่ม|ผ่านจุดต่ำสุด|ฟื้นตัว|ชนะประมูล|คว้างาน)/i;
  const negative = /(ขาดทุน|กำไรลด|กำไรวูบ|ร่วง|ลดลง|หดตัว|ปิดลบ|ผิดนัด|ถูกฟ้อง|คดี|เพิ่มทุน|ลดเป้า|เลื่อนโครงการ|ผลกระทบ|คว่ำบาตร|ภัยแล้ง|ต้นทุนพุ่ง)/i;
  return positive.test(text) && !negative.test(text) ? 'บวก' : negative.test(text) && !positive.test(text) ? 'ลบ' : 'เป็นกลาง';
}

export function matchesNewsQuery(item, query, analysisSummary = '') {
  if (!query) return true;
  const fields = [item.title, item.sourceName, item.snippet, analysisSummary];
  return fields.some(value => String(value || '').toLocaleLowerCase('th').includes(query));
}

export function pageList(current, total) {
  const keep = new Set([1, 2, total - 1, total, current - 1, current, current + 1].filter(page => page >= 1 && page <= total));
  const sorted = [...keep].sort((left, right) => left - right);
  const pages = [];
  sorted.forEach((page, index) => { if (index && page - sorted[index - 1] > 1) pages.push('…'); pages.push(page); });
  return pages;
}

export function selectNewsForDisplay(items = [], {
  source = 'all',
  query = '',
  now = Date.now(),
  featuredCount = 5,
  sourceTier = {}
} = {}) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('th');
  const filtered = items.filter(item => {
    const sourceMatch = source === 'all' || (source === 'broker' ? Boolean(item.brokerCategory) : item.source === source);
    return sourceMatch && matchesNewsQuery(item, normalizedQuery, item.analysisSummary || '');
  }).sort((left, right) => Date.parse(right.pubDate) - Date.parse(left.pubDate));
  const cutoff = Number(now) - 7 * 24 * 60 * 60 * 1000;
  const featured = filtered.filter(item => Number.isFinite(Date.parse(item.pubDate)) && Date.parse(item.pubDate) >= cutoff)
    .sort((left, right) => (sourceTier[right.source] || 0) - (sourceTier[left.source] || 0) || Date.parse(right.pubDate) - Date.parse(left.pubDate))
    .slice(0, featuredCount);
  const featuredKeys = new Set(featured.map(newsKey));
  return { filtered, featured, latest: filtered.filter(item => !featuredKeys.has(newsKey(item))) };
}

export function computeSmaSeries(values, period) {
  let sum = 0;
  return values.map((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    return index >= period - 1 ? sum / period : null;
  });
}

export function createRequestSequence() {
  let latest = 0;
  return {
    begin() { latest += 1; return latest; },
    isCurrent(requestId) { return requestId === latest; },
    invalidate() { latest += 1; }
  };
}

export function alignIndicatorSeries(sourceRows, values, visibleRows) {
  const byTime = new Map(), byDay = new Map();
  sourceRows.forEach((row, index) => {
    const value = values[index];
    byTime.set(Number(row.time), value);
    const date = new Date(Number(row.time));
    if (!Number.isNaN(+date)) byDay.set(date.toISOString().slice(0, 10), value);
  });
  return visibleRows.map(row => {
    const exact = byTime.get(Number(row.time));
    if (exact !== undefined) return exact;
    const date = new Date(Number(row.time));
    return Number.isNaN(+date) ? null : (byDay.get(date.toISOString().slice(0, 10)) ?? null);
  });
}

export function computeEma(values, period) {
  const numbers = (values || []).map(Number).filter(Number.isFinite);
  if (!numbers.length) return [];
  const result = Array(numbers.length).fill(null);
  if (numbers.length < period) return result;
  let ema = numbers.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = ema;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < numbers.length; index++) {
    ema = numbers[index] * multiplier + ema * (1 - multiplier);
    result[index] = ema;
  }
  return result;
}

export function emaAtPeriod(values, period) {
  return computeEma(values, period).at(-1) ?? null;
}

export function findPriceLevels(bars, last) {
  if (!Number.isFinite(Number(last)) || Number(last) <= 0) return { supports: [], resistances: [], supportDetails: [], resistanceDetails: [] };
  const recent = (bars || []).filter(bar => [bar.low, bar.high, bar.close].every(value => Number.isFinite(Number(value)) && Number(value) > 0)).slice(-260);
  const supports = [], resistances = [];
  for (let index = 2; index < recent.length - 2; index++) {
    const low = Number(recent[index].low), high = Number(recent[index].high);
    const neighbors = [recent[index - 2], recent[index - 1], recent[index + 1], recent[index + 2]];
    if (Number.isFinite(low) && low < last && neighbors.every(bar => low <= Number(bar.low))) supports.push(low);
    if (Number.isFinite(high) && high > last && neighbors.every(bar => high >= Number(bar.high))) resistances.push(high);
  }
  const gap = Math.max(last * 0.005, 0.01);
  const nearest = (levels, ascending, source) => {
    const selected = [];
    for (const level of [...new Set(levels)].sort((left, right) => ascending ? left - right : right - left)) {
      if (selected.every(item => Math.abs(item.value - level) >= gap)) selected.push({ value: level, source });
      if (selected.length === 3) break;
    }
    return selected;
  };
  const supportDetails = nearest(supports, false, 'Swing low');
  const resistanceDetails = nearest(resistances, true, 'Swing high');
  const pivotBar = recent.at(-1);
  if (pivotBar && (supportDetails.length < 3 || resistanceDetails.length < 3)) {
    const high = Number(pivotBar.high), low = Number(pivotBar.low), close = Number(pivotBar.close);
    const pivot = (high + low + close) / 3;
    const pivotSupports = [2 * pivot - high, pivot - (high - low), low - 2 * (high - pivot)].filter(level => level > 0 && level < last);
    const pivotResistances = [2 * pivot - low, pivot + (high - low), high + 2 * (pivot - low)].filter(level => level > last);
    for (const candidate of nearest(pivotSupports, false, 'Classic Pivot')) {
      if (supportDetails.every(item => Math.abs(item.value - candidate.value) >= gap)) supportDetails.push(candidate);
      if (supportDetails.length === 3) break;
    }
    for (const candidate of nearest(pivotResistances, true, 'Classic Pivot')) {
      if (resistanceDetails.every(item => Math.abs(item.value - candidate.value) >= gap)) resistanceDetails.push(candidate);
      if (resistanceDetails.length === 3) break;
    }
  }
  supportDetails.sort((left, right) => right.value - left.value).splice(3);
  resistanceDetails.sort((left, right) => left.value - right.value).splice(3);
  supportDetails.forEach((item, index) => Object.assign(item, { type: 'support', rank: index + 1 }));
  resistanceDetails.forEach((item, index) => Object.assign(item, { type: 'resistance', rank: index + 1 }));
  return {
    supports: supportDetails.map(item => item.value),
    resistances: resistanceDetails.map(item => item.value),
    supportDetails,
    resistanceDetails
  };
}

export function trustedMarketBars(bars = []) {
  const byTime = new Map();
  const withoutTime = [];
  for (const bar of bars || []) {
    if (!bar || (bar.guardStatus && bar.guardStatus !== 'accepted')) continue;
    const close = toFiniteNumber(bar.close);
    if (close === null || close <= 0) continue;
    const suppliedOhlc = [bar.open, bar.high, bar.low].some(value => value !== null && value !== undefined && value !== '');
    if (suppliedOhlc) {
      const open = toFiniteNumber(bar.open), high = toFiniteNumber(bar.high), low = toFiniteNumber(bar.low);
      const volume = toFiniteNumber(bar.volume);
      if ([open, high, low].some(value => value === null || value <= 0)) continue;
      if (high < low || open < low || open > high || close < low || close > high) continue;
      if (bar.volume !== null && bar.volume !== undefined && bar.volume !== '' && (volume === null || volume < 0)) continue;
    }
    const time = toFiniteNumber(bar.time);
    const normalized = { ...bar, close };
    if (time === null || time <= 0) withoutTime.push(normalized);
    else if (!byTime.has(time)) byTime.set(time, { ...normalized, time });
  }
  if (!byTime.size) return withoutTime;
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function analyseTechnicals(bars, levelBars = bars) {
  const usable = trustedMarketBars(bars);
  const usableLevels = trustedMarketBars(levelBars || usable);
  const values = usable.map(bar => Number(bar.close));
  if (values.length < 30) return null;
  const period = 14;
  let avgGain = 0, avgLoss = 0;
  for (let index = 1; index <= period; index++) {
    const change = values[index] - values[index - 1];
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period; avgLoss /= period;
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  const rsi = avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const sma20 = values.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const emas = { ema20: emaAtPeriod(values, 20), ema50: emaAtPeriod(values, 50), ema100: emaAtPeriod(values, 100), ema200: emaAtPeriod(values, 200) };
  const fast = computeEma(values, 12), slow = computeEma(values, 26);
  const macd = values.map((_, index) => Number.isFinite(fast[index]) && Number.isFinite(slow[index]) ? fast[index] - slow[index] : null);
  const macdIndexes = macd.map((value, index) => Number.isFinite(value) ? index : -1).filter(index => index >= 0);
  const signalValues = computeEma(macdIndexes.map(index => macd[index]), 9);
  const signalLine = Array(values.length).fill(null);
  macdIndexes.forEach((sourceIndex, index) => { signalLine[sourceIndex] = signalValues[index]; });
  const histogram = macd.map((value, index) => Number.isFinite(value) && Number.isFinite(signalLine[index]) ? value - signalLine[index] : null);
  const last = values.at(-1);
  const macdLast = macd.at(-1), macdSignalLast = signalLine.at(-1);
  const macdDiff = Number.isFinite(macdLast) && Number.isFinite(macdSignalLast) ? macdLast - macdSignalLast : null;
  const signals = {
    rsi: rsi < 30 ? 'ซื้อ' : rsi > 70 ? 'ขาย' : 'เป็นกลาง',
    sma: last >= sma20 ? 'ซื้อ' : 'ขาย'
  };
  if (macdDiff !== null) signals.macd = macdDiff > 0 ? 'ซื้อ' : macdDiff < 0 ? 'ขาย' : 'เป็นกลาง';
  Object.entries(emas).forEach(([key, value]) => { if (value !== null) signals[key] = last > value ? 'ซื้อ' : last < value ? 'ขาย' : 'เป็นกลาง'; });
  const reasons = [
    { key: 'RSI (14)', signal: signals.rsi, value: `RSI ${rsi.toFixed(1)}`, detail: rsi < 30 ? 'ต่ำกว่า 30: แรงขายมาก อาจเกิดแรงรีบาวด์ แต่ยังไม่ยืนยันว่าราคากลับตัว' : rsi > 70 ? 'สูงกว่า 70: ภาวะซื้อมาก ราคาอาจย่อตัวได้ แต่ในขาขึ้น RSI อาจสูงต่อเนื่อง' : 'อยู่ระหว่าง 30–70: ยังไม่เข้าขอบเขตซื้อมาก/ขายมากตามเกณฑ์ทั่วไป' },
    { key: 'SMA (20)', signal: signals.sma, value: `ราคา ${formatNumber(last)} · SMA ${formatNumber(sma20)}`, detail: last >= sma20 ? 'ราคาปิดอยู่เหนือค่าเฉลี่ย 20 แท่ง เป็นหลักฐานสนับสนุนแนวโน้มระยะสั้น' : 'ราคาปิดต่ำกว่าค่าเฉลี่ย 20 แท่ง แสดงว่าแนวโน้มระยะสั้นยังอ่อน' },
    { key: 'EMA (20)', signal: signals.ema20, value: `ราคา ${formatNumber(last)} · EMA ${formatNumber(emas.ema20)}`, detail: `ราคา${last >= emas.ema20 ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย 20 แท่ง ใช้ดูโมเมนตัมระยะสั้น` }
  ];
  if (signals.macd) reasons.splice(1, 0, { key: 'MACD (12, 26, 9)', signal: signals.macd, value: `MACD ${macdLast.toFixed(3)} · Signal ${macdSignalLast.toFixed(3)}`, detail: macdDiff > 0 ? 'เส้น MACD อยู่เหนือเส้น Signal โมเมนตัมระยะสั้นเป็นบวก' : macdDiff < 0 ? 'เส้น MACD อยู่ใต้เส้น Signal โมเมนตัมระยะสั้นเป็นลบ' : 'เส้น MACD และ Signal อยู่ระดับเดียวกัน โมเมนตัมยังไม่ชี้ทิศทาง' });
  for (const [key, emaPeriod, horizon] of [['ema50', 50, 'ระยะสั้นถึงกลาง'], ['ema100', 100, 'ระยะกลาง'], ['ema200', 200, 'ระยะยาว']]) {
    if (emas[key] === null) continue;
    reasons.push({ key: `EMA (${emaPeriod})`, signal: signals[key], value: `ราคา ${formatNumber(last)} · EMA ${formatNumber(emas[key])}`, detail: `ราคา${last >= emas[key] ? 'อยู่เหนือ' : 'อยู่ใต้'}ค่าเฉลี่ย ${emaPeriod} แท่ง เป็นหลักฐานแนวโน้ม${horizon}` });
  }
  const buy = Object.values(signals).filter(value => value === 'ซื้อ').length;
  const sell = Object.values(signals).filter(value => value === 'ขาย').length;
  const overall = buy > sell + 1 ? 'ซื้อ' : sell > buy + 1 ? 'ขาย' : 'เป็นกลาง';
  const levels = findPriceLevels(usableLevels, last);
  return { values, rsi, sma20, emas, macd: macdLast, macdSignal: macdSignalLast, macdSeries: macd, signalSeries: signalLine, macdHistogram: histogram, last, signals, reasons, buy, sell, overall, levels, available: Object.keys(signals).length, total: 7 };
}
