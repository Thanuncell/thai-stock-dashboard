# SETscope

Thai stock dashboard. Run `start.bat` (Node.js 18 or newer is required), then open http://127.0.0.1:4173.

## Development checks

Run `npm test` for deterministic unit, contract, auth, outage, and security regression tests. Run `npm run check` for JavaScript syntax checks. The tests use local fixtures and mocks; they do not call live market-data providers or require production credentials.

Backend HTTP routing and response mapping remain in `server.js`. Provider and persistence boundaries live in `server/`: `auth-service.js`, `watchlist-service.js`, `market-service.js`, `settrade-service.js`, and `news-service.js`. Each service is created through a small factory so tests can inject deterministic fetch behavior without changing the public API.

## Deploy from GitHub

This app needs a small Node.js server to proxy Yahoo Finance and RSS requests. GitHub Pages only serves static files, so use Render's free web service instead. Push this repository to GitHub, sign in to [Render](https://render.com/), create a new Blueprint, and select the repository. Render reads `render.yaml`, builds the Node app, and gives it a public `onrender.com` URL. The free service may sleep after 15 minutes with no incoming traffic and take time to wake; see [Render free-instance limits](https://render.com/docs/free).

## Authentication setup

Email/password sign-up and sign-in use Supabase Auth; passwords are never stored by this app. Before the dashboard is available, create a Supabase project and set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Render's Environment settings (use the anon/publishable key, never a service-role or secret key). In Supabase, allow the deployed site's URL as an Auth redirect URL and configure email confirmation. The dashboard data APIs validate each access token with Supabase before returning search, market, or news data. If the variables are missing, the site stays on the setup/login screen and the APIs refuse access.

The sign-up page requires accepting the Terms and acknowledging the Privacy Notice. Review `terms.html` and `privacy.html`, fill in the real controller/support contact, and verify data retention and provider descriptions before public launch. Watchlists sync across devices for the same Supabase account. To enable this, run `supabase/watchlists.sql` once in Supabase Dashboard > SQL Editor. The table uses row-level security so each account can only read and change its own Watchlists. Alert preferences remain in browser storage.

## Yahoo Finance market data

The dashboard searches Yahoo Finance's Thai equity results (symbols ending in `.BK`) by company name or ticker, with up to five locally saved watchlists and 30 symbols in each list. The selected list drives the sidebar, watchlist movers, market requests, and alert settings. Watchlists are stored in the browser and the previous single-list data is migrated on first load. The Yahoo Finance search and chart endpoints are undocumented and may change; search coverage follows Yahoo's market-symbol index, so check the SET securities directory if a listed symbol is not returned. Quotes and analysis poll every minute. Yahoo labels Thai stock quotes as delayed; the dashboard discloses an approximately 15-minute delay.

The main chart is rendered by SETscope as an OHLC candlestick chart with volume and selectable SMA 20 / EMA 20, 50, 100, and 200 overlays. Its data comes from Yahoo Finance, not TradingView; Yahoo Finance data for Thai stocks is delayed (the API response currently labels the delay as approximately 15 minutes). The side-panel RSI, MACD, SMA and EMA summary is calculated separately from Yahoo Finance closing prices. The technical panel explains the indicator evidence on each side, calculates nearby swing-low supports and swing-high resistances from the same selected chart timeframe, and describes a condition to monitor. A long EMA is omitted from the vote until enough bars are available. These are approximate levels and educational context, not an instruction to trade. The Technical View stock search changes the active chart only; the selected symbol stays in the search field. Adding to the Watchlist requires the separate add button. The light/dark theme and watchlist are saved in the browser. The watchlist scrolls independently when it has more items than fit on screen.

The SET Index banner uses Yahoo Finance for price, volume, high, and low. To display the SET market's accumulated trading value in million baht, configure the `SET_API_KEY` environment variable in Render. The backend requests the delayed index endpoint from SET's Market Data API. The value remains unavailable when this key is not configured or the API cannot return it; it is not estimated from volume.

## Coverage truth and preventive data guard (v1.5.2 acceptance candidate)

