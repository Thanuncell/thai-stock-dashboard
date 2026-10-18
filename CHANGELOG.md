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

- The additive Coverage migration is applied to `setscope-auth`. An authorized 191-symbol SET100+sSET registry, five-symbol canary, and bounded 125-symbol batch produced persisted evidence of 129 Current Verified and 129 technical-ready symbols; BANPU remains quarantined as `temporary_failed`, and 61 symbols remain pending.
- The recommended daily scheduler remains intentionally OFF. No Render cron service or Supabase cron job was created.
- Owner-approved live Coverage UI verification passed on Render deploy `dep-dbaedhjrjlhs739upt80` at commit `9eebefdb5903aa220e1f4be5ae3afbc09356a163`. `/healthz` returned HTTP 200; the authenticated Chart UI showed persisted Current Verified Coverage 129, Last Checked 18 Oct 2026 22:24:19 Asia/Bangkok, and Yahoo Finance attribution. Chart, News, Watchlist, Reload, Back/Forward, canonical URL state, and breadcrumb smoke checks passed. Auto-Deploy was restored to On Commit immediately afterward; the branch remains unmerged and the daily scheduler remains OFF.
