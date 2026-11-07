'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFileCheckpoint } = require('./coverage-checkpoint');
const { latestSession, tradingDay } = require('./automation-policy');

const VERSION = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const READY_COUNTS = ['registered', 'eligible', 'ready', 'unavailable', 'staleSession', 'guardBlocked', 'coverageIneligible'];
const AVAILABLE = ['price', 'changePercent', 'ema20', 'ema50', 'rsi14', 'macd'];

const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const finite = Number.isFinite;
const optionalNumber = value => value === null || finite(value);
const positive = value => finite(value) && value > 0;
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && finite(Date.parse(value)) && new Date(value).toISOString() === value;
const dateInThailand = time => new Date(time + 7 * 3600000).toISOString().slice(0, 10);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function completeForEligible(snapshot) {
  const c = snapshot?.counts;
  return c && c.eligible > 0 && c.ready === c.eligible && c.eligible + c.coverageIneligible === c.registered
    && c.unavailable === 0 && c.guardBlocked === 0 && c.staleSession === 0;
}

function validateSnapshot(snapshot) {
  if (!fields(snapshot, ['schemaVersion', 'id', 'sessionDate', 'latestCompletedSessionDate', 'generatedAt', 'state', 'counts', 'rows'])
    || snapshot.schemaVersion !== 'setscope-screener-1' || snapshot.state !== 'COMPLETE'
    || !iso(snapshot.generatedAt) || tradingDay(snapshot.sessionDate) !== true
    || snapshot.latestCompletedSessionDate !== snapshot.sessionDate
    || latestSession(Date.parse(snapshot.generatedAt)) !== snapshot.sessionDate
    || !new RegExp('^setscope-screener-1:' + snapshot.sessionDate + ':[a-f0-9]{8}$').test(snapshot.id)
    || !fields(snapshot.counts, READY_COUNTS) || !READY_COUNTS.every(k => Number.isSafeInteger(snapshot.counts[k]) && snapshot.counts[k] >= 0)
    || !completeForEligible(snapshot) || !Array.isArray(snapshot.rows) || snapshot.rows.length > 1000
    || snapshot.rows.length !== snapshot.counts.registered) throw Error('INVALID_SCREENER_SNAPSHOT');

  let previous = '', ready = 0;
  const cutoff = Date.parse(snapshot.generatedAt);
  for (const row of snapshot.rows) {
    if (!fields(row, ['symbol', 'eligible', 'state', 'exclusionReasons', 'price', 'technical', 'available', 'confirmedBars', 'sourceAsOf', 'candleTime'])
      || typeof row.symbol !== 'string' || !/^[A-Z0-9&.-]{1,20}$/.test(row.symbol) || row.symbol <= previous
      || !fields(row.price, ['close', 'previousClose', 'changePercent']) || !fields(row.technical, ['ema20', 'ema50', 'rsi14', 'macd', 'macdSignal'])
      || !fields(row.available, AVAILABLE) || !Array.isArray(row.exclusionReasons)) throw Error('INVALID_SCREENER_ROW');
    previous = row.symbol;
    if (row.state === 'COVERAGE_INELIGIBLE' && row.eligible === false) {
      if (row.exclusionReasons.length !== 1 || row.exclusionReasons[0] !== 'COVERAGE_INELIGIBLE'
        || [...Object.values(row.price), ...Object.values(row.technical), row.sourceAsOf, row.candleTime].some(value => value !== null)
        || row.confirmedBars !== 0 || AVAILABLE.some(k => row.available[k] !== false)) throw Error('INVALID_SCREENER_EXCLUSION');
      continue;
    }
    if (row.state !== 'READY' || row.eligible !== true || row.exclusionReasons.length
      || !positive(row.price.close) || (row.price.previousClose !== null && !positive(row.price.previousClose))
      || !optionalNumber(row.price.changePercent) || !Object.values(row.technical).every(optionalNumber)
      || ['ema20', 'ema50'].some(key => row.technical[key] !== null && row.technical[key] <= 0)
      || row.technical.rsi14 !== null && (row.technical.rsi14 < 0 || row.technical.rsi14 > 100)
      || !Number.isSafeInteger(row.confirmedBars) || row.confirmedBars < 1 || row.confirmedBars > 300
      || !iso(row.sourceAsOf) || !iso(row.candleTime) || Date.parse(row.sourceAsOf) > cutoff
      || Date.parse(row.candleTime) >= Date.parse(row.sourceAsOf)
      || dateInThailand(Date.parse(row.candleTime)) !== snapshot.sessionDate
      || row.available.price !== true || row.available.changePercent !== finite(row.price.changePercent)
      || ['ema20', 'ema50', 'rsi14'].some(k => row.available[k] !== finite(row.technical[k]))
      || row.available.macd !== (finite(row.technical.macd) && finite(row.technical.macdSignal))) throw Error('INVALID_SCREENER_READY_ROW');
    ready++;
  }
  if (ready !== snapshot.counts.ready) throw Error('INVALID_SCREENER_COUNTS');
  return snapshot;
}

