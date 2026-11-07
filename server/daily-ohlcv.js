'use strict';

const { createHash } = require('node:crypto');
const { normalizeHistory } = require('./data-guard');
const { tradingDay } = require('./automation-policy');
const { temporalBars } = require('../lib/market-time');

const DAILY_SCHEMA_VERSION = 'setscope-daily-1';
const DAY = 86400000;
const RETENTION_DAYS = 365;
function retentionFloor(asOf) { return new Date(Date.parse(dayInThailand(asOf) + 'T00:00:00Z') - (RETENTION_DAYS - 1) * DAY).toISOString().slice(0, 10); }
const availabilityCache = new Map();
const sessionCache = new Map();
function sessionDay(date) {
  if (!sessionCache.has(date)) {
    sessionCache.set(date, tradingDay(date));
    if (sessionCache.size > 4096) sessionCache.delete(sessionCache.keys().next().value);
  }
  return sessionCache.get(date);
}
const dayInThailand = time => new Date(time + 7 * 3600000).toISOString().slice(0, 10);
const fingerprint = text => createHash('sha256').update(text).digest('hex');

function fail() { throw Error('DAILY_OHLCV_CONTRACT'); }

function guardedDailyEvidence(meta, result) {
  if (meta?.dataGranularity !== '1d' || meta.exchangeTimezoneName !== 'Asia/Bangkok'
    || !result || !Array.isArray(result.history) || !result.provenance
    || result.fallbackFromLastKnown || result.identityStatus !== 'accepted'
    || result.history.length > 300 || !Number.isFinite(Date.parse(result.provenance.receivedAt))) return null;
  return {
    provider: result.provenance.provider, providerSymbol: meta.symbol, interval: result.provenance.interval,
    identityStatus: result.identityStatus, guardStatus: result.guardStatus, historyStatus: result.historyStatus,
    dataState: result.dataState,
    guardReasons: result.rejectedBars ? [...result.guardReasons, 'REJECTED_DAILY_BARS'] : result.guardReasons,
    sourceFetchedAt: result.provenance.receivedAt, bars: result.history
  };
}

function expectedAvailability(record) {
  const proof = record.confirmationProof;
  if (!proof || Object.keys(proof).sort().join(',') !== 'nextObservedAt,regularEnd,regularStart'
    || Object.values(proof).some(value => value !== null && (!Number.isSafeInteger(value) || value <= 0))
    || proof.nextObservedAt !== null && (proof.nextObservedAt <= record.time || proof.nextObservedAt > record.sourceFetchedAt))
    fail();
  const key = JSON.stringify([record.time, proof]);
  let result = availabilityCache.get(key);
  if (!result) {
    // The second timestamp is retained source observation evidence, not a price bar.
    const times = [{ time: record.time }];
    if (proof.nextObservedAt !== null) times.push({ time: proof.nextObservedAt });
    const bar = temporalBars(times, { interval: '1d', timeZone: 'Asia/Bangkok',
      observedAt: record.sourceFetchedAt, regularStart: proof.regularStart, regularEnd: proof.regularEnd })[0];
    result = { availableAt: bar.availableAt, basis: bar.confirmationBasis };
    availabilityCache.set(key, result);
    if (availabilityCache.size > 4096) availabilityCache.delete(availabilityCache.keys().next().value);
  }
  return result;
}

function validateDailyRecord(record, asOf = Date.now()) {
  const fields = ['schemaVersion', 'symbol', 'providerSymbol', 'provider', 'interval', 'timeZone', 'tradingDate',
    'sessionStatus', 'time', 'open', 'high', 'low', 'close', 'volume', 'sourceFetchedAt', 'availableAt', 'complete',
    'guardStatus', 'confirmationBasis', 'confirmationProof', 'sourceMetadata'];
  if (!record || Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))
    || record.schemaVersion !== DAILY_SCHEMA_VERSION || !/^[A-Z0-9&.-]{1,20}$/.test(record.symbol)
    || record.providerSymbol !== record.symbol + '.BK' || record.provider !== 'Yahoo Finance'
    || record.interval !== '1d' || record.timeZone !== 'Asia/Bangkok'
    || !['accepted', 'delayed'].includes(record.guardStatus)
    || !Number.isSafeInteger(record.time) || record.time <= 0
    || !Number.isSafeInteger(record.sourceFetchedAt) || record.sourceFetchedAt < record.time || record.sourceFetchedAt > asOf
    || record.tradingDate !== dayInThailand(record.time) || sessionDay(record.tradingDate) === false
    || record.sessionStatus !== (sessionDay(record.tradingDate) === true ? 'SESSION_VERIFIED' : 'SESSION_UNVERIFIED')
    || [0, 6].includes(new Date(record.tradingDate + 'T00:00:00Z').getUTCDay())
    || !['open', 'high', 'low', 'close', 'volume'].every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
    || typeof record.complete !== 'boolean') fail();
  const meta = record.sourceMetadata;
  if (!meta || Object.keys(meta).sort().join(',') !== 'currency,exchange,symbol'
    || meta.symbol !== record.providerSymbol || meta.currency !== null && meta.currency !== 'THB'
    || meta.exchange !== null && (typeof meta.exchange !== 'string' || !/(SET|Thailand|BKK)/i.test(meta.exchange))) fail();
  const expected = expectedAvailability(record);
  if (record.availableAt !== expected.availableAt || record.confirmationBasis !== expected.basis
    || record.complete !== (expected.availableAt !== null && expected.availableAt <= record.sourceFetchedAt)) fail();
  const checked = normalizeHistory({
    timestamp: [record.time / 1000],
    indicators: { quote: [Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, [record[key]]]))] }
  }, { now: record.sourceFetchedAt, futureToleranceMs: 0, requireVolume: true });
  if (checked.history.length !== 1 || checked.rejectedBars) fail();
  return record;
}

