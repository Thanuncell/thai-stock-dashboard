# SETscope v1.5.3 acceptance-candidate verification

- Active execution specification: `v153_v6.docx`, titled SETscope v1.5.3 Market Overview Completion & Reliability FINAL v6. Earlier v1.5.3 documents are historical references only.
- Source of truth and exact baseline: clean `main` / `origin/main` at `96c65564659982bbff33cfef5542790a39bd5bb3` (merge commit of PR #36). v1.5.2.x through v1.5.2.3 remain closed and frozen.
- Working branch: `codex/v1.5.3-market-overview`, created directly from that baseline. `main` was not edited and no prior feature branch was merged into it.
- Baseline full regression passed 131/131 with loopback permission. The v1.5.3 targeted Market Overview, parser, reliability, lifecycle, network-budget, and server-smoke suite passes 53/53. The complete post-change suite passes 146/146, syntax validation passes 25/25, and `git diff --check` passes.
- The server smoke gate passes 5/5. Partial provider outages keep independently healthy fields and APIs available; the neutral `/api/market-overview` route and compatibility `/api/settrade-overview` route return the same preserved contract.
- Provider safety verification covers the kill switch, source/page/schema guards, zero-request disabled mode, sequential request spacing, coalescing, the shared manual-refresh budget, 401/403/CAPTCHA hard stop, 429 cooldown, bounded retries, OPEN → HALF_OPEN → ACTIVE recovery, field-level LKG, and parser failure without compensating requests.
- Market Overview keeps its existing five-minute browser polling cadence and the same five upstream page paths. A normal cache-miss cycle remains five upstream requests before and after; the provider cache now aligns to five minutes, requests are sequential with 250 ms default spacing, and the shared default ceiling is seven attempts per five minutes. Manual refresh cannot bypass the cache or provider safety layer.
- Most Active and TFEX have semantic structured parsers and SETscope-owned rendering inside the existing cards. They publish only validated values exposed in the normal upstream response; missing or placeholder data stays explicit `UNAVAILABLE` or bounded `LKG`, never fabricated zero/fresh data.
- Shadow/API comparison defaults OFF and is evidence-only when explicitly configured. A mismatch cannot replace, quarantine, or alter production SETTRADE output in v1.5.3.
- Chart, Technical, Yahoo Coverage, News, publisher extraction, News Archive, Watchlist, Authentication, Stock Detail, database schema/RLS, environment configuration, scheduler, and production true real-time behavior are unchanged.
- Existing untracked user documents, CSV files, lockfile, and screenshots remain preserved and excluded.
- CI and authenticated exact-commit production smoke are pending the reviewable branch commit/deployment gate.

### v1.5.3 rollback readiness

1. Revert the v1.5.3 application commits or redeploy baseline `96c65564659982bbff33cfef5542790a39bd5bb3`.
2. The legacy `/api/settrade-overview` compatibility route remains available, so rollback requires no client contract migration.
3. No database migration, RLS change, environment value, secret, provider entitlement, scheduler, polling interval, or production real-time setting was added; there is no data rollback step.

# SETscope v1.5.2 acceptance-candidate verification

- Source of truth and base: latest fetched `origin/main` at `5c58d8a78ad87481dc6d8e2babf1e51e35885b73` (merge commit of PR #30).
- Working branch: `codex/v1.5.2-stability`, created from that exact commit. `main` was not edited.
- v1.5.1 repository state was complete at baseline. Baseline verification on 2026-10-18 (Asia/Bangkok) passed 72/72 tests, 18/18 syntax targets, and `git diff --check`.
- The v1.5.2 full suite passes 102/102 when loopback access is allowed. The final sandboxed run passed 97 assertions and reported exactly five `EACCES 127.0.0.1` environment failures in `server-smoke.test.js`; no application assertion failed. Rerunning the same suite with local loopback permission passed all 102 checks. Syntax validation passes 21/21 and `git diff --check` passes.
- Targeted Coverage/Data Guard/UI/network/security verification passes 62/62. The production-gate repair subset passes 27/27.
- Production true real-time remains OFF. Existing market polling remains one minute; News and Watchlist News remain five minutes. The guard adds zero upstream requests. Coverage adds one lazy, cached database-summary request on the first Chart visit and no interval.
- `supabase/coverage.sql` was applied additively to production project `setscope-auth` during the separately approved Production Coverage Gate. The destructive rollback was not run. Both Coverage tables have RLS enabled and forced; `anon` and `authenticated` have no direct table privileges, while `service_role` has only SELECT/INSERT/UPDATE/DELETE.
- The approved registry is the deduplicated union of 100 official SET100 constituents and 91 official sSET constituents: 191 configured/active symbols with no invalid or duplicate symbol. A five-symbol canary passed 5/5. The bounded 125-symbol batch passed 124 with one correctly quarantined `INVALID_NUMERIC` result for BANPU.
- Persisted production evidence at 2026-10-18 22:24 Asia/Bangkok: configured 191, universe 191, Current Verified Coverage 129, technical-ready 129, partial 0, stale 0, temporary-failed 1, inactive 0, unsupported 0, pending 61. Current Verified Coverage is measured from `symbol_verified && chart_ready`, not hard-coded.
- The daily scheduler remains OFF: no Render cron service, no Supabase `pg_cron` extension/job, and no browser interval was added.
- Production UI verification passed on the owner-approved specific-commit deploy `dep-dbaedhjrjlhs739upt80`, commit `9eebefdb5903aa220e1f4be5ae3afbc09356a163`. `/healthz` returned HTTP 200; the authenticated Chart UI displayed Current Verified Coverage 129, Last Checked 18 Oct 2026 22:24:19 Asia/Bangkok, and Yahoo Finance attribution from persisted production evidence. Chart, News, Watchlist, Reload, Back/Forward, canonical URL state, and breadcrumb smoke checks passed. BANPU remained excluded from verified coverage and visibly marked suspect; the invalid quote was not promoted to fresh/verified or used as Technical Analysis input. Render Auto-Deploy was recorded as On Commit before the deploy, temporarily disabled by the specific-commit flow, and restored to On Commit immediately after smoke verification. The live deploy remained `9eebefd`; no rollback was required.
- Supabase Log Query Conservation Policy was followed. Local source inspection, deterministic fixtures, API smoke tests, and schema-policy tests were sufficient; no Supabase production log query or broad scan was performed.
- Existing untracked user documents, CSV files, lockfile, and screenshots remain preserved and excluded.

### v1.5.2 rollback order

1. Disable any future external Coverage schedule, then revert the v1.5.2 commits to remove the guard, Coverage API/UI, and runner while preserving the frozen v1.5.1 behavior.
2. Leave the additive Coverage tables in place if an application-only rollback is sufficient; browser roles have no direct access.
3. Use `supabase/coverage_rollback.sql` only after a backup and explicit destructive-migration approval. It drops only `coverage_runs` and `security_coverage`.
4. No Watchlist, News Archive, Auth, Render environment, existing RLS policy, or production real-time setting needs to change for rollback.

# Phase 1 Pre-flight Baseline

## v1.5.1 News / URL State baseline and execution record

- Frozen v1.5.0 baseline: `f1aa7c10bf3b99c9944b9ce12f1a583fafe1f71a` (merge commit of PR #25).
- Source branch: `codex/v1.5.1-news-url-state`, created directly from the fetched `origin/main` baseline. `main` was not edited.
- Pre-implementation gate on 2026-10-18 (Asia/Bangkok): 53/53 deterministic tests passed, 16/16 syntax targets passed, and `git diff --check` passed.
- The first sandboxed smoke-test attempt was blocked from loopback access with `EACCES`; rerunning the same suite with local loopback permission passed 53/53. No application assertion failed.
- Existing untracked local documents, CSV files, and screenshots were preserved and excluded.
- Production real-time delivery remains OFF. v1.5.1 adds no realtime provider, socket, listener, queue, or shorter polling interval.

### v1.5.1 implementation boundaries

- Live RSS ingestion remains five minutes and never fetches a full year per cycle.
- The News Archive is additive and requires `supabase/news_archive.sql` plus a server-only `SUPABASE_SECRET_KEY`; RLS stays enabled and browser roles have no direct archive privileges.
- Archive coverage means up to 365 days from successful incremental ingestion, subject to source availability. It is not a completeness or backfill guarantee.
- Workspace URL state contains only route, validated chart symbol/range, News query/source/page, or Watchlist ID/page. It never contains a full Watchlist, user identity, token, or credential.
- Source changes render loaded live data immediately. The optional archive page read is database-backed and does not trigger upstream ingestion.
- Supabase Log Query Conservation Policy was followed: local tests and source inspection were sufficient, so no Supabase production log query was made.
- Final UI Cleanup pre-merge gate on 2026-10-18: 72/72 deterministic tests passed, 18/18 syntax targets passed, and `git diff --check` passed. The scoped patch removes the obsolete News footer and Watchlist status/footer, prevents the old generic News selector from writing into Watchlist, preserves the existing `ข่าวล่าสุด` spacing, changes the saved-chart action to `ติดตามแล้ว`, removes the visible chart metadata row, and uses the approved Yahoo Finance source line while retaining the updated timestamp and PTT default. News and Watchlist pagination keep their existing state and request flow, then scroll only the relevant list heading with reduced-motion support. Overview, Technical Analysis wording/calculations, backend APIs, Supabase, Auth, polling, provider logic, secrets, and Render configuration are unchanged.
- Pagination top hotfix pre-merge gate on 2026-10-18: 72/72 deterministic tests passed, 18/18 syntax targets passed, and `git diff --check` passed. News and Watchlist News now scroll to the top of the page (`top: 0`) after a page change while preserving reduced-motion behavior, all page/filter/query/watchlist/URL state, the existing request flow, and the polling/network budget.

### Rollback order

1. Revert `5bcd56d` to remove archive API/UI integration while retaining Watchlist, broker, Featured, URL, breadcrumb, and bell fixes. The additive database table may remain safely in place.
2. Revert `5ea89c6` to remove URL navigation state and News UI changes.
3. Revert `6824fcc` to remove the isolated Watchlist/broker reliability fix.
4. `supabase/news_archive_rollback.sql` drops archive data and is destructive; back up the table and use it only when an explicit database rollback is required.
5. Removing `SUPABASE_SECRET_KEY` disables archive persistence/read availability without exposing or deleting data. Do not print the key during diagnosis.

## Repository baseline

- Repository: `Thanuncell/thai-stock-dashboard`
- Source of truth: `origin/main`
- Base main SHA: `6a47d0453f0832ff0d38197e1d0ea831e021afde`
- Base commit: `Merge pull request #20 from Thanuncell/codex/remove-footer-sources`
- Working branch: `codex/hardening-phase-1-tests-security`
- Date: 2026-10-16 (Asia/Bangkok)
- The branch was created directly from the fetched `origin/main`. `main` was not edited.
- Existing untracked local artifacts were preserved and excluded from Phase 1.

## Root and package baseline

Tracked root files at baseline:

- `.gitignore`
- `.github/workflows/keepalive.yml`
- `README.md`
- `about.html`
- `analysis.css`
- `app.js`
- `auth.js`
- `disclaimer.html`
- `index.html`
- `package.json`
- `privacy.html`
- `render.yaml`
- `server.js`
- `start.bat`
- `style.css`
- `supabase/keepalive.sql`
- `supabase/watchlists.sql`
- `terms.html`
- `ประวัติ/README.md`

Baseline `package.json` had one script, `start: node server.js`, no dependencies, and Node `>=18`. The managed workspace provides Node 24.19.0 but no `npm` executable. Because the package declares no dependencies, no dependency installation was required locally; CI still performs `npm install --ignore-scripts` to exercise the repository's documented install path.

## Functional and response baseline

- `node --check server.js`, `node --check app.js`, and `node --check auth.js` passed.
- No tracked test suite existed.
- `GET /healthz` returned 200 with fields `ok`, `service`, `uptimeSec`, `cacheEntries`, and `time`.
- `GET /api/auth-config` returned 200 with fields `configured`, `url`, and `anonKey`.
- With Supabase environment variables absent, protected endpoints returned 503 with `{"error":"ระบบสมาชิกยังไม่ได้ตั้งค่า"}`. This is the baseline local behavior, not an authentication bypass.
- Static `GET /index.html` returned 200.
- Baseline responses included the invalid header `Access-Control-Allow-Origin: same-origin` and had no Content Security Policy.
- The live Supabase project `setscope-auth` was healthy. `public.user_watchlists` and `public.keepalive` had RLS enabled. Watchlist SELECT, INSERT, and UPDATE policies were scoped to `auth.uid() = user_id`, with UPDATE using both `USING` and `WITH CHECK`.

## Baseline request budget

For an authenticated dashboard with a populated watchlist during a five-minute window beginning at page setup:

- `/api/auth-config`: 1 startup request
- Supabase `/auth/v1/user`: 1 startup validation request, plus token refresh only when expiry requires it
- `/api/watchlists`: 1 startup read; one debounced write can follow the existing first-time sync behavior
- `/api/market`: 5 requests (startup plus four one-minute interval executions before minute five)
- `/api/settrade-overview`: 1 startup request
- `/api/news`: 1 startup request
- `/api/watchlist-news`: 1 startup request

The baseline registers each polling interval once. Phase 1 must not shorten these intervals or add upstream polling.

## Known limitations and risks before Phase 1

- The document renderer could not produce page images because the managed runtime did not include LibreOffice, and native Word automation was unavailable. The execution spec was still read completely from document XML, including all 961 paragraphs, 26 tables, header, and footer; the package contained no comments, footnotes, endnotes, or images.
- Live login, registration, and session refresh were not exercised with a real user credential during pre-flight. Phase 1 adds deterministic mocked auth-flow coverage without storing credentials.
- Live provider success responses were not used as unit-test fixtures. Tests use deterministic local fixtures and mocks to avoid flakiness and provider load.
- Supabase security advisors reported two existing warnings: mutable `search_path` on `public.set_user_watchlists_updated_at` and leaked-password protection disabled. Phase 1 does not change database schema or external Auth settings; these remain explicit follow-ups.
- No production secrets, service-role keys, vendor tokens, or user data were copied into the repository or test logs.

## Phase 1 scope

- Add regression tests for indicators, symbol/watchlist validation, SETTRADE parsing, news URL/redirect allowlisting, auth/session refresh, protected routes, watchlist user scoping, stale async responses, provider partial outage, cache scoping, RLS policy source, and request budget.
- Extract only the pure functions required by those tests while preserving outputs and public API routes.
- Add a restrictive CSP that permits the current same-origin scripts/API calls, Supabase project origin, and Google Fonts resources used by the existing UI.
- Remove the invalid CORS origin header.
- Add CI for install, tests, and syntax checks.
- Do not redesign the UI, change public API response shapes, change polling intervals, change Supabase schema, add dependencies, restore Step 8 infrastructure, or enable production real-time.
