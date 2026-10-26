# SETscope — Global Codex Rules (Compact)

**Governance:** v1.3 APPROVED/EFFECTIVE 2026-10-21 · **Simplified by Owner:** 2026-10-26 · **Compact revision:** 2026-10-26  
**Scope:** SETscope v1.5.x+ only within approved release scopes. **Master:** `/SETscope/Codex_Global_Rules/SETscope_Global_Codex_Rules.docx` (binding). **Companion:** approved Public Disclosure / PR Gate v1.0.

**Code First — Evidence Sufficient — Documentation Minimal.** Govern coding/testing, not paperwork. Governance approval ≠ permission for features, PR audits, repo migration, production edits, merge or deploy.

**Scraper First — Code First — Fix Fast.** For approved data-acquisition work, prioritize usable, accurate data: Codex may inspect, experiment, adjust parsers, fix defects, and run focused tests autonomously without extra routine approval or paperwork. “Scraper First” means practical acquisition, not forcing scraping over a suitable API. Respect actual access restrictions, preserve working modules and data truth, then **Fix → Verify → Owner-approved Release**.

**Precedence:** law/terms/rights/security/privacy/data integrity → explicit Owner approval → Global Rules → approved SSOT/hotfix → technical choices. Roadmaps/history/newer versions grant no authority. On conflict cite clauses, STOP only affected work; continue safe work. Always verify live SHA, CI, closure and production status.

## Domain 1 — Development Governance & Codex Authority

### 1. Read before code
Inspect approvals, SSOT/delta, branch/worktree, exact baseline SHA, tests, contracts/providers, protected modules, flags and deploy triggers. Compare ACTUAL vs EXPECTED; past chats, plans, unmerged branches and old PASS are not current evidence.

### 2. Diagnose before editing
Reproduce if practical; trace code/fixtures/targeted logs. Separate defects, missing prerequisites, outages/denials, time differences and assumptions. Never invent root causes or conceal failures.

### 3. Smallest safe and reversible change
Make the smallest complete reversible in-scope change with tests/compatibility. No unrelated rewrite or unauthorized contract, dependency, schema, permission, runtime or infrastructure edits. Approved future architecture evolution is allowed; preserve rollback.

### 4. Preserve accepted behavior, not bugs
Preserve working Chart/Technical, Overview, News/Archive, Watchlist, Search, Stock Detail, Auth/privacy, navigation/mobile and contracts. Fix confirmed bugs via approved hotfix + regression. Never retroactively rewrite CLOSED/FROZEN SSOT, evidence or approvals.

### 5. Autonomous repair; parallel Codex isolation
For approved work: reproduce → diagnose → patch → targeted/full tests → evidence-based retry. Three failed distinct approaches prompt escalation; STOP gates prevail. Codex owns routine technical decisions.

Parallel Codex: **separate branch + isolated worktree/checkout + named scope/file ownership**. Coordinate shared contracts; never overwrite shared work. Reconcile latest accepted baseline, integrate by reviewed PR, retest.

## Domain 2 — Source Rights & Data Integrity

### 6. Simple, responsible data acquisition (no Source Rights Gate)
**Do not require a Source Rights Gate, rights checklist, approval form, or repeated pre-clearance** for routine scraper/provider development. Work directly on the approved feature: inspect code, use existing data/fixtures, fix the issue, and test. This Governance rule does not authorize new production jobs, new paid/private access, or deployment.

Use sources normally and respect applicable law/terms and clear access restrictions. **Never bypass** login, paywalls, CAPTCHA, access controls, 401/403 or repeated 429 by proxy/IP/account/cookie rotation. If a source actually denies access or clearly prohibits the activity, stop **only that acquisition path** and continue offline/other approved work. Distinguish `ACQUISITION_GAP`, `SOURCE_NO_DATA`, `PARSER_MISMATCH`; use cache/reasonable rate limits and avoid repeated failing calls. No separate rights evidence packet is required for ordinary work.

### 7. Data truth, provenance and persistence
Never fabricate market data, OHLC, rankings, news, identity, coverage, timestamps or rights. Preserve raw/source fidelity, mapping, units, session/as-of. Delay ≠ error; shadow mismatch is investigation evidence, **not** automatic quarantine/source switch unless SSOT requires. Reject proven invalid fields only.

Label FRESH/DELAYED/STALE/UNAVAILABLE; respect LKG limits. No silent loss of Security Master, News Archive or checkpoints on transient failures. Retention per approved module; no hardcoded coverage or weakened OHLC guard.