function createScreenerSnapshotStore(directory) {
  if (!path.isAbsolute(directory)) throw Error('SCREENER_SNAPSHOT_DIRECTORY_MUST_BE_ABSOLUTE');
  const checkpoint = createFileCheckpoint(directory);
  async function withLease(action) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    return checkpoint.withLease('screener-snapshot-writer-v1', action);
  }

  async function read(name) {
    let handle;
    try {
      handle = await fs.open(path.join(directory, name + '.json'), 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return { corrupt: true };
      const buffer = Buffer.alloc(stat.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > stat.size) return { corrupt: true };
      const value = JSON.parse(buffer.subarray(0, used).toString('utf8'));
      if (!fields(value, ['version', 'digest', 'payload']) || value.digest !== digest(value.payload))
        return { corrupt: true };
      if (value.version === 1)
        return { value: name === 'cooldown' ? value.payload : validateSnapshot(value.payload) };
      if (value.version !== VERSION || name !== 'published' || !fields(value.payload, ['current', 'previous']))
        return { corrupt: true };
      return { value: validateSnapshot(value.payload.current),
        previous: value.payload.previous === null ? null : validateSnapshot(value.payload.previous) };
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      if (!error.code) return { corrupt: true };
      throw error;
    } finally { await handle?.close(); }
  }

  async function stage(name, payload, version) {
    const data = JSON.stringify({ version, digest: digest(payload), payload });
    if (Buffer.byteLength(data) > MAX_BYTES) throw Error('SCREENER_SNAPSHOT_TOO_LARGE');
    const staged = path.join(directory, name + '.stage');
    const handle = await fs.open(staged, 'w', 0o600);
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    return staged;
  }

  async function commit(name, staged) {
    await fs.rename(staged, path.join(directory, name + '.json'));
    if (process.platform !== 'win32') {
      const dir = await fs.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  }

  async function write(name, payload) {
    await commit(name, await stage(name, payload, 1));
  }

  async function revision() {
    const versions = await Promise.all(['published', 'previous'].map(async name => {
      try {
        const stat = await fs.stat(path.join(directory, name + '.json'), { bigint: true });
        return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      } catch (error) {
        if (error.code === 'ENOENT') return 'missing';
        throw error;
      }
    }));
    return versions.join('|');
  }

  async function readPublished() {
    const current = await read('published');
    if (current.value) return { snapshot: current.value, recovered: false };
    const previous = await read('previous');
    return { snapshot: previous.value || null, recovered: Boolean(previous.value) };
  }

  async function publish(snapshot) {
    validateSnapshot(snapshot);
    const current = await read('published');
    const previous = await read('previous');
    const last = current.value || previous.value;
    if (last && (last.sessionDate > snapshot.sessionDate || Date.parse(last.generatedAt) > Date.parse(snapshot.generatedAt)))
      throw Error('SCREENER_SNAPSHOT_REGRESSION');
    if (current.value && digest(current.value) === digest(snapshot)) return;
    // Current and rollback move together in one atomic primary replacement.
    // The separate previous file remains a corruption-recovery copy.
    const staged = await stage('published', last ? { current: snapshot, previous: last } : snapshot, last ? VERSION : 1);
    if (last) await write('previous', last);
    await commit('published', staged);
  }

  async function rollback() {
    const current = await read('published');
    const previous = await read('previous');
    const target = current.previous || previous.value;
    if (!target) throw Error('SCREENER_ROLLBACK_UNAVAILABLE');
    const staged = await stage('published', { current: target, previous: target }, VERSION);
    await write('previous', target);
    await commit('published', staged);
    return target.id;
  }

  async function readCooldown() {
    const result = await read('cooldown');
    if (result.corrupt || result.value !== undefined && (!Number.isSafeInteger(result.value) || result.value <= 0))
      throw Error('SCREENER_COOLDOWN_CORRUPT');
    return result.value || 0;
  }

  return { withLease, revision, readPublished, publish, rollback, readCooldown, saveCooldown: until => write('cooldown', until) };
}

module.exports = { completeForEligible, createScreenerSnapshotStore };
