# SETscope — Global Codex Rules (Compact)

**Governance:** v1.3 APPROVED/EFFECTIVE 2026-10-21 · **Simplified by Owner:** 2026-10-26 · **Compact revision:** 2026-11-06\
**Scope:** SETscope v1.5.x+ only within approved release scopes. **Master:** `/SETscope/Codex_Global_Rules/SETscope_Global_Codex_Rules.docx` (binding). **Companion:** approved Public Disclosure / PR Gate v1.0.

**Code First — Evidence Sufficient — Documentation Minimal.** Govern coding/testing, not paperwork. Governance approval ≠ permission for features, PR audits, repo migration, production edits, merge or deploy.

**Scraper First — Code First — Fix Fast.** For approved data-acquisition work, prioritize usable, accurate data: Codex may inspect, experiment, adjust parsers, fix defects, and run focused tests autonomously without extra routine approval or paperwork. “Scraper First” means practical acquisition, not forcing scraping over a suitable API. Respect actual access restrictions, preserve working modules and data truth, then **Fix → Verify → Owner-approved Release**.

**Project decision order:** explicit Owner approval → approved Global Rules → approved SSOT/hotfix → technical choices. Roadmaps/history/newer versions grant no authority. This project decision order does not override applicable law, service terms, privacy or security obligations. Handle specific problems where they arise; do not halt unrelated work. Verify current SHA, CI and production status as relevant.

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

### 6. Data Acquisition First — Pre-v1.5.0 Development Model
**Codex must actively pursue every reasonable, lawful and technically practical method to bring real, accurate data into SETscope**, using the agile pre-v1.5.0 development approach as its working model. Review historical code and previously working acquisition paths first, but verify them against current provider behavior; old code is a reference, not proof that a method still works.

Within the **Owner-approved scope**, Codex should independently investigate, prototype, fix and test suitable options such as HTML parsing, normally accessible APIs, structured data/JSON-LD, RSS and ordinary browser-based retrieval. Adapt parsers when pages change; restore historical news, implement checkpoints or fallbacks when within scope. Use small, bounded Live Smoke checks when useful, without repetitive Rights Gate checklists or extra routine approval. Diagnose `ACQUISITION_GAP`, `SOURCE_NO_DATA` and `PARSER_MISMATCH`; if one path fails, try another legitimate path, continue offline fixes and report Live status truthfully. **Live NOT VERIFIED alone must not halt the patch.**

**Scraper First — Code First — Fix Fast:** prioritize working data and focused regression tests over paperwork. Never invent data, evade authentication/paywalls/CAPTCHA or bypass actual access controls and 401/403/repeated 429. Respect applicable law/terms, stop a genuinely prohibited acquisition path, and continue safe alternatives. This rule does **not** approve out-of-scope features, private/paid access, production scheduling, merge or deploy; those remain Owner-controlled.

### 7. Data truth, provenance and persistence
Never fabricate market data, OHLC, rankings, news, identity, coverage, timestamps or rights. Preserve raw/source fidelity, mapping, units, session/as-of. Delay ≠ error; shadow mismatch is investigation evidence, **not** automatic quarantine/source switch unless SSOT requires. Reject proven invalid fields only.

Label FRESH/DELAYED/STALE/UNAVAILABLE; respect LKG limits. No silent loss of Security Master, News Archive or checkpoints on transient failures. Retention per approved module; no hardcoded coverage or weakened OHLC guard.

## Domain 3 — Architecture, Reliability & Migration

### 8. Fault isolation and bounded recovery
Isolate Overview/Chart/News/Watchlist/Auth/Coverage providers, validation, caches, APIs and UI. Failure degrades only affected fields, not other modules. Use kill switches, circuit breakers, bounded retry/backoff, coalescing and durable checkpoints; no retry/restart loops or data loss. **Flag OFF = no hidden fetch.**

Approved versions may extend adaptive/multi-source/fallback adapters without needless rewrite. **v1.5.3 Overview-only/shadow-only is version-scoped**, not a ban on approved later work; shadow timing mismatch must not blank healthy output.

### 9. Operations, interfaces and migration safety
Keep approved Keepalive/scrapers working. **Routine bounded Live Smoke within an approved development scope requires no separate traffic-approval step.** New production jobs/schedulers/true real-time stay **OFF** until Owner approval for activation. Use reasonable request/cost limits; check Render auto-deploy triggers before commit/merge. No unapproved production environment, secrets, schema/RLS/grants, writes or deployment changes.

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
**Keep proportionate testing:** run relevant targeted/regression checks and appropriate full-suite, syntax/types and `git diff --check`. For Scraper/Provider changes, test affected behavior with fixtures and run a few bounded Live Smoke calls when useful and feasible; Live is **not a universal gate**. Report two separate outcomes: **Technical PASS/FAIL/NOT RUN** and **Live VERIFIED/NOT VERIFIED**. Missing live evidence does not turn Technical PASS into FAIL or stop offline coding/PR preparation. Report missing evidence and actual failures truthfully. CI PASS ≠ Production PASS.

Concise handoff: SHA, scope/files, root cause/outcome, test evidence, source/request/security/data impact, risks, app/data rollback and PR/deploy gate. **Owner alone approves merge/deploy/risky migration/closure**; no auto-merge/deploy. CI/security scan edits need approved scope.

### 13. Targeted incident handling and controlled Living Rules
**Do not STOP the entire patch** merely because a source is inaccessible, a Live Smoke attempt cannot finish or Live remains NOT VERIFIED. Mark the affected source unavailable and continue independent in-scope fixes and tests. For a real security/privacy leak, unsafe data, destructive migration, unauthorized production change or severe regression, contain the affected operation and inform Owner. Never hide a genuine failure or attempt to evade access controls.

Binding policy changes need Owner approval and a dated change record. Owner direction on 2026-11-06 simplifies project decision order, acquisition, in-scope Live Smoke, testing and source-unavailability handling; formal Rights Gate and mandatory Rule 12A remain retired. Owner-approved Rule 6 replacement uses Data Acquisition First (the pre-v1.5.0 working model). The governing Word Master in Library was updated separately. Frozen records stay immutable; no change here authorizes auto-merge/deploy.

**Scope:** v1.5.3 = Overview only; v1.5.8 = research/proposals, not implementation approval. No private-repo move or reopen of v1.5.3.2 (CLOSED/FROZEN). Historical change log remains in Word Master.