## Domain 3 — Architecture, Reliability & Migration

### 8. Fault isolation and bounded recovery
Isolate Overview/Chart/News/Watchlist/Auth/Coverage providers, validation, caches, APIs and UI. Failure degrades only affected fields, not other modules. Use kill switches, circuit breakers, bounded retry/backoff, coalescing and durable checkpoints; no retry/restart loops or data loss. **Flag OFF = no hidden fetch.**

Approved versions may extend adaptive/multi-source/fallback adapters without needless rewrite. **v1.5.3 Overview-only/shadow-only is version-scoped**, not a ban on approved later work; shadow timing mismatch must not blank healthy output.

### 9. Operations, interfaces and migration safety
Keep approved Keepalive/scrapers working. New jobs/schedulers/true real-time stay **OFF** absent approval. Enforce budget/cost limits. Check Render auto-deploy triggers before commit/merge, even docs. No unauthorized live traffic, env/secrets, schema/RLS/grants, writes or deploy.

Preserve forward/backward migrations, schema/RLS/history, API aliases/contracts, Build/CI, vendor portability and app/data rollback. Public/Private split needs separately approved design and tested integration; **never erase migrations/history to conceal internals**.

## Domain 4 — Security, Privacy & Information Disclosure

### 10. Classification and Disclosure Gate
Before publication classify branch/commit/PR, diff/code, README/CHANGELOG, docs, logs and artifacts:

- **PUBLIC:** accurate product/change, rights/attribution, test status and risk.
- **INTERNAL:** parser/provider internals, architecture, budgets and technical evidence; restricted workspace.
- **RESTRICTED:** exploitable controls, sensitive operations/personal data; least-privilege only.
- **SECRET:** credentials, tokens, passwords, signing keys/cookies; **never** in any Git/docs/logs/PRs/artifacts. Use secret store.

Run approved **Public Disclosure / PR Gate v1.0** on diffs, branches/commits/PRs, docs/logs/artifacts with secret scan and contextual review. Public wording: outcome, compatibility, *actual* tests, material risk, rights/attribution and rollback; omit internal thresholds, provider weaknesses, access-control mechanics, IDs and scraper playbooks unless necessary/approved. PR brevity does not hide public code. Secret leak → STOP and escalate rotation; no unapproved history rewrite/force push. Docs-only must remain docs-only.

### 11. Code First; concise, truthful evidence
Code/tests first. Public PR/README/CHANGELOG: brief change, truthful PASS/FAIL/NOT RUN, material risks, release/rollback and required user/operator/rights information. Keep detailed evidence private for authorized review; do not conceal failure. Old-PR audits never authorize history/SSOT rewrites.

## Domain 5 — Verification, Release & Recovery

### 12. Test, acceptance, release and rollback
Run proportional targeted/bug regression tests and relevant full-suite, syntax/types and `git diff --check`. For scraper/provider changes, test the affected request/response behavior with fixtures first; use a few live calls **when feasible and permitted**, not as a universal release blocker. If live verification cannot run, label it NOT RUN and state the material uncertainty; do not pause offline development or demand an extra rights/risk-acceptance ceremony. Record SHA/environment/counts and truthful **PASS/FAIL/FIXING/BLOCKED/NOT RUN**; CI PASS ≠ Production PASS.

Concise handoff: SHA, scope/files, root cause/outcome, test evidence, source/request/security/data impact, risks, app/data rollback and PR/deploy gate. **Owner alone approves merge/deploy/risky migration/closure**; no auto-merge/deploy. CI/security scan edits need approved scope.

### 13. STOP and controlled Living Rules
**STOP affected work** on security/privacy leak, source denial/access restrictions, unsafe data, unauthorized production/scope/deploy, destructive migration, RLS/grant risk, severe regression or authority conflict. Contain, report, mark BLOCKED; continue independent safe tasks. Never bypass STOP.

Binding policy changes need Owner approval and a dated change record. The Owner simplified the rules on 2026-10-26: the formal Source Rights Gate and mandatory Rule 12A Provider Change Verification Gate are **retired**. The 2026-10-24 12A amendment remains historical evidence, not an active test checklist. Library file ≠ GitHub sync: repo-root `AGENTS.md` update requires approved publish/Disclosure Gate; re-read in ongoing sessions. Frozen records immutable; only approved scoped deltas.

**Scope:** v1.5.3 = Overview only; v1.5.8 = research/proposals, not implementation approval. No private-repo move or reopen of v1.5.3.2 (CLOSED/FROZEN). Historical change log remains in Word Master.
