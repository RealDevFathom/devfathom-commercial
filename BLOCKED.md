# Status (CTO, 2026-10-21)

Resolved:
- QA138 UI: the controlled authorization panel is hidden when controlledPharmacists is FORBIDDEN
  (actor lacks dispense/safety). counter-console tests render a marker from the panel mock and
  cover cashier-hidden / dispenser-shown.
- Model/migration alignment: PharmacyBranchAssignment copied from #107; 20261021150000 removed.
  MERGE ORDER: #107 into integration first, then merge integration into this branch.
- Typecheck clean (witness-enumeration test typing fixed).

Still open: full pharmacy DB integration suites on the whole migration chain; browser QA retest of #138.

## QA-233 — blocked on typecheck (2026-10-21)

The new pg_trgm migration and focused database regression test are implemented.
The DB test passed against a dedicated local PostgreSQL database: it reproduced
42501 before the migration, applied the migration twice, ran the actual pack-setup
search as devfathom_app, verified tenant isolation and FORCE RLS, exercised all
granted similarity operators/functions, and confirmed PUBLIC remains revoked.

Required typecheck could not complete. Both attempts of
`TMPDIR=/tmp NODE_OPTIONS=--max-old-space-size=6144 bun run typecheck`
were terminated by SIGKILL (exit 137). The second attempt ran alone with the same
flags. No TypeScript diagnostic was emitted. Per the two-failure stop rule,
work stops here; retry typecheck on a worker with sufficient available memory.
No build or full test suite was run. No PR was opened.
