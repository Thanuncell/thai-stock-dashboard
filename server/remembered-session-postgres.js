'use strict';

const table = 'setscope_private.remembered_sessions';
const databaseNow = 'floor(extract(epoch from statement_timestamp()) * 1000)::bigint';
const revokeFields = 'revoked_at_ms = greatest($2::bigint, ' + databaseNow + '), encrypted = null, '
  + 'user_summary = null, lease_id = null, lease_until_ms = null, version = version + 1';

// Constructed only with an approved, separately scoped pool. This module does
// not open connections or enable issuance on its own.
function createPostgresRememberedSessionStore(pool) {
  return {
    async find(digest) {
      const { rows: [row] } = await pool.query(
        `select *, ${databaseNow} as checked_at_ms from ${table} where digest = $1`, [digest]
      );
      if (!row) return null;
      return {
        digest: row.digest, generation: row.generation, providerSessionId: row.provider_session_id,
        ownerId: row.owner_id, user: row.user_summary, issuedAt: Number(row.issued_at_ms),
        expiresAt: Number(row.expires_at_ms), accessExpiresAt: Number(row.access_expires_at_ms),
        encrypted: row.encrypted, checkedAt: Number(row.checked_at_ms),
        revokedAt: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
        version: row.version, lease: row.lease_id ? { id: row.lease_id, until: Number(row.lease_until_ms) } : null
      };
    },

    async hasProviderSession(sessionId) {
      const { rowCount } = await pool.query(`select 1 from ${table} where provider_session_id = $1`, [sessionId]);
      return rowCount === 1;
    },

    async issue(record, predecessor) {
      const client = await pool.connect();
      let discard;
      try {
        await client.query('begin');
        if (predecessor) {
          const retired = await client.query(`update ${table} set ${revokeFields}
            where digest = $1 and revoked_at_ms is null
            and expires_at_ms > greatest($2::bigint, ${databaseNow})`, [predecessor, record.issuedAt]);
          if (retired.rowCount !== 1) {
            await client.query('rollback');
            return false;
          }
        }
        const inserted = await client.query(`insert into ${table}
          (digest, provider_session_id, owner_id, generation, user_summary, issued_at_ms,
           expires_at_ms, access_expires_at_ms, encrypted)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`, [
          record.digest, record.providerSessionId, record.ownerId, record.generation, record.user,
          record.issuedAt, record.expiresAt, record.accessExpiresAt, record.encrypted
        ]);
        await client.query(inserted.rowCount === 1 ? 'commit' : 'rollback');
        return inserted.rowCount === 1;
      } catch (error) {
        try { await client.query('rollback'); } catch (rollbackError) { discard = rollbackError; }
        throw error;
      } finally { client.release(discard); }
    },

    async acquireRefresh(digest, version, lease, now) {
      const at = `greatest($5::bigint, ${databaseNow})`;
      const { rowCount } = await pool.query(`update ${table} set lease_id = $3, lease_until_ms = $4
        where digest = $1 and version = $2 and revoked_at_ms is null
        and lease_id is null and expires_at_ms > ${at} and $4 > ${at}`,
      [digest, version, lease.id, lease.until, now]);
      return rowCount === 1;
    },

    async finishRefresh(digest, version, leaseId, update, now) {
      const at = `greatest($7::bigint, ${databaseNow})`;
      const { rowCount } = await pool.query(`update ${table}
        set encrypted = $4, access_expires_at_ms = $5, user_summary = $6,
            version = version + 1, lease_id = null, lease_until_ms = null
        where digest = $1 and version = $2 and lease_id = $3 and revoked_at_ms is null
        and expires_at_ms > ${at} and lease_until_ms > ${at}`,
      [digest, version, leaseId, update.encrypted, update.accessExpiresAt, update.user, now]);
      return rowCount === 1;
    },

    async revoke(digest, now, leaseId = null) {
      const { rowCount } = await pool.query(`update ${table} set ${revokeFields}
        where digest = $1 and revoked_at_ms is null and ($3::text is null or lease_id = $3)`,
      [digest, now, leaseId]);
      return rowCount === 1;
    }
  };
}

module.exports = { createPostgresRememberedSessionStore };