function chartHistoryToRecords(symbol, meta, result) {
  const evidence = guardedDailyEvidence(meta, result);
  if (!evidence || evidence.provider !== 'Yahoo Finance' || evidence.providerSymbol !== symbol + '.BK'
    || !['accepted', 'delayed'].includes(evidence.guardStatus) || evidence.guardReasons.length
    || !['usable', 'usable_with_warnings'].includes(evidence.historyStatus)
    || !['fresh', 'delayed', 'partial'].includes(evidence.dataState)) fail();
  const sourceFetchedAt = Date.parse(evidence.sourceFetchedAt);
  const start = Number(meta.currentTradingPeriod?.regular?.start) * 1000 || null;
  const end = Number(meta.currentTradingPeriod?.regular?.end) * 1000 || null;
  const bars = temporalBars(evidence.bars, { interval: '1d', observedAt: sourceFetchedAt,
    regularStart: start, regularEnd: end, timeZone: 'Asia/Bangkok' });
  return bars.map((bar, index) => {
    if (index && bar.time <= bars[index - 1].time || evidence.bars[index].complete !== bar.complete
      || evidence.bars[index].availableAt !== bar.availableAt) fail();
    return validateDailyRecord({
      schemaVersion: DAILY_SCHEMA_VERSION, symbol, providerSymbol: meta.symbol, provider: evidence.provider,
      interval: '1d', timeZone: 'Asia/Bangkok', tradingDate: dayInThailand(bar.time),
      sessionStatus: sessionDay(dayInThailand(bar.time)) === true ? 'SESSION_VERIFIED' : 'SESSION_UNVERIFIED',
      time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
      sourceFetchedAt, availableAt: bar.availableAt, complete: bar.complete, guardStatus: evidence.guardStatus,
      confirmationBasis: bar.confirmationBasis,
      confirmationProof: { regularStart: start, regularEnd: end, nextObservedAt: bars[index + 1]?.time ?? null },
      sourceMetadata: { symbol: meta.symbol, currency: meta.currency || null, exchange: meta.fullExchangeName || meta.exchangeName || null }
    }, sourceFetchedAt);
  });
}

function encodeDailyRecords(records, asOf = Date.now()) {
  if (!Array.isArray(records) || records.length > 6000) fail();
  const entries = new Map();
  for (const input of records) {
    const record = validateDailyRecord(input, asOf);
    const key = record.providerSymbol + '|' + record.tradingDate;
    const text = JSON.stringify(record);
    const prior = entries.get(key);
    if (prior && prior.text !== text) fail();
    entries.set(key, { key, text, sha256: fingerprint(text), record: Object.freeze({ ...record }) });
  }
  if (new Set([...entries.values()].map(item => item.record.symbol)).size > 20) fail();
  return [...entries.values()];
}

function historyEvidence(records, symbol, asOf) {
  if (!records.length) return null;
  if (records.length > 300) fail();
  let lastTime = 0;
  for (const record of records) {
    validateDailyRecord(record, asOf);
    if (record.symbol !== symbol || record.time <= lastTime) fail();
    lastTime = record.time;
  }
  const normalized = normalizeHistory({
    timestamp: records.map(record => record.time / 1000),
    indicators: { quote: [Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(key => [key, records.map(record => record[key])]))] }
  }, { now: asOf, futureToleranceMs: 0, requireVolume: true });
  if (normalized.history.length !== records.length || normalized.rejectedBars || normalized.reasons.length) fail();
  return {
    provider: 'Yahoo Finance', providerSymbol: symbol + '.BK', interval: '1d', identityStatus: 'accepted',
    guardStatus: 'accepted', historyStatus: 'usable', dataState: 'delayed', guardReasons: [],
    sourceFetchedAt: new Date(Math.max(...records.map(record => record.sourceFetchedAt))).toISOString(),
    bars: records.map(record => ({ time: record.time, open: record.open, high: record.high, low: record.low,
      close: record.close, volume: record.volume, complete: record.complete, availableAt: record.availableAt }))
  };
}

module.exports = { DAILY_SCHEMA_VERSION, RETENTION_DAYS, retentionFloor, guardedDailyEvidence, chartHistoryToRecords,
  validateDailyRecord, encodeDailyRecords, historyEvidence, fingerprint };
