# Manual canary verification

The `SETscope Canary Verify` workflow runs only by `workflow_dispatch` on `main`, by the repository owner, with explicit confirmation. It has no schedule, push trigger, deployment or automatic expansion. Merging the workflow does not run it. Owner approval to merge and approval to run remain separate.

Before an approved run, configure `SUPABASE_URL` and `SUPABASE_SECRET_KEY` as GitHub Actions secrets for the approved existing database. Never paste credentials into workflow inputs, logs or artifacts. Secret provisioning and the production run are not performed by this change. Render stays manual-OFF and kill-ON; runner-local settings do not change Render configuration.

The sample is fixed to PTT, SCB, ADVANC, BOL and NETBAY. All five must have the expected existing provider mapping, active/verified status and chart/technical readiness; any mismatch stops before job writes or provider traffic. Verification standards are unchanged. The canary may check early without moving the normal seven-day coverage clock.

Run once, only after approval: choose Actions → SETscope Canary Verify → Run workflow on main; confirm the reviewed commit and enter `CANARY-5`. Results contain aggregate verification/readiness counts and request metrics. A duplicate, skipped or interrupted run fails closed; it is not reported as a fresh successful verification. Do not clear the durable run marker, change tags or reset timestamps to retry. Review uncertainty before any separately approved recovery.

Cancel the Actions run to stop it. SIGINT/SIGTERM and the absolute deadline abort runner requests, including response-body reads. Requests already accepted by the database can have uncertain outcomes; durable checked/in-flight evidence remains for review and is never automatically replayed. This does not undo accepted writes. No post-deadline cleanup request is allowed. The workflow-level timeout is only a fallback; the CLI enforces the shorter absolute deadline and request ceilings.

After completion/cancellation the runner exits. Render remains kill-ON and manual-OFF; no Render environment toggle or redeployment is required. Ordinary app data reads still use existing cache/freshness behavior; a CLI verification result alone is not proof of immediate user-visible cache refresh.

A provider outage may change an attempted stock's status to temporary_failed while preserving existing verified/chart/technical capability evidence. Unrelated stocks must remain unchanged. Compare before/after counts and inspect any difference; never force freshness or reset coverage to hide an error. If the deadline prevents final counts, mark them NOT RUN and inspect durable state read-only.

Production canary and Account Isolation A→B remain NOT RUN until explicitly tested. No schema, RLS, grants, verification standard or frozen closure record changes are required.
