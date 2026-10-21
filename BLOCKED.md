# Growth G2 blocked — 2026-10-21

Stopped under the user's repeated-failure rule and the plan's external build-failure stop condition. Implementation is incomplete and must not be treated as ready.

## Completed

- Removed the previous BLOCKED.md, completed the G1 merge (6e152825), and ran bun install / Prisma generation successfully.
- Added tenant-scoped customer aggregate SQL, churn calculation, existing pharmacy Rx/dose-parser reuse, bulk upserts of 500, local-day scheduling and lastMetricsRunAt migration.
- Focused growth/tick/existing refill suite: 4 files, 41 tests passed before the PostgreSQL fixture test was added.

## Blocking evidence

- PostgreSQL fixture test failed on both executions. First: PostgreSQL could not infer the timestamp type in the 90-day subtraction. Added explicit timestamp casts. Second: refill date assertion expected 2026-11-19T00:00:00Z but received 2026-11-18T19:00:00Z. The test's pg timestamp parser uses the process timezone (Asia/Karachi); fixture literals are timestamp without timezone. No further fix attempted after the repeated failure.
- bun run build: Prisma generation succeeded; Next 16.2.12 reached optimized production compilation, then the process was terminated by SIGKILL. No source diagnostic was produced. Host memory pressure was observed; the exact cause of the kill is unconfirmed. Did not retry.
- bun run typecheck: default Node heap exhausted at approximately 4 GB. Retried with NODE_OPTIONS=--max-old-space-size=8192; cancelled while still running when the stop condition was reached. No successful typecheck result.
- bun run lint: cancelled while still running at the stop condition; no completed result.
- bun run test (full): still running at stop; reported an unrelated restaurant print-bridge test timeout (rejects sibling branch submission before branch lookup or queue writes). Cancelled; no full-suite result.

## Remaining verification

Resolve the PostgreSQL fixture timezone handling, verify real Prisma/database upserts and rollback/concurrent tick behavior, apply the migration on a disposable database, complete typecheck/lint/full tests/build with sufficient resources. Demo pharmacy tick and 50,000-customer under-two-minute benchmark were not performed. FORCE RLS policies were not changed; runtime SQL and writes use withTenantDb and explicit organizationId.

PR #116 remains draft. No UI or messaging was added. Only improve/ai-growth-g2 is authorized for pushes.
