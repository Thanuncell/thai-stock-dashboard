# Phase 1 Pre-flight Baseline

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
