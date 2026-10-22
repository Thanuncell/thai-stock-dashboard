# SETscope — Global Codex Rules

**Governance:** v1.3  
**Prepared:** 2026-10-21  
**Effective:** 2026-10-21  
**Status:** APPROVED — EFFECTIVE (Owner approval: 2026-10-21)  
**Scope:** Standing engineering governance for SETscope v1.5.x onward, subject to approved version scope.

> **Approval boundary:** The Owner explicitly approved Governance v1.3 on 2026-10-21. It supersedes v1.2 as the standing rules. Approval of these rules does **not** authorize a feature implementation, PR-history audit, public-document cleanup, GitHub change, production modification, repository migration, or release. Before executing v1.5.3.2, Codex must read the approved v1.3 and the authorized task scope; v1.5.3 Acceptance/CLOSED remains the prerequisite to starting that hotfix.

## Purpose, authority, and precedence

Codex's primary job is to **write and improve code, diagnose bugs, and verify working behavior**. Governance exists to make that work safe, not to generate unnecessary documentation. These 13 numbered rules preserve the substantive safeguards of v1.2, reorganized into five domains with clearer controls for multi-Codex work, data acquisition, migrations, and public information disclosure.

**Conflict order:** (1) applicable law, service terms, source rights, security, privacy and data integrity; (2) explicit owner approval within those constraints; (3) currently approved Global Codex Rules; (4) applicable approved version SSOT and explicitly approved scoped hotfix/delta; (5) implementation preferences. When a genuine conflict exists, identify the clauses and evidence, stop only affected work, and continue independent authorized work. Newer version numbers, historical notes and plans are not automatic approval.

**Live status rule:** Before work, verify current accepted main SHA, actual CI, release/closure evidence and production state. Do not embed a historical claim about which release is currently complete in standing governance. A document marked FINAL is not evidence that code is deployed, accepted or CLOSED.

## Domain 1 — Development Governance & Codex Authority

### 1. Read before code

Read the approved task and relevant SSOT/delta, current repository instructions, branch/working-tree status, exact baseline SHA, relevant tests, production deploy triggers, contracts, data providers and protected modules. Compare ACTUAL with EXPECTED behavior. Never replace current evidence with a previous chat, roadmap, speculative architecture or stale test report. A new scope begins only after its explicit prerequisites are satisfied.

### 2. Diagnose before editing

When reasonably possible, reproduce bugs and determine root cause using code, fixtures and narrowly scoped evidence. Distinguish reproducible bugs from missing prerequisites, provider outages, ambiguous source comparisons and assumptions. Do not invent explanations, suppress failed observations, or interpret a different market timestamp as automatic evidence of corrupted data.

### 3. Smallest safe, reversible in-scope change

Implement the smallest complete solution for the **approved scope**, including compatible integration and tests. Avoid unrelated refactors and unauthorized changes to source contracts, dependencies, data schemas, runtime, permissions, infrastructure or release settings. This rule permits larger architectural change when separately approved; it must not become a permanent ban on future provider adapters, scraping, or migration. Prefer additive interfaces and an explicit rollback path.

### 4. Protect accepted behavior, not confirmed defects

Preserve accepted working Chart/Technical, Market Overview, News/Archive, Watchlist, Search, Stock Detail, Auth/privacy, URL/navigation, mobile and data contracts. Confirmed older bugs may be fixed through an approved scoped delta/hotfix; add regression coverage and keep unaffected modules working. Never rewrite frozen SSOT, previously accepted release evidence or past approval history merely to make documentation appear consistent.

### 5. Autonomous repair and parallel Codex ownership

Within approved scope, Codex should reproduce → diagnose → patch → targeted test → regression → retry with an evidence-based change if needed. Do not ask the owner to decide routine implementation details; three distinct unsuccessful repair approaches are an escalation checkpoint, not permission to loop or override a STOP gate.

