'use strict';

const { normalizeSymbol } = require('../lib/validation');
// Published SET-group calendar, including the announced special closure.
// No runtime calendar fetch or inference for an unreviewed year.
const CALENDAR = Object.freeze({ year: 2026, reviewed: '2026-10-26',
  source: 'https://www.tfex.co.th/en/about/holiday',
  amendment: 'https://www.sec.or.th/EN/Pages/News_Detail.aspx?SECID=12943',
  holidays: ['01-01','01-02','03-03','04-06','04-13','04-14','04-15','05-01','05-04','06-01','06-03',
    '07-28','07-29','08-12','10-13','10-16','10-23','12-07','12-10','12-31'] });

function bangkokDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function validDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
    && Number.isFinite(Date.parse(day + 'T00:00:00Z')) && new Date(day + 'T00:00:00Z').toISOString().slice(0,10) === day;
}
function tradingDay(day, calendar = CALENDAR) {
  if (!validDay(day) || Number(day.slice(0,4)) !== calendar.year) return null;
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
  return weekday !== 0 && weekday !== 6 && !calendar.holidays.includes(day.slice(5));
}
function latestSession(now, calendar = CALENDAR) {
  const today = bangkokDay(now), minutes = new Date(Number(now) + 7 * 3600000).getUTCHours() * 60 + new Date(Number(now) + 7 * 3600000).getUTCMinutes();
  let day = today;
  if (minutes < 17 * 60 + 15) day = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0,10);
  for (let i = 0; i < 10; i++) {
    const eligible = tradingDay(day, calendar);
    if (eligible === null) return null;
    if (eligible) return day;
    day = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0,10);
  }
  return null;
}
function executionWindow({ now, mode = 'coverage', session, recover = false, calendar = CALENDAR }) {
  const today = bangkokDay(now);
  if (!['coverage','eod'].includes(mode)) throw Error('INVALID_MODE');
  if (tradingDay(today, calendar) === null) return { eligible: false, reason: 'CALENDAR_UNAVAILABLE' };
  if (!recover && !tradingDay(today, calendar)) return { eligible: false, reason: 'NON_TRADING_DAY' };
  if (mode === 'coverage' && !recover) return { eligible: true, session: today };
  const latest = latestSession(now, calendar);
  if (!latest) return { eligible: false, reason: 'CALENDAR_UNAVAILABLE' };
  if (recover) {
    if (session !== latest || Date.parse(today) - Date.parse(session) > 4 * 86400000) return { eligible: false, reason: 'MISSED_JOB_OBSOLETE' };
  } else if (latest !== today) return { eligible: false, reason: 'PROVIDER_NOT_READY' };
  return { eligible: true, session: latest };
}
function selectCoverage(rows, { limit = 5, now = Date.now(), mode = 'coverage', session = bangkokDay(now), excludeSymbols = [] } = {}) {
  if (!Array.isArray(rows) || rows.length > 1000 || limit !== 5
    || new Set(rows.map(row => row.symbol)).size !== rows.length) throw Error('INVALID_SELECTION');
  const ranked = [];
  for (const row of rows) {
    if (row?.active !== true || ['inactive','unsupported'].includes(row.status)) continue;
    if (excludeSymbols.includes(row.symbol)) continue;
    if (!row || normalizeSymbol(row.symbol) !== row.symbol || !/^[A-Z0-9&.-]{1,32}\.BK$/.test(row.provider_symbol)
      || row.provider !== 'Yahoo Finance') throw Error('AMBIGUOUS_SELECTION_IDENTITY');
    const checked = Date.parse(row.last_checked_at || '');
    if (Number.isFinite(checked) && checked > Number(now)) throw Error('FUTURE_COVERAGE_CHECK');
    const stale = !Number.isFinite(checked) || Number(now) - checked > 36 * 3600000 || row.guard_status === 'stale';
    // EOD must recheck a prior-session quote even when its 36-hour registry TTL is healthy.
    const sessionDue = mode === 'eod';
    if (!stale && !sessionDue && row.status === 'verified' && row.symbol_verified && row.chart_ready) continue;
    if (Number.isFinite(checked) && ['partial','temporary_failed'].includes(row.status)
      && Number(now) - checked < (row.guard_reason === 'EOD_SESSION_NOT_READY' ? 15 * 60000 : 6 * 3600000)) continue;
    const priority = row.status === 'pending' ? 0 : !row.symbol_verified ? 1 : stale || sessionDue ? 2 : row.status === 'partial' ? 3 : 4;
    ranked.push({ row, priority, checked: Number.isFinite(checked) ? checked : 0 });
  }
  return ranked.sort((a,b) => a.priority - b.priority || a.checked - b.checked || a.row.symbol.localeCompare(b.row.symbol))
    .slice(0,limit).map(item => item.row);
}
function sessionReady(verification, session) {
  return verification.quoteReady === true && verification.chartReady === true
    && ['accepted','delayed'].includes(verification.guardStatus)
    && Number.isFinite(Date.parse(verification.asOf || '')) && bangkokDay(Date.parse(verification.asOf)) === session
    && Number.isFinite(Date.parse(verification.historyAsOf || '')) && bangkokDay(Date.parse(verification.historyAsOf)) === session;
}
module.exports = { CALENDAR, bangkokDay, validDay, tradingDay, latestSession, executionWindow, selectCoverage, sessionReady };
