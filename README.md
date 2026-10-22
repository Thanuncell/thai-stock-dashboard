# SETscope

SETscope is a Thai stock dashboard for market monitoring, charts, technical context, news, and personal Watchlists.

Run `start.bat` with Node.js 18 or newer, then open <http://127.0.0.1:4173>.

## Development checks

Run `npm test` for the regression suite and `npm run check` for JavaScript syntax checks. Tests use local fixtures and mocks; they do not require production credentials or call live market-data providers.

## Deploy from GitHub

SETscope requires a Node.js web service for authenticated APIs and third-party data requests. GitHub Pages alone is not sufficient. To deploy on Render, push the repository to GitHub, create a Blueprint from the repository, and let Render apply `render.yaml`.

Free Render services may sleep after a period without traffic and can take time to wake. See [Render free-instance limits](https://render.com/docs/free).

## Authentication and Watchlists

Email/password sign-up and sign-in use Supabase Auth; SETscope does not store passwords. Configure these server environment variables before public use:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY` using the anon/publishable key, never an elevated server secret

Allow the deployed URL as a Supabase Auth redirect URL and configure email confirmation. If authentication is not configured, protected dashboard APIs refuse access.

Review `terms.html` and `privacy.html`, replace placeholder support/controller details, and verify the described retention and data-provider practices before launch.

To synchronize Watchlists across devices, review and apply `supabase/watchlists.sql` once. Row-level security keeps each account's Watchlists isolated. Alert preferences remain stored in the user's browser.

## Market data and analysis

SETscope supports Thai equity search, saved Watchlists, an OHLC candlestick chart with volume, and selectable SMA/EMA overlays. RSI, MACD, moving averages, support, and resistance are calculated from the selected chart data and timeframe.

Market information is validated before being presented as current or used for technical calculations. Invalid or suspect data is not converted into a plausible-looking value. When a previously accepted value is retained temporarily, the interface must identify it as stale or last-known data rather than fresh.

Yahoo Finance identifies Thai market quotes as delayed, commonly by approximately 15 minutes. Its search and chart availability may change, and symbol coverage is not guaranteed to include every SET-listed security. Technical signals and calculated levels are educational context, not investment advice.

To display the SET market's accumulated trading value, configure `SET_API_KEY` in the server environment. If the value cannot be retrieved, SETscope shows it as unavailable rather than estimating it from volume.

## Market Overview availability

Market Overview presents validated public market information with independent field-level availability. A missing or malformed field must not blank the entire Overview, overwrite a valid value with zero, or affect Chart, Technical, Coverage, News, Watchlist, Authentication, or Stock Detail.

SET, mai, market breadth, trading summaries, NVDR/foreign activity, Most Active, and TFEX are displayed only when usable structured data is available. Otherwise the affected field or card shows a truthful unavailable or stale state. SETscope does not fabricate missing values.

Compatibility with the established Market Overview API is preserved. Source availability and upstream page formats may still change without notice.

## Coverage and data reliability

Coverage is based on completed verification evidence, not the size of a symbol list or a whole-market claim. The Chart workspace displays a Coverage summary only after a persisted verification run exists and clearly distinguishes verified Chart and Technical readiness.

To enable persisted Coverage, review and apply `supabase/coverage.sql`, then provide an authoritative, authorized symbol registry through `COVERAGE_SYMBOLS`. Run `node scripts/run-coverage-verification.js` as a bounded verification job. This repository does not enable a production scheduler automatically; scheduling requires a separate owner decision.

Coverage verification preserves an already verified symbol through an isolated transient failure or anomaly unless there is confirmed lifecycle evidence that the symbol is no longer supported. Suspect data is quarantined and does not feed technical analysis.

The production acceptance run recorded on 18 October 2026 verified 129 of the approved 191-symbol registry for both Chart and Technical readiness. One symbol was quarantined because its numeric data failed validation, and 61 symbols remained pending. This is timestamped evidence, not a permanent product limit or a complete-market coverage claim. The daily scheduler remained off.

If Coverage must be disabled, stop its external schedule and revert the related application changes. `supabase/coverage_rollback.sql` is destructive and must only be used after a backup and explicit approval.

## Real-time status and alerts

Production true real-time delivery is off. SETscope continues to use delayed data at its established polling cadence. A live provider must not be enabled until data rights, redistribution terms, entitlements, capacity, monitoring, outage fallback, and rollback have been approved. Provider credentials must remain server-side.

Alerts apply only to symbols in the selected Watchlist. Users can monitor technical signal changes and upper or lower price thresholds while the page is open. There is no server-side push or background monitoring after the page is closed, and browser notifications require permission.

## News

News refreshes every five minutes. Changing a publisher filter or entering a search uses loaded data and does not itself request another upstream feed. Featured News covers the latest seven days and follows the active source filter. Watchlist News keeps relevant stories from unknown publishers under `other` instead of discarding them solely because the publisher is unknown.

The **โบรกเกอร์** filter keeps broker attribution separate from the actual publisher. The supported broker mapping includes KS, INVX, BLS, FSS, KKPS, KGI, YUANTA, KSS, KTX, and LIB. An acronym alone is not treated as sufficient attribution.

### News Archive

To enable the News Archive, review and apply `supabase/news_archive.sql`, then configure `SUPABASE_SECRET_KEY` only in the server environment. Never place an elevated key in browser code, URLs, source control, or logs. Direct browser access to the archive database is not required; authenticated users access it through the SETscope API.

The archive grows incrementally from successfully received and validated items, retains up to 365 days, and does not claim complete historical coverage. The UI displays 10 items per page, while server responses remain bounded. It does not fetch a full year of upstream news on each refresh.

If archive persistence is unavailable, current live News continues in a truthful degraded mode. `supabase/news_archive_rollback.sql` is destructive and must only be used after a backup and explicit approval.

## Shareable workspace URLs

The URL is the canonical navigation state. Reload, Ctrl+F5, bookmarks, and Back/Forward preserve supported workspace state, for example:

- `#overview`
- `?symbol=PTT&range=1M#chart`
- `?s=PTT&source=infoquest&newsPage=12#news`
- `?watchlist=list-2&watchPage=4#watchlist`

Only a Watchlist identifier and page are stored in the URL. Stock lists, account identifiers, email addresses, tokens, and credentials are never serialized. Invalid or stale parameters fall back to canonical defaults, and automatic refresh does not add history entries or reset the current page.

## Data and usage limitations

Data availability, retention depth, redistribution rights, and update timing depend on third-party providers. Headlines link to publisher stories, and headline sentiment is a lightweight informational hint rather than full-article analysis or investment advice.

Missing, partial, delayed, stale, or rejected data must not be presented as fresh or silently converted to zero. Users should verify important market information with an authorized primary source before making financial decisions.