If two Codex chats/agents work concurrently, each must have an **independent branch AND isolated checkout/worktree**, a named scope and explicit ownership of files or modules. Before touching a shared contract or file, identify dependency and coordinate ownership; no concurrent edits to the same working tree or blind cherry-picks/overwrites. Integrate through reviewed PRs against the latest accepted baseline, rebase/reconcile conflicts before testing, and never assume separate chats provide isolation on their own.

## Domain 2 — Source Rights & Data Integrity

### 6. Authorized, bounded source acquisition

Scraping, public structured sources, documented APIs, and bounded rendered acquisition are potential **research and implementation options**, not blanket permissions. For each source/method, pass a **Source Rights Gate**: access authorization, terms/redistribution rights where relevant, permitted content, request limits, provenance, and handling of access denials. Do not bypass authentication, paywalls, CAPTCHA, bot challenges, access controls, robots/contractual restrictions, or 401/403/repeated 429 using proxy/IP/account/cookie rotation or other evasion. Stop denied source acquisition and escalate; research alone never authorizes production traffic or a provider switch.

Treat `ACQUISITION_GAP`, `SOURCE_NO_DATA`, and `PARSER_MISMATCH` as distinct diagnoses. Choose a permitted next step based on evidence. Prefer extracting valid data from already approved responses before adding upstream traffic. Apply global per-provider budgets, caching/coalescing, conservative concurrency and cooldown before expanding requests.

### 7. Truthful data, provenance, and persistence

Never fabricate or infer unavailable prices, OHLC, volume, breadth, rankings, identity, coverage, article content, timestamps, provider authorization or market data. Preserve raw/source fidelity, field mapping, units, market session/effective time, original provider and source metadata; never silently relabel one provider's values as another's. Delayed or differently timed data is not automatically wrong. Shadow/reference mismatches are investigation evidence, not an automatic production quarantine or switch unless the **approved version** explicitly requires one; proven invalid mapping is handled at the affected field boundary.

Use truthful FRESH/DELAYED/STALE/UNAVAILABLE (or version-approved equivalent) and approved last-known-good limits. A transient upstream failure must not silently erase accepted Security Master state, news archives or durable checkpoints. Retention is scoped per module, never a universal unapproved expiry. Protect data accuracy and recovery ahead of superficial UI completeness.

## Domain 3 — Architecture, Reliability & Migration

### 8. Isolation, adaptive evolution, and bounded self-recovery

Maintain separate failure domains for Market Overview, Chart/Technical, News/Archive, Watchlist, Auth, Coverage and future scraper modules. One parser/provider/source failure must not cascade to unrelated modules. Use validated field-level degradation, provider-specific kill switches/circuit breakers, bounded retries/backoff, idempotent recovery, cache reuse, checkpoints and recovery without restart loops or silent data loss. A disabled feature makes zero hidden upstream calls.

Approved future versions may introduce multi-source/adaptive parsing, fallback or rendered acquisition by extending safe adapters; do not force a rewrite of working providers merely to adopt the future architecture. Keep version-specific restrictions specific to their version: v1.5.3 is Market Overview-only; it does **not** permanently forbid authorized v1.5.7/v1.5.8 work. A candidate free API in v1.5.3 remains SHADOW until future authorization, and ordinary timing differences must not break healthy Overview output.

### 9. Operations, interface compatibility, and migration preservation

Preserve accepted keepalive and operating scrapers; new autonomous jobs, source refresh schedulers and production true real-time remain OFF unless explicitly approved. Respect Render auto-deploy triggers: a change to main can initiate deployment even for documentation-only commits. Never make unapproved production changes, schema/RLS/grants/security-key updates, source traffic expansions or destructive operations. Ensure bounded request budgets and cost awareness on free/limited services.

Protect forward/backward migrations, schema history, RLS, application/data recovery, interface contracts, provider-neutral routes/compatibility aliases, Build/CI integration and vendor portability. A Public/Private repository split is a future **approved architecture choice**, not automatic permission to move files or erase history. Preserve migration paths and rollback before moving scraper implementation or private docs; verify that the remaining public code, private code, build process and service integration can still operate together. Never delete historical migrations solely to reduce the public repository's apparent detail.

