# English company names for Search

Search prefers an English company name with source and check timestamp from the registry. Exact matches with a reviewed name return without Yahoo enrichment; missing names retain the existing bounded, temporary Yahoo lookup and symbol fallback. Search never persists Yahoo names. Registry names retain source spelling and capitalization rather than inventing a Yahoo-style title case. Existing ranking, response cache and selection behavior remain intact.

The additive migration `supabase/migrations/20261026162359_search_company_names.sql` adds three nullable metadata columns. It has no backfill, coverage-state, RLS or grant changes. Search has a legacy projection fallback for a missing-column response before migration. Deploying or applying SQL requires separate Owner approval.

## Source and offline preparation

The official [SEC listed-company directory](https://market.sec.or.th/public/idisc/en/company/listed/A) supplies factual English names with ticker/profile links. The [SEC Website Policy](https://www.sec.or.th/TH/Pages/Footer/WebsitePolicy.aspx), “Conditions of Use”, permits use, printing and downloading without changing meaning, subject to specific restrictions. This preparation extracts only registry ticker/name facts, keeps attribution and profile references, and does not copy logos, reports or third-party works. The [SEC Open Data portal](https://secopendata.sec.or.th/) separately advertises free commercial and personal use; that statement alone is not treated as a blanket license for other sites. Recheck applicable source restrictions before later collections.

An alternative is SET's [Security Profile and Corporate Action service](https://www.set.or.th/app/online-data/reference-data?lang=en), which explicitly distinguishes internal use and redistribution subscriptions. No subscription or redistribution permission is assumed. Yahoo remains temporary enrichment only.

1. Export a read-only registry snapshot containing `symbol`, `provider_symbol`, `provider`, `active`, `status` and any existing name metadata.
2. Run `node scripts/collect-search-company-names.js registry.json cache-directory candidates.json`. This manual collector caches public directory pages, stops on HTTP failures without retries, verifies ticker text against profile links and reports duplicates/missing mappings. It performs no database operations. Use a new cache directory for a fresh review.
3. Review the candidate names, source conditions and identity evidence. Supply the reviewed `records` array as `reviewed-names.json`. Each record includes `symbol`, `provider_symbol`, `company_name_en`, `name_source`, `name_checked_at`, `identity_evidence`, `rights_evidence`, `storage_allowed` and `display_allowed`. These permission flags record the source review; they do not create legal permission.
4. Run `node scripts/prepare-search-company-names.js registry.json reviewed-names.json output-prefix`. This creates local SQL and a data rollback script only; it never connects to a database. Keep the reviewed input and original name metadata with the private release evidence. Do not commit credentials or connection settings.

Imports update only the three name columns, reject duplicates/mapping mismatches and use a transaction with previous-value guards. A changed mapping or concurrent name update rejects the whole import. Missing candidates remain symbol/Yahoo fallbacks, never fabricated names. The directory review found a historical `THCOM` identity requiring separate review: the [issuer announcement](https://www.thaicom.net/th/) says its symbol became `GST` on 28 September 2026. This hotfix does not rename that registry row or change its verification status.

## Rollback and validation

Prefer reverting the application commit while retaining nullable metadata. Generated data rollback restores only the reviewed prior name values and refuses changed mappings/values. Destructive schema rollback is in `supabase/search_company_names_rollback.sql`; it requires a metadata backup and separate approval. Do not apply schema rollback while name-aware application code is running.

`npm test` and `npm run check` include name, mapping, timeout and 500-symbol regressions. `npm run test:search-names:postgres17` uses an explicitly configured disposable local PostgreSQL 17 database to verify additive migration, existing-row preservation, RLS/grants, atomic imports and rollback. Production migration, import and smoke acceptance remain separate Owner-controlled steps.
