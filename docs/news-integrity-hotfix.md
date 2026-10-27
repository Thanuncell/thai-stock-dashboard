# News integrity corrective hotfix

News, Watchlist News and Archive share verification decisions: `VERIFIED`, `UNVERIFIED` or `REJECTED`, with a reason and evidence basis. Metadata evidence and a verified article are identified separately; metadata acceptance does not claim that a full article was read. An uncertain article check cannot override a failure by carrying an older permissive `accepted` flag. Unverified items are quarantined, and rejected items remain hidden. Cached verified evidence and bounded same-owner last known good news remain usable; temporary failure does not delete stored news.

New feed quarantine diagnostics are bounded process memory, not a new durable queue. A restart discards that diagnostic list but does not promote uncertain items: subsequent reads/checks classify them again. Existing archive rows remain stored and use the read-time hide predicate.

Article extraction binds structured identity to the requested/resolved article URL and validates canonical references. An unrelated JSON-LD article body is excluded; a separately validated same-page article can still be used. This is a correction to the existing verifier/extractor, with no new acquisition source or Rui RSS integration.

AI analysis uses the documented [Responses Structured Outputs format](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Results must be complete, have the expected item identities and valid summaries before they are cached as AI. Failed, incomplete, refused or malformed responses use labelled rules fallback only when source text exists; otherwise analysis is unavailable. Failures are bounded without automatic request replay. Diagnostics contain allowlisted status/code/parameter and request shape only, never credentials, raw error messages or news text.

Historical production logs confirmed HTTP 400 but did not retain the error body or request model/schema. Its exact historical cause therefore remains unverified. The corrected request contract, sanitized diagnostics and fixture tests do not constitute a live OpenAI or production smoke PASS. Model/environment settings are unchanged.

Archive hiding happens before deduplication, Featured selection, search and pagination totals. No new schema or persistent deletion is introduced. To prepare a review plan from a separately obtained read-only snapshot, run `node scripts/review-news-archive.js snapshot.json output.json`. It writes a local hide-only plan and never connects to a database. Existing archive retention is unchanged; this hotfix does not authorize running retention or cleanup against production.

Rollback: revert the application commit. Existing archive rows remain intact and no schema rollback is required. A later decision to alter production rows, approve hidden items, merge, deploy or activate any job needs separate Owner approval. Scheduler/automation, Chart/Technical, Coverage and Auth implementations are unchanged.