Market payloads pass through one server-side data guard before SETscope treats them as usable. The guard validates the requested Yahoo symbol and Thai market identity, finite numeric values, OHLC invariants, non-negative volume, ordered/unique timestamps, future and regular-session stale timestamps, last/close and change consistency, and configurable price-move anomalies. Suspect or quarantined payloads never update the in-memory last-known-good value and never feed RSI, MACD, EMA, support, resistance, mover ranking, or alerts. A context-isolated last-known-good value may be shown only as explicitly stale, with its original `asOf`, for at most 24 hours by default; otherwise the value is unavailable. The guard performs no network request of its own.

Guard policy is configurable at the server boundary with `DATA_GUARD_FUTURE_TOLERANCE_MS`, `DATA_GUARD_REGULAR_STALE_MS`, `DATA_GUARD_MAX_PRICE_MOVE_RATIO`, `DATA_GUARD_LAST_KNOWN_TTL_MS`, and `DATA_GUARD_LAST_CLOSE_MISMATCH_RATIO`. These settings change validation thresholds only; they do not enable real-time delivery or add a corroboration provider.

`supabase/coverage.sql` is an additive, service-role-only persistence migration for `security_coverage` and `coverage_runs`. Browser roles and `PUBLIC` receive no direct privileges, RLS is enabled and forced, and no existing Watchlist, News Archive, Auth, or default-privilege object is changed. Apply it only after review. Seed only an authoritative, authorized symbol registry through `COVERAGE_SYMBOLS`; a symbol list, search result, or historical planning number is not proof of working coverage.

The bounded runner is `node scripts/run-coverage-verification.js`:

- `COVERAGE_BATCH_SIZE` defaults to 125 and is clamped to 1–200.
- `COVERAGE_CONCURRENCY` defaults to 4 and is clamped to 1–10.
- Oldest `last_checked_at` values are checked first. Each symbol is isolated, transient failures receive at most one bounded retry, and a completed daily run is idempotent.
- Current Verified Coverage counts active rows where both `symbol_verified` and `chart_ready` are true. `technical_ready` remains a separate health count.
- A single transient failure, anomaly, or quarantined payload preserves the prior verified state. A symbol becomes inactive or unsupported only when an adapter supplies explicit confirmed lifecycle evidence.
- The recommended schedule is once daily around 19:00 Asia/Bangkok (12:00 UTC), configured in the scheduler rather than hard-coded in the application. No production scheduler is created by this repository change because activating new shared/paid infrastructure requires a separate owner decision.

The authenticated `/api/coverage` summary is cached for five minutes and is requested once, lazily, on the first Chart visit. It has no browser polling and causes no Yahoo request. The UI remains hidden until a completed persisted run exists; it then displays only the verified count, completion time, and Yahoo Finance attribution. A saved summary older than 36 hours is classified stale instead of being relabelled fresh.

Current production coverage is intentionally **unverified** until the migration is approved and applied, an authoritative registry is seeded, and a completed persisted run is inspected. Do not publish a coverage count from fixtures, search limits, or planning targets.

For rollback, first disable the external schedule and revert the v1.5.2 application commits; the additive tables can remain safely unused. `supabase/coverage_rollback.sql` is destructive and must only be run manually after a backup and explicit approval. Do not remove the shared server-side Supabase secret solely to disable Coverage because News Archive also uses it; a missing table or completed run already keeps the Coverage UI hidden.

## Real-time readiness (production delivery remains off)

`server/realtime-readiness.js` defines an inactive boundary for a future licensed provider. It separates latest-price, chart, and market-snapshot methods; normalizes provider/source/as-of and delayed/stale/partial state; keeps a bounded in-memory last-known store; coalesces duplicate reads; enforces an in-flight request limit; and exposes an injectable fanout boundary without creating sockets, listeners, timers, queues, or database tables.

`REALTIME_READY` and `REALTIME_ENABLED` are independent opt-in flags and both default to false. `REALTIME_ENABLED=true` has no effect unless `REALTIME_READY=true`, and the production server does not initialize the readiness runtime or add UI/network activity in this phase. Existing Yahoo Finance behavior remains delayed polling with the same request budget. Disabling the future path is therefore an immediate rollback that leaves the delayed provider unchanged.

