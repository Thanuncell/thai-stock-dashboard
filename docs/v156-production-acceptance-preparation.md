# v1.5.6 production acceptance preparation

The version remains OPEN. Synthetic tests are development evidence, never production acceptance.
`STAGE_PASS` records successful data verification only; product acceptance and closure still require Owner review and production smoke evidence.

| Stage | Production evidence |
| --- | --- |
| 5 | Owner-reported Canary PASS; preserve the original receipt |
| 20 | NOT RUN by this change |
| 100 | NOT RUN by this change |
| 500 | NOT RUN by this change |

After separately approved merge, use **SETscope Manual Scaling** on `main`. Keep Render automation, auto-verify and scheduler OFF. No Render deployment is needed to run the Actions CLI.

1. Select a stage and run `preflight`. Review due/required counts, remaining daily quota, coordinator/checkpoint state, predecessor evidence and frozen identities. An insufficient check starts no job.
2. Obtain Owner approval for that stage and round. Select `run` and enter `RUN COVERAGE <stage>`. Each round runs one to four sequential five-stock jobs, never more than twenty stocks.
3. Confirm the receipt contains the exact source SHA, stage ID, round ID, frozen identities, separate attempted/verified/partial/temporary-failed counts, before/after coverage and bounded requests. Per job: provider <=10, database <=200, deadline <=120 seconds, no automatic retry. Preflight reads count against the first job.
4. For a clean unfinished stage, inspect persisted state, then obtain approval for a new round. Supply the original stage ID and `REVIEWED <stage ID>`. Previously completed stocks are excluded within the stage. Daily reservations remain consumed; wait for capacity or the seven-day cadence when necessary. Every stage shares the same daily ceiling: 4 jobs, provider <=40, database <=800, including other jobs that day. Stage targets 100 and 500 require multiple days; they never increase these limits.
5. Any temporary failure, uncertain result, timeout, crash during a job or failed integrity check stops remaining jobs. Preserve all checkpoints. This workflow does not resume an uncertain job or clear a stopped stage; Owner-reviewed reconciliation is required before any recovery decision.
6. Accept a stage only after its durable ledger contains exactly 20, 100 or 500 distinct fully verified stocks, no partial/temporary-failed results, unchanged out-of-batch data and passing production smoke/account isolation evidence. Stage 100 requires completed Stage 20; Stage 500 requires completed Stage 100. Missing evidence remains NOT RUN or BLOCKED.

Rollback: disable manual dispatch or revert the application change with automation OFF; preserve schema, cadence reservations, stage receipts and checkpoints. Never delete state to make a rerun pass. Owner approval is required for merge, deployment, production execution and final closure.