## Domain 4 — Security, Privacy & Information Disclosure

### 10. Information classification and Disclosure Gate

Classify content **before it enters Public Git, PR title/body/comments, README, CHANGELOG, docs, logs, test artifacts or commit metadata**:

- **PUBLIC:** necessary accurate feature/change summaries, user-facing capabilities and safe release information.
- **INTERNAL:** parser/provider internals, architecture details, dependency maps, request budgets and detailed technical evidence; store in approved restricted-access project materials, not public docs by default.
- **RESTRICTED:** exploitable security details, access boundaries, confidential operational specifics and personal/customer data; least-privilege storage and reviewer access only.
- **SECRET:** credentials, passwords, signing keys, access tokens and private keys; never put in a Public **or Private** Git repository, documents, issue/PR text or logs. Use authorized secret storage.

Before public submission, apply a **Disclosure Gate** to changed files, diffs, README/CHANGELOG/public docs, PR descriptions, comments, commit messages and relevant artifacts; use automated secret scanning where available and manual context review for sensitive but non-secret content. Review whether public **source code itself** reveals internals; shortening PR wording cannot hide publicly committed implementation. A suspected credential leak triggers immediate security escalation and authorized containment/rotation, without waiting for routine PR-history audit completion. Do not rewrite public commit history or force-push absent a separately approved incident response procedure.

### 11. Code First; minimal but truthful public documentation

Prioritize implementation, bug fixes and meaningful tests over report volume. Use concise, truthful, task-specific PR titles and bodies: **what changed, what was tested (actual PASS/FAIL/NOT RUN), known material risks, and release/approval status**. README and CHANGELOG explain user-relevant behavior and necessary setup, not detailed private architecture. Do not remove information essential to reviewers, licenses/source-rights compliance, user safety or operators solely to make public text shorter.

Retain detailed security/test/migration/rollback evidence privately **only as needed** for authorized reviewers; never falsely claim a test was executed or conceal a significant failure. PR #1 through the chosen audit cutoff may be examined under v1.5.3.2, but audit does not itself authorize modifying old PRs, rewording historical acceptance evidence, changing code or deleting history. Historical publication cannot be undone merely by editing an old PR description.

## Domain 5 — Verification, Release & Recovery

### 12. Test, acceptance, release, and rollback gates

Run appropriate targeted tests, explicit regression for fixed defects, relevant full suite, syntax/type and `git diff --check`, plus environment-specific smoke tests when accessible. Confirm cross-module isolation and contract/navigation/mobile behavior where touched. Start with mocks/fixtures and bounded provider/production requests. Report evidence honestly as PASS / FAIL / FIXING / BLOCKED / NOT RUN; local/CI success is not equivalent to authenticated production smoke.

Before an approval request, provide a **concise handoff** covering baseline/final SHA, approved scope and changed files, root cause or development purpose, test outcomes, security/data/source/request-budget impact, material limitations, app rollback vs database/data recovery, and exact PR/deploy gate. The owner alone approves merge, production deploy, high-risk migrations and release closure; no autonomous auto-merge, independent deployment or configuration changes. A CI/secret-scan workflow change is a code/operations change and needs an approved scope, even if proposed during a documentation cleanup.

### 13. STOP conditions and controlled living rules

STOP **only affected work** for security/privacy incidents, source denial or prohibited acquisition, provably untrusted data, unauthorized scope/production actions, destructive or irreversible migrations, credential/RLS/grant risk, unapproved deploy, severe cross-module regression or unresolved authority conflict. Contain safely, label BLOCKED honestly, and continue independent in-scope work when possible; do not bypass stop conditions to meet a deadline.

These 13 rules are a controlled living policy. Binding changes require explicit owner approval, with trigger, old/new wording or a clear mapping, impact/risk analysis and dated change log. Keep the canonical Markdown and Word copies substantively identical and retain stable filenames in the same Library folder. Owner approval activates v1.3 as standing governance; the Library update alone does **not** sync rules to GitHub AGENTS.md or existing Codex sessions. Each Codex task must read the approved rules explicitly. An approved hotfix alters only its named version/scope; never retroactively overwrite closed SSOT or grant Codex additional deployment authority. Periodically verify current baseline instead of hardcoding release status in this policy.

