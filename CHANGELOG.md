# Changelog

## Unreleased — SETscope v1.5.2 acceptance candidate

### Added

- Persistent Coverage Truth schema and a bounded, idempotent daily verification runner with separate Current Verified Coverage and Technical Ready counts.
- A shared Preventive Data Guard for symbol/market identity, numeric/OHLC structure, timestamp freshness, price consistency, anomaly quarantine, and bounded context-specific last-known-good fallback.
- A minimal persisted Coverage summary on the Chart workspace; it stays hidden until a completed audit exists.

### Changed

- Chart freshness now uses the selected chart/provider timestamp rather than browser receipt time.
- Technical Analysis, Watchlist alerts, and mover rankings consume only accepted market data.
- Coverage lifecycle keeps a verified symbol through a single transient/anomaly failure and requires explicit confirmed lifecycle evidence before deactivation.

### Fixed

- Rejected range data can no longer fall back to a different chart range while retaining the requested range label.
- A guarded SET index failure no longer wipes an otherwise valid stock response.
- Invalid, future, stale, duplicate, out-of-order, mismatched, or quarantined values no longer masquerade as trusted fresh input or fabricate technical output.

### Security

- Coverage tables use forced RLS with no `PUBLIC`, `anon`, or `authenticated` direct privileges and object-scoped service-role DML only.
- No credential value, new provider, production real-time path, schema-wide default privilege, or Supabase production log query was added.

### Known limitations

- Production Current Verified Coverage remains unverified until the additive migration, authoritative registry seed, and first completed scheduled run are separately approved and executed.
- The recommended daily scheduler is documented but intentionally not provisioned because new shared/paid infrastructure requires owner approval.
