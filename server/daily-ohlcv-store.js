'use strict';

const { encodeDailyRecords, validateDailyRecord, fingerprint, retentionFloor } = require('./daily-ohlcv');

function readerSymbols(symbols) {
  if (!Array.isArray(symbols) || symbols.length > 20 || new Set(symbols).size !== symbols.length
    || symbols.some(symbol => typeof symbol !== 'string' || !/^[A-Z0-9&.-]{1,20}$/.test(symbol)))
    throw Error('DAILY_HISTORY_READ_BOUNDS');
}

function decodeRows(rows, symbols, asOf) {
  const result = new Map(symbols.map(symbol => [symbol, []]));
  const guardBlocked = new Set();
  for (const row of rows) {
    if (!result.has(row.symbol)) throw Error('DAILY_HISTORY_IDENTITY');
    try {
      if (fingerprint(row.record_text) !== row.content_sha256) throw Error('DAILY_HISTORY_CORRUPT');
      const record = validateDailyRecord(JSON.parse(row.record_text), asOf);
      if (record.symbol !== row.symbol) throw Error('DAILY_HISTORY_IDENTITY');
      result.get(record.symbol).push(record);
    } catch (_) { guardBlocked.add(row.symbol); }
  }
  for (const [symbol, records] of result) {
    records.sort((a, b) => a.time - b.time);
    if (records.length > 300 || new Set(records.map(record => record.tradingDate)).size !== records.length) guardBlocked.add(symbol);
    if (guardBlocked.has(symbol)) result.set(symbol, []);
  }
  return { histories: result, guardBlocked };
}

function createMemoryDailyHistoryStore({ now = Date.now } = {}) {
  const entries = new Map();
  let revision = 0;
  let pending = Promise.resolve();
  function exclusive(action) {
    const task = pending.then(action);
    pending = task.catch(() => {});
    return task;
  }
  function cleanupRows() {
    const floor = retentionFloor(now());
    let removed = 0;
    for (const bucket of entries.values()) for (const [day, entry] of bucket) {
      if (day < floor) { bucket.delete(day); removed++; }
    }
    if (removed) revision++;
    return removed;
  }
  async function readMany(symbols, { asOf = now() } = {}) {
    readerSymbols(symbols);
    const rows = [];
    for (const symbol of symbols) {
      const selected = [...(entries.get(symbol)?.values() || [])].filter(entry => entry.record.sourceFetchedAt <= asOf
        && entry.record.tradingDate >= retentionFloor(asOf)).sort((a, b) => b.record.time - a.record.time).slice(0, 300);
      rows.push(...selected.map(entry => ({ symbol, record_text: entry.text, content_sha256: entry.sha256 })));
    }
    return decodeRows(rows, symbols, asOf);
  }
  async function upsert(records) {
    const encoded = encodeDailyRecords(records, now());
    return exclusive(() => {
      const floor = retentionFloor(now());
      const kept = encoded.filter(entry => entry.record.tradingDate >= floor);
      for (const entry of kept) {
        const prior = entries.get(entry.record.symbol)?.get(entry.record.tradingDate);
        if (prior && prior.record.sourceFetchedAt === entry.record.sourceFetchedAt && prior.text !== entry.text)
          throw Error('DAILY_HISTORY_VERSION_CONFLICT');
      }
      let changed = 0;
      for (const entry of kept) {
        const prior = entries.get(entry.record.symbol)?.get(entry.record.tradingDate);
        if (!prior || prior.record.sourceFetchedAt < entry.record.sourceFetchedAt) {
          if (!entries.has(entry.record.symbol)) entries.set(entry.record.symbol, new Map());
          entries.get(entry.record.symbol).set(entry.record.tradingDate, {
            text: entry.text, sha256: entry.sha256, record: {
              symbol: entry.record.symbol, tradingDate: entry.record.tradingDate,
              time: entry.record.time, sourceFetchedAt: entry.record.sourceFetchedAt
            }
          });
          changed++;
        }
      }
      if (changed) revision++;
      const removed = kept.length ? cleanupRows() : 0;
      return { changed, removed, expired: encoded.length - kept.length };
    });
  }
  return { upsert, readMany, revision: async () => String(revision),
    cleanup: () => exclusive(cleanupRows), withReadLease: action => exclusive(() => action({ readMany })) };
}

function createPostgresDailyHistoryStore({ db, now = Date.now }) {
  if (!db?.query || !db?.connect) throw Error('EXPLICIT_DAILY_DATABASE_REQUIRED');
  async function readWith(connection, symbols, { asOf = now() } = {}) {
    readerSymbols(symbols);
    const result = await connection.query(
      'select s.symbol,h.record_text,h.content_sha256 from unnest($1::text[]) s(symbol) cross join lateral ' +
      '(select record_text,content_sha256 from screener_private.stock_ohlcv_daily ' +
      "where symbol=s.symbol and source_fetched_ms <= $2::bigint and trading_date >= $3::text order by trading_date desc limit 300) h",
      [symbols, asOf, retentionFloor(asOf)]);
    return decodeRows(result.rows, symbols, asOf);
  }
  async function withReadLease(action) {
    const client = await db.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      await client.query("select pg_advisory_xact_lock_shared(hashtextextended('setscope-daily-retention',0))");
      const value = await action({ readMany: (symbols, options) => readWith(client, symbols, options) });
      await client.query('commit');
      return value;
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  return {
    readMany: (symbols, options) => readWith(db, symbols, options),
    withReadLease,
    async revision() {
      return String((await db.query('select history_revision from screener_private.state where singleton')).rows[0].history_revision);
    },
    async upsert(records) {
      const entries = encodeDailyRecords(records, now());
      return (await db.query('select screener_private.ingest_daily($1::jsonb) result',
        [JSON.stringify(entries.map(entry => entry.text))])).rows[0].result;
    },
    async cleanup() {
      return Number((await db.query('select screener_private.cleanup_daily() removed')).rows[0].removed);
    }
  };
}

module.exports = { createMemoryDailyHistoryStore, createPostgresDailyHistoryStore };