Do not connect or enable a live provider until the production Go/No-Go review has separately confirmed data rights and redistribution terms, entitlement enforcement, provider and fanout capacity, monitoring, partial-outage fallback, and operational rollback. Provider credentials must remain server-side and must never enter responses, cache keys, browser code, or logs.

Alert settings are created only for symbols in the currently selected Watchlist. Users can enable technical signal-change alerts and set an upper or lower price threshold. Alert preferences, state, and recent history are stored in that browser's local storage. The dashboard polls once per minute while the page is open; browser notifications require permission. There is no server-side push or background monitoring after closing the page, and Yahoo's Thai quotes are delayed.

## News

The news panel reads Google News RSS search feeds and refreshes every 5 minutes. Changing the publisher filter or typing a search uses already loaded data and does not trigger another upstream feed request. Featured News remains limited to the latest 7 days and follows the active source filter. Watchlist News keeps relevant stories from unknown publishers as `other` instead of treating an unknown publisher as an irrelevant story.

The visible broker filter is **โบรกเกอร์**. Broker attribution is separate from the actual publisher, so an InfoQuest, efinance, or other publisher card can remain credited to that publisher while also being discoverable under the broker filter. The initial mapping covers KS, INVX, BLS, FSS, KKPS, KGI, YUANTA, KSS, KTX, and LIB. Acronyms alone are intentionally not treated as attribution.

### News Archive (up to 365 days)

Run `supabase/news_archive.sql` once, then set `SUPABASE_SECRET_KEY` only in the Render server environment. The legacy `SUPABASE_SERVICE_ROLE_KEY` remains a temporary server-side fallback, but the current Supabase secret key is preferred. Never place either elevated key in browser code, a URL, source control, or logs. The archive table has RLS enabled and direct `anon`/`authenticated` access revoked; the browser reads it only through the authenticated SETscope API.

Each five-minute live refresh performs one existing set of upstream feed reads, then batch-upserts normalized, HTTPS-validated, deduplicated items. It never refetches a full year. Archive reads are server-paginated at 10 items in the UI and capped at 50 items per API request. Retention cleanup runs at most once per day per server process and deletes no more than 500 expired rows per call. The archive is **up to one year and subject to available source data**: it grows from successful incremental ingestion and does not claim historical completeness or backfill content the upstream source cannot provide.

If archive persistence is not configured or is temporarily unavailable, current 30-day live News remains available and is labelled honestly; missing archive data is not converted to zero or presented as fresh. `supabase/news_archive_rollback.sql` is a destructive manual rollback and should only be used after a backup. The safer application rollback is to revert the archive commit or remove `SUPABASE_SECRET_KEY`, which leaves the additive table intact.

### Shareable workspace URLs

The URL is the canonical source for workspace navigation. Reload, Ctrl+F5, bookmarks, and Back/Forward preserve these states:

- `#overview`
- `?symbol=PTT&range=1M#chart`
- `?s=PTT&source=infoquest&newsPage=12#news`
- `?watchlist=list-2&watchPage=4#watchlist`

Only a Watchlist identifier and page are stored in the URL; stock lists, account identifiers, email addresses, tokens, and credentials are never serialized. Invalid or stale parameters are safely replaced with canonical defaults. Auto refresh does not add browser-history entries or change the current page.

### News request budget

The upstream budget is unchanged: the main News feed and Watchlist News each refresh at the existing five-minute cadence, with server cache/single-flight protection. When the archive is configured, the browser adds one bounded `/api/news-archive` database-page request at News startup/refresh and on archive-page navigation. Source filter clicks may read a different server-side archive page but never initiate a new upstream RSS ingestion. No polling interval is shorter than five minutes.

Headlines link to the publisher story. A lightweight Thai headline keyword heuristic labels each item positive, negative, or neutral; it marks whether the headline mentions the currently viewed stock. This is a headline-level hint, not full-article sentiment or investment advice. Feed availability, retention depth, redistribution rights, and update timing depend on the publishers and feed service and must be reviewed before public launch.

Technical signals are for educational purposes, not investment advice. Yahoo Finance data must not be presented as real-time for SET: Yahoo classifies it as delayed. Search results are limited to symbols indexed by Yahoo Finance; Yahoo chart data is also an undocumented service.
