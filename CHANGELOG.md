# Changelog

This changelog records product-visible changes, compatibility, acceptance evidence, and known limitations. Detailed implementation evidence remains available in repository history; this summary emphasizes product outcomes.

## SETscope v1.5.3.1 — Released 21 October 2026

### Fixed

- Improved Market Overview parsing tolerance so valid public data is less likely to be reported as unavailable when source wording or markup varies.
- Corrected Market Overview labels, units, startup rendering precedence, and freshness presentation without changing source values.
- Preserved truthful distinctions between source-no-data, parser mismatch, and deterministically invalid data.

### Reliability and compatibility

- Missing or malformed data remains unavailable instead of being fabricated or converted to zero.
- Healthy Market Overview fields continue to render when another field is unavailable.
- Existing Market Overview compatibility, data validation, graceful degradation, and rollback behavior remain intact.
- Chart, Technical, Coverage, News, News Archive, Watchlist, Authentication, and Stock Detail behavior is unchanged.

### Acceptance

- Local regression, syntax, server-smoke, CI, exact-candidate production smoke, and post-merge smoke passed before the release was frozen.

## SETscope v1.5.3 — Released 21 October 2026

### Added

- A more complete Market Overview with validated structured displays for Most Active and TFEX when usable source data exists.
- Field-level availability and graceful degradation for Market Overview data.

### Changed

- Market Overview requests share bounded reliability controls and avoid duplicate work without increasing the established polling cadence.
- A failure in one Market Overview field or source no longer blanks the entire page or affects unrelated workspaces.
- The established Market Overview API contract remains available for compatibility.

### Security and scope

- No provider bypass, private endpoint, database or access-control change, credential, scheduler, production real-time path, or additional polling timer was added.
- Chart, Technical, Yahoo Coverage, News, News Archive, Watchlist, Authentication, and Stock Detail behavior remains unchanged.

### Known limitations

- Most Active and TFEX remain dependent on usable structured data from the approved source. They show a truthful unavailable state when that data is absent.
- Ordinary source delay is not treated as proof that otherwise valid data is incorrect.

## SETscope v1.5.2 — Acceptance evidence recorded 18 October 2026

### Added

- Persisted evidence for Current Verified Coverage and Technical readiness.
- Preventive validation for symbol identity, numeric and OHLC integrity, timestamps, price consistency, anomalies, and stale fallback behavior.
- A Coverage summary on the Chart workspace that remains hidden until a completed verification run exists.

### Changed

- Chart freshness uses the selected data timestamp rather than browser receipt time.
- Technical Analysis, Watchlist alerts, and mover rankings use only accepted market data.
- An isolated transient failure or anomaly does not automatically erase an already verified state.

### Fixed

- Rejected chart-range data no longer appears under the requested range label using data from a different range.
- A rejected SET index response no longer wipes an otherwise valid stock response.
- Invalid, future, stale, duplicate, out-of-order, mismatched, or quarantined values no longer appear as trusted fresh input or fabricate technical output.

### Security and compatibility

- Persisted Coverage data remains server-controlled and isolated from direct browser access.
- No credential value, new provider, production real-time path, unrelated schema behavior, or broad production log query was added.
- Existing Watchlist, News Archive, Authentication, and unrelated market behavior remains compatible.

### Known limitations and acceptance evidence

- The approved 191-symbol SET100+sSET registry produced persisted evidence of 129 Current Verified and 129 Technical Ready symbols. One symbol remained quarantined after invalid numeric data was rejected, and 61 symbols remained pending.
- The daily scheduler remained intentionally off; no production scheduling service was enabled by the release.
- Owner-approved production verification passed: `/healthz` returned HTTP 200, the authenticated Chart UI showed the persisted Coverage result and source attribution, and Chart, News, Watchlist, Reload, Back/Forward, canonical URL state, and breadcrumb smoke checks passed.
- The recorded counts are timestamped acceptance evidence, not a hard-coded product limit or a claim of complete Thai-market coverage.
