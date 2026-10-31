# Issue 672 validation handoff

Route: `/pharmacy/accounts/fiscal-exceptions?branchId=<active-branch>&from=2026-07-01&to=2026-10-01`.
CSV: the same query at `/pharmacy/accounts/fiscal-exceptions/csv`.

The implementation reuses the tenant shell, PageHeader, SectionCard, Input, Button,
StatusPill and semantic Studio tokens. No shared routes, navigation, schema, fiscal
writers or report counts were changed. Sensitive reads retain the existing audit path.

Tests are authored, **not run**, per the issue's Checks machine C restriction:

- DTO/date/page bounds, 92-day acceptance and 93-day refusal, formula/CSV escaping.
- ADMIN, session, module and both report capabilities denied before fiscal reads.
- Active organization/branch validation, explicit OFF/SANDBOX, safe selection,
  lookahead pagination, hard cap and unknown coverage.
- Conditional PostgreSQL cases in `fiscal-exceptions.reader.test.ts` use
  `TEST_DATABASE_URL`, a migrated disposable database and an RLS-enforcing role.
  Fixture creation uses tenant scope. Successful reading also runs in a read-only
  transaction; no fiscal lifecycle or provider work is invoked.
- Page loading, permission denial, empty/error states, keyboard scroll target,
  disabled navigation and page-only CSV, including sensitive-read auditing.

Visual QA is **pending external QA**; no live server/browser validation was run.
Complete the Studio matrix at 375, 768, 1024 and 1440px; light/dark themes;
normal/reduced motion; keyboard focus and tab order; loading/empty/error/denied,
disabled and active states; bounded table overflow with no document overflow;
and hydration, render and accessibility console checks. Destructive confirmation
is inapplicable because this register has no business mutation controls. Capture
screenshots of the new registry page recipe. Verify exports reauthorize and remain
uncached, and that changing current state between screen/download is explicitly
described rather than presented as a frozen or complete snapshot.

Only source/diff review and Git whitespace checking were performed. No builds,
migrations, typecheck, lint, tests, external review, push or PR creation were run
from this implementation worktree. Exact-commit QA and Security remain
with the designated external checks/review process.
