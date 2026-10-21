# SETscope v1.5.3 Market Overview verification record

## Execution baseline

- Active execution specification: SETscope v1.5.3 Market Overview Completion and Reliability FINAL v6.
- Baseline: `main` at `96c65564659982bbff33cfef5542790a39bd5bb3`.
- Working branch: `codex/v1.5.3-market-overview`.
- v1.5.2.x through v1.5.2.3 remain closed and frozen.
- Scope is Market Overview only. Chart, Technical, Yahoo Coverage, News, publisher extraction, News Archive, Watchlist, Authentication, and Stock Detail remain behaviorally unchanged.

## Architecture and request budget

Before v1.5.3, each cache miss fetched five SETTRADE pages concurrently and the shared cache expired after 60 seconds. A force refresh bypassed that cache. Most Active was hard-coded to an empty array and TFEX exposed only an availability boolean.

After v1.5.3, the neutral `/api/market-overview` route uses a Market Overview orchestrator and a thin SETTRADE provider adapter. The old `/api/settrade-overview` route remains a compatibility alias. The same five upstream pages are retained; no new upstream data endpoint is added. Requests are provider-queued with default concurrency 1, 250 ms minimum spacing, a configurable shared budget of 7 attempts per 5 minutes, bounded retries, backoff, circuit breaking, and request coalescing. The cache interval is aligned to the existing five-minute browser polling cadence. Manual refresh cannot bypass the shared cache or provider safety controls.

Request count per normal refresh cycle remains 5 before and 5 after. Useful structured yield increases when the existing response contains readable Most Active or TFEX data. When the current SSR response contains placeholders only, those fields remain explicitly unavailable rather than triggering another private or undocumented request.

## Failure isolation and lightweight seven-layer verification

1. Source guard permits only HTTPS `settrade.com` and `www.settrade.com`, including the final redirect URL.
2. Page identity guard verifies each response is the intended Overview, NVDR, investor-flow, TFEX, or Most Active page.
3. Schema guard maps semantic headers and degrades only the affected field when required labels are absent.
4. Numeric and market guard rejects deterministic invalidity such as negative volume/value, impossible low/high order, invalid rank, or an unexpected unit header. Missing values remain null/empty.
5. Cross-source comparison is evidence-only. It cannot replace, quarantine, or alter the operational SETTRADE result.
6. Freshness retains source/effective timestamps and identifies last-known-good values as stale; delayed data remains valid.
7. Field-level publish decisions keep healthy fields visible independently and return `PASS`, `LKG`, or `UNAVAILABLE` metadata per field.

The manual kill switch is `MARKET_OVERVIEW_SCRAPER_ENABLED=false`. Shadow comparison defaults off through `MARKET_OVERVIEW_SHADOW_API_ENABLED=false`. HTTP 401/403, CAPTCHA, bot challenge, login/access-denial content, or equivalent explicit denial sets `MANUAL_REVIEW_REQUIRED` for the process lifetime. HTTP 429 opens an extended backoff. Repeated 5xx/timeouts use bounded retries and one half-open probe after cooldown. Parser/schema failure never causes compensating requests.

## Structured data status

- SET and mai index details, breadth, closing summary, NVDR, and foreign flow remain parsed from the existing responses.
- Most Active now has a semantic structured parser and a SETscope-owned table renderer inside the existing card. It publishes rows only when the normal page response contains a complete, valid table.
- TFEX now has a structured parser for Total Market volume, open interest, investor type, and top-volume rows. Each subfield remains independently null/empty when the normal response does not contain it.
- Current live SSR responses observed during implementation contained placeholders for Most Active and no current TFEX values. Their production verification state therefore remains `UNVERIFIED` until an authenticated exact-commit smoke can observe valid source rows. No private endpoint was reverse-engineered or added to fill the placeholders.

## API candidate comparison researched 2026-10-21

