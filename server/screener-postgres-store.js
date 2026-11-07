'use strict';

const { validateSnapshot } = require('./screener-snapshot-store');
const { fingerprint } = require('./daily-ohlcv');

function decode(value) {
  if (!value) return null;
  if (fingerprint(value.payload_text) !== value.content_sha256) throw Error('SNAPSHOT_CORRUPT');
  return validateSnapshot(JSON.parse(value.payload_text));
}

// Explicit dependency injection only. No environment lookup or acquisition path.
function createPostgresScreenerSnapshotStore({ db }) {
  if (!db?.query || !db?.connect) throw Error('EXPLICIT_SNAPSHOT_DATABASE_REQUIRED');
  async function revision() {
    return String((await db.query('select snapshot_revision from screener_private.state where singleton')).rows[0].snapshot_revision);
  }
  async function readPointers() {
    return (await db.query(
      'select s.snapshot_revision,c.payload_text current_text,c.content_sha256 current_hash,p.payload_text previous_text,p.content_sha256 previous_hash ' +
      'from screener_private.state s left join screener_private.snapshots c on c.content_sha256=s.current_hash ' +
      'left join screener_private.snapshots p on p.content_sha256=s.previous_hash where s.singleton')).rows[0];
  }
  async function readPublished() {
    const row = await readPointers();
    if (!row) return { snapshot: null, recovered: false };
    try {
      const current = row.current_text ? decode({ payload_text: row.current_text, content_sha256: row.current_hash }) : null;
      if (current) return { snapshot: current, recovered: false };
    } catch (_) { /* A separately validated prior snapshot can recover the read. */ }
    try {
      const previous = row.previous_text ? decode({ payload_text: row.previous_text, content_sha256: row.previous_hash }) : null;
      return { snapshot: previous, recovered: Boolean(previous) };
    } catch (_) { return { snapshot: null, recovered: false }; }
  }
  async function publish(snapshot, { expectedRevision } = {}) {
    validateSnapshot(snapshot);
    const text = JSON.stringify(snapshot);
    const expected = expectedRevision ?? await revision();
    await db.query('insert into screener_private.snapshot_candidates(payload_text) values($1) on conflict do nothing', [text]);
    await db.query('select screener_private.publish_snapshot($1,$2::bigint)', [fingerprint(text), expected]);
  }
  async function withLease(action) {
    const client = await db.connect();
    let acquired, discard;
    try {
      try {
        acquired = (await client.query("select pg_try_advisory_lock(hashtextextended('setscope-screener-writer',0)) acquired")).rows[0].acquired;
      } catch (error) { discard = error; throw error; }
      if (!acquired) throw Object.assign(Error('SNAPSHOT_WRITER_BUSY'), { code: 'EEXIST' });
      return await action();
    } finally {
      try {
        if (acquired) {
          const result = await client.query("select pg_advisory_unlock(hashtextextended('setscope-screener-writer',0)) unlocked");
          if (result.rows[0]?.unlocked !== true) throw Error('SNAPSHOT_WRITER_UNLOCK_FAILED');
        }
      } catch (error) { discard = error; throw error; }
      finally { client.release(discard); }
    }
  }
  return {
    revision, readPublished, publish, withLease,
    async rollback() {
      const row = await readPointers();
      if (!row?.previous_text) throw Error('SNAPSHOT_ROLLBACK_UNAVAILABLE');
      decode({ payload_text: row.previous_text, content_sha256: row.previous_hash });
      return db.query('select screener_private.rollback_snapshot($1::bigint)', [row.snapshot_revision]);
    },
    async readCooldown() {
      return Number((await db.query('select cooldown_until from screener_private.state where singleton')).rows[0].cooldown_until);
    },
    async saveCooldown(until) {
      if (!Number.isSafeInteger(until) || until <= 0 || until > 8.64e15) throw Error('SNAPSHOT_INVALID_COOLDOWN');
      await db.query('update screener_private.state set cooldown_until=greatest(cooldown_until,$1::bigint) where singleton', [until]);
    }
  };
}

module.exports = { createPostgresScreenerSnapshotStore };
