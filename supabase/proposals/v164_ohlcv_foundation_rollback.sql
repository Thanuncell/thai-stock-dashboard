-- Application rollback: disable the optional PostgreSQL adapters and return to
-- the accepted file snapshot / guarded Chart read path. Retain the schema and data.
--
-- Snapshot recovery: inspect the state below, then use the backend snapshot
-- adapter rollback() for a verified Previous payload. It validates the payload
-- and checksum, and the database checks the revision and payload before changing
-- Current. The read path still checks the latest completed trading session.
--
-- Schema uninstall is separately approved maintenance. Verify a backup by
-- restoring it into an isolated database. Inspect catalog dependencies including
-- dependents outside this schema. Resolve them explicitly before removing named
-- objects in dependency order with RESTRICT. Stop on any dependency error.
-- This file only inspects state.
begin read only;
select s.snapshot_revision, s.current_hash, s.previous_hash,
  screener_private.fingerprint(c.payload_text) = s.current_hash as current_checksum_ok,
  screener_private.fingerprint(p.payload_text) = s.previous_hash as previous_checksum_ok
from screener_private.state s
left join screener_private.snapshots c on c.content_sha256=s.current_hash
left join screener_private.snapshots p on p.content_sha256=s.previous_hash
where s.singleton;
commit;
