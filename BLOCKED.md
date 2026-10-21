# PR #245 repair verification blocked

Stopped after two failed focused DB verification attempts, as instructed.

Branch: fix/migration-rls-218. No merge or force-push.

Implemented but not fully verified:
- MFA and catalogue permission replay migrations are intentional no-ops.
- Package cleanup preserves NULL-reason pins.
- Branch assignment replay only targets organizations with no assignment rows.
- Outbox cleanup removes nested meta.secret.
- Department conflict handling explicitly targets (organizationId, key); name collisions abort.
- New transactional repairs normalize invitation emails and clear PENDING delivery paymentMode.
- Delivery repair iterates organizations with transaction-local tenant scope because this
  table's FORCE RLS policy does not admit the platform-admin flag.

Verification:
- Fresh migrations successfully deployed twice to a disposable PostgreSQL 17 database,
  owned by repair245_owner (NOSUPERUSER NOBYPASSRLS).
- Focused command: TZ=UTC TMPDIR=/tmp MIGSWEEP_DATABASE_URL=<disposable-owner-url>
  bun run test tests/migration-rls-sweep.db.test.ts --maxWorkers=1
- Attempt 1 failed seeding delivery fulfillments: tenant-only RLS policy rejected the row.
  Added tenant scope to fixture/counts and organization iteration to the new repair.
- Attempt 2 failed with ReferenceError: pass is not defined at
  tests/migration-rls-sweep.db.test.ts:92. A scripted edit inserted the replay-only fixture
  block before the pass loop as well as inside it. No third attempt was made.
- Row-count assertions have NOT passed. Typechecks were NOT run because the stop limit
  was reached. Existing docs/verification/migration-rls-218.md describes the previous
  commit and must not be treated as evidence for these partial changes.

Remaining work:
- Remove the unintended pre-loop pass block and rerun on a clean disposable database.
- Expand preservation coverage for partially assigned organizations and department collisions.
- Add the two missed silent writes to the evidence table, replace stale MFA/grant claims,
  and record newly verified row counts.
- Run typechecks sequentially with TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144:
  bunx tsc --noEmit, then bun run typecheck.
- Commit verified completion only after the focused DB regression passes.