## Version-scope interpretation (informative, not an implementation order)

- **v1.5.3 FINAL v6:** Market Overview completion and reliability only. Keep working Settrade scraping, Node.js/CommonJS runtime, existing Overview shell and current Chart/News/Watchlist flows; use new neutral Overview route with a compatibility alias when approved by that SSOT. Free API research/shadow cannot replace live data; the Hard Data Accuracy Gate is a **release/smoke** check, not an automatic runtime cross-provider quarantine. Preserve request safety and stop on access denial.
- **v1.5.8 direction:** Research and propose adaptive/multi-source/public structured or bounded rendered acquisition only after Source Rights, provenance, request-budget, no-fabrication, recovery and isolation review. Public/Private scraper separation, exact build composition and migration design are **proposals pending their own approved version SSOT**. Do not read this note as permission to start v1.5.8 implementation.

## v1.5.3.2 governance adoption sequence (implementation plan; owner gates apply)

1. Prepare/update **Governance v1.3** in the existing Library filenames — **completed 2026-10-21**.
2. Obtain **explicit owner acceptance** of v1.3 — **APPROVED 2026-10-21; standing rules effective**.
3. Codex reads the approved v1.3, relevant SSOT, current baseline SHA and authorized scope.
4. Audit public PRs **#1 through the selected current cutoff**, including titles, bodies, visible diffs, selected comments and relevant published documentation; record coverage and limitations without altering history.
5. Classify findings as PUBLIC / INTERNAL / RESTRICTED / SECRET, prioritizing actual exposure and risk.
6. Clean only approved README, CHANGELOG, public docs and safe PR wording; do not alter source code, existing migration, runtime or historical commits as an incidental documentation fix.
7. Run Disclosure Gate, diff review and proportionate regression; verify any CI changes separately if authorized, and protect Render deployment triggers.
8. Submit evidence and risks for owner Acceptance; close **v1.5.3.2** only on explicit approval, after **v1.5.3 itself is accepted/CLOSED**.

If a real SECRET/RESTRICTED incident is discovered, escalate immediately using the security procedure; do not wait until all old PRs have been reviewed. v1.5.3.2 does **not** implement v1.5.8 architecture or move the scraper to a Private Repository.

## Transition map from Governance v1.2 (safeguard preservation)

- v1.2 rules 1–5 → v1.3 rules 1–5 (updated scope, baseline and parallel ownership).
- v1.2 rule 6 → v1.3 rule 12 (evidence/regression).
- v1.2 rule 7 → v1.3 rules 6–7 (source rights, integrity, persistence).
- v1.2 rule 8 → v1.3 rules 6, 8–9 and 12 (request/deploy/operational safety).
- v1.2 rule 9 → v1.3 rule 8 (isolation and scoped scraping evolution).
- v1.2 rule 10 → v1.3 rule 12 (human release and rollback gates).
- v1.2 rule 11 → v1.3 rules 3, 9 and 13 (SSOT scope, portability).
- v1.2 rule 12 → v1.3 rule 13 (precise STOP conditions).
- v1.2 rule 13 → v1.3 rules 10, 11 and 13 (living rules and disclosure).

## Change log

- **2026-10-19 | v1.1:** Controlled living rules, authority/conflict hierarchy; 13 numbered safeguards.
- **2026-10-20 | v1.2:** Clarified scope-vs-release evidence, autonomous repair, rights, isolation, operational safety, stop/rollback and approvals.
- **2026-10-21 | v1.3 APPROVED:** Five-domain reorganization of 13 safeguards; multi-Codex ownership/worktree control, migration preservation, authorized adaptive acquisition, four-class disclosure plus gate, Code First/minimal docs, dynamic release status and the owner-gated v1.5.3.2 adoption sequence. **Owner approval received 2026-10-21; rules effective. v1.5.3.2 execution remains separately gated.**
