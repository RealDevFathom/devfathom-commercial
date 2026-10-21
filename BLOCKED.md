# Status (CTO, 2026-10-21)

Resolved:
- QA138 UI: the controlled authorization panel is hidden when controlledPharmacists is FORBIDDEN
  (actor lacks dispense/safety). counter-console tests render a marker from the panel mock and
  cover cashier-hidden / dispenser-shown.
- Model/migration alignment: PharmacyBranchAssignment copied from #107; 20261021150000 removed.
  MERGE ORDER: #107 into integration first, then merge integration into this branch.
- Typecheck clean (witness-enumeration test typing fixed).

Still open: full pharmacy DB integration suites on the whole migration chain; browser QA retest of #138.
## QA-233 — typecheck blocked (2026-10-21)

Branch: `fix/qa-233-trgm-grant-v2`, based on
`origin/integration/consolidation-20261019` at `26a9d010`.

The focused DB test passed with `TZ=UTC` in a dedicated local PostgreSQL
database. It reproduced 42501, applied the new migration twice, ran the actual
pack search as devfathom_app, verified tenant isolation and FORCE RLS, exercised
the granted similarity functions/operators, and confirmed PUBLIC stays revoked.

Both attempts of `TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`
were killed by SIGKILL (exit 137), with no TypeScript diagnostics. The retry ran
without other task work in this session; this shared worker had other builders
running. Required typecheck remains unverified. Per the two-failure rule, stop
here and retry on a worker with sufficient memory. No build, full suite, or PR.

