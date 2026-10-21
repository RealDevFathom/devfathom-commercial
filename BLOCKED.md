# BLOCKED: PR #163 / #177 integration refresh (2026-10-21)

Stopped under the requested two-SIGKILL rule. The requested outcome is incomplete.

## PR #163: fix/qa-130-capability-names

Merged origin/integration/consolidation-20261019 at
2f6ce748de84783ea0b9743aa0baf6c5e18cfbc2 into original head
a0198847699952a38f1b9211694ff6ff02eb89a0 without rebasing.
Resolved src/lib/abac/index.ts using #163's strict canonical capability matcher
and integration's canonical fail-closed can(). Resolved
src/server/routers/pharmacy-purchasing.ts keeping integration's postGoodsReceipt
staff PIN input, witness verification, and assertProcurement gate.

Validation:
- Focused bun run test --maxWorkers=1, TZ=UTC: 10 files passed, 274 tests passed;
  1 PostgreSQL file / 2 tests skipped because PHARMACY_TEST_OWNER_DATABASE_URL is unset.
  Coverage included ABAC, capabilities, hotel catalog digest/foundation, vertical
  catalog/foundation, owner digest, purchasing router, procurement access,
  controlled purchase witness, and witness enumeration.
- Initial typecheck found stale generated Prisma types following the schema merge.
  bun run db:generate succeeded.
- Both subsequent typecheck attempts were terminated with exit 137 / SIGKILL.
  The second attempt ran alone, without concurrent checks from this task.
  Both used TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck.
  Neither emitted TypeScript diagnostics before termination. Typecheck is NOT green.
- The branch-added 20261021110000 migration timestamp is unique. Integration already
  contains 16 duplicated timestamp prefixes; this merge adds no duplicate timestamp.
- No migrations were applied; no tenant isolation or RLS rules were changed by resolution.

## PR #177: fix/procurement-toggle

Not started because the stop rule was reached in step 1. Its original head remains
f3a662569286918a3ef1e6c99efd57fee39ba726. No branch switch, merge, or push was attempted.

## Resume

Provide enough shared memory for the required 6 GB typecheck, rerun typecheck on
#163, then merge integration into #177 in this worktree, preserve its per-staff
toggle and default pharmacist grants, run focused checks, and push that branch.
Do not merge either PR until required checks pass.

---

Prior integration status (historical; not the validation result of this refresh):

# Status (CTO, 2026-10-21)

Resolved:
- QA138 UI: the controlled authorization panel is hidden when controlledPharmacists is FORBIDDEN
  (actor lacks dispense/safety). counter-console tests render a marker from the panel mock and
  cover cashier-hidden / dispenser-shown.
- Model/migration alignment: PharmacyBranchAssignment copied from #107; 20261021150000 removed.
  MERGE ORDER: #107 into integration first, then merge integration into this branch.
- Typecheck clean (witness-enumeration test typing fixed).

Still open: full pharmacy DB integration suites on the whole migration chain; browser QA retest of #138.