| Candidate | Cost classification | Documented relevant coverage | Trust and rights note | Runtime result | Recommendation |
| --- | --- | --- | --- | --- | --- |
| SET SMART Marketplace | PAID | Official SET and TFEX APIs include delayed/real-time indices, equity snapshots, EOD data, and investor categories | Official source; API key and subscription required. The published delayed/real-time market-data fee is not a 0-THB production entitlement. | No credential available; no runtime call | Official future candidate or benchmark; do not replace in v1.5.3 |
| Twelve Data Basic | FREE overall, Thailand entitlement UNVERIFIED | Official site advertises 800 requests/day and global equities; current Basic pricing lists only three markets plus global trial symbols | API key required. Exact Thai SET/mai, breadth, NVDR, investor-flow, TFEX, and redistribution/display rights are not proven by the public Basic-plan material. | No credential available; no runtime call | Research candidate only; not safe to shadow or replace yet |
| Alpha Vantage free key | FREE overall, field coverage UNVERIFIED | Official docs offer global single-symbol time series/quotes and 25 requests/day | Thai exchange symbols, market-wide breadth, NVDR, investor flow, TFEX, and SETTRADE-equivalent rankings are not documented as covered. Commercial use requires separate rights review. | No credential available; no runtime call | Reject as a Market Overview replacement; possible future symbol-level research only |
| Thai SEC Open API | FREE but non-matching scope | Official portal currently exposes regulatory/open-data products; the visible service catalog does not provide the required live Market Overview datasets | Official source, but not a substitute for exchange market data | Not called | Reject for v1.5.3 fields |

Primary documentation reviewed:

- SET SMART Marketplace: https://www.set.or.th/en/services/connectivity-and-data/data/smart-marketplace
- SET market-data pricing: https://www.set.or.th/app/online-data/market-data?lang=en
- SET Market Data API specification: https://media.set.or.th/set/Documents/2023/May/Market_Data_API_Service_Specification.pdf
- Twelve Data pricing: https://twelvedata.com/pricing
- Twelve Data stock coverage: https://twelvedata.com/stocks
- Alpha Vantage documentation and limits: https://www.alphavantage.co/documentation/ and https://www.alphavantage.co/support/
- Thai SEC API catalog: https://api-portal.sec.or.th/apis

## Field-by-field decision matrix

| Field | Operational source | Candidate evidence | Timing and coverage | Verification | Recommendation |
| --- | --- | --- | --- | --- | --- |
| SET Index | SETTRADE scraper | Official SET paid API; free candidates unverified | Delayed source context | Fixture PASS; live smoke pending | KEEP |
| mai | SETTRADE scraper | Official SET paid API; free candidates unverified | Delayed source context | Fixture PASS; live smoke pending | KEEP |
| Market Breadth | SETTRADE scraper | No verified 0-THB equivalent | Current page response | Fixture PASS; live smoke pending | KEEP |
| Investor Flow | SETTRADE scraper | Official SET paid/EOD API candidate | Source market date retained | Fixture PASS; live smoke pending | KEEP |
| NVDR | SETTRADE scraper | No verified 0-THB equivalent | Source page values | Fixture PASS; live smoke pending | KEEP |
| TFEX | SETTRADE scraper | Official SET/TFEX paid API candidate | 15-minute delayed labels retained | Parser PASS; live structured values UNVERIFIED | KEEP, field-level unavailable when absent |
| Top Value / Most Active | SETTRADE scraper | No verified 0-THB SET ranking equivalent | Existing response only; no extra endpoint | Parser/UI PASS; live rows UNVERIFIED | KEEP, publish only verified rows |
| End-of-Day Summary | SETTRADE scraper | No verified equivalent preserving the same summary | Available after market close | Fixture PASS; live smoke pending | KEEP |
| Top Gainers | Not displayed in v1.5.3 | Alpha Vantage endpoint is not proven SET-equivalent; no verified free source | No existing intended card | UNVERIFIED | DEFER visible presentation |
| Top Losers | Not displayed in v1.5.3 | Alpha Vantage endpoint is not proven SET-equivalent; no verified free source | No existing intended card | UNVERIFIED | DEFER visible presentation |

## Rollback readiness

The application rollback is a normal revert of the v1.5.3 commits or redeploy of baseline `96c65564659982bbff33cfef5542790a39bd5bb3`. The existing parser/service path and `/api/settrade-overview` compatibility route are retained. No database schema, RLS policy, secret, environment value, provider entitlement, scheduler, polling interval, or production real-time setting is changed, so rollback requires no data migration.
