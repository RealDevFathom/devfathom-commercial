# DEV-117 / GitHub #672 delivery and external verification

Status: local code repair prepared; external verification and delivery reconciliation pending.
No checks, database operations, commits, pushes, or publication were performed in this repair.

The reported unit-gate failure came from a missing test database URL throwing in `beforeAll`.
The database suite now uses `(url ? describe : describe.skip)` and returns from setup when no
URL is present, following the repository convention. With a URL, every existing fixture and
assertion still runs, including the fail-closed RLS role guard. A skipped database suite is not
database acceptance; the separate direct-script runner must execute it with a migrated
disposable database.

## Code repair

The page previously replaced any unavailable explicit branch with the first active tenant branch.
It now defaults only when `branch` is omitted. Foreign, inactive, unknown, empty, and repeated
branch parameters show a generic unavailable state before creating the report caller. No report
rows are rendered for those requests. The existing authorized financial-statements caller still
enforces report capabilities and the tenant/branch scope for valid requests.

Page regressions cover each rejection, omitted-branch defaults, valid branch preservation when
the cutoff is invalid, and tenants without active branches. The former test that expected a
foreign branch to fall back was changed because this ticket explicitly requires rejection.

The supplied candidate already includes actual posted-journal regression fixtures in
`balance-sheet.postings.db.test.ts`: supplier/customer/claim settlement, linked additive reversal,
pre-window earnings versus window movements, pagination independence, two tenants/branches and
currencies, cutoff inclusion/exclusion, empty source, large integer totals, and branch equation
gaps. Pure projection and report tests cover unmapped codes and coverage qualifications. These
fixtures have not been executed in this repair; their presence is not a pass result.

## Scope and authoritative delivery records

The supplied candidate `7c5de679b5bb3cdea5ae9ff21f9d9e94efae31a9` changes only permitted
balance-sheet paths relative to the specified develop baseline
`e7e4059edba7b973ee84f825babaf4e4d4fa8d5b`. This repair also stays within those paths.

The historical introducing commit `7d94d340b66d4f10f9f77317d6d3a37908e405c9` already in develop
also changed these out-of-lane files:

- `src/app/(app)/pharmacy/finance/page.tsx`
- `src/app/(app)/pharmacy/finance/page.test.tsx`
- `src/lib/module-catalog.ts`
- `src/lib/module-catalog.test.ts`

Those files already match the specified develop baseline, so restoring them to that baseline
would not remove the historical additions. No removal of existing develop behavior or assertions
is included in this repair. Historical scope compliance remains an integration-owner decision.

GitHub observations recorded by the previous repair on 2026-11-10 (not refreshed in this repair):

| Record | Observed fact |
| --- | --- |
| [Issue #672](https://github.com/WhatTheStack1/devfathom-commercial/issues/672) | Correct source issue for the ticket supplied in this repair. The intended PR closing line is `Fixes #672`. |
| [PM reservation](https://github.com/WhatTheStack1/devfathom-commercial/issues/672#issuecomment-6393493767) | Task `task_e_6add86c7ebb0832ab081ea2f3c152118`; requested/created branch `codex/pharm-672`; base `08a247c1c68441a14c1a151c096c7d73552099f6`; requested model `gpt-6.1-sol`, explicitly not backend model attestation. |
| [PR #716](https://github.com/WhatTheStack1/devfathom-commercial/pull/716) | Open, unmerged, **not draft**; head `codex/fix-672` at `6dd95fd30182cbed813072f4f423ae292631a52d`; base `develop`. Body says `Closes #672` and links a different task, `task_e_6adeba0f6ae8832a9ad05fb51901cf20`. Its changed-file list also includes two shared-router test paths outside the exclusive lane. |
| Local introducing commit | Message references #665 / PR #692 and task `task_e_6ae215196ef0832a90fde11e025583d0`, plus a later fix task. It does not establish the reserved #672 task provenance. GitHub PR #692 lookup returned 404; no authoritative PR state can be claimed for it. |
| Local repair context | Supplied branch `fix-DEV-117`, candidate `7c5de679b5bb3cdea5ae9ff21f9d9e94efae31a9`, plus uncommitted edits. |

These records disagree. PM Pharmacy / the integration owner must identify the authorized delivery,
reconcile its task/branch provenance and historical scope, and ensure the final PR is a draft with
`Fixes #672`. No duplicate task or PR was launched and no model provenance was invented.

## Request to the separate direct-script runner

The only supplied machine failure is:

```text
UNIT FILE FAILED src/lib/pharmacy/accounts/balance-sheet.postings.db.test.ts
The direct-script runner must supply a migrated disposable TEST_DATABASE_URL.
```

For database acceptance, provide a migrated disposable PostgreSQL database through `BALANCE_SHEET_TEST_DATABASE_URL` or
`TEST_DATABASE_URL`. Use an RLS-enforcing role with neither SUPERUSER nor BYPASSRLS; the suite's
existing role guard remains intact. Without either URL the suite is skipped by design for the
unit-only gate; the runner must report that skip and must not count it as database acceptance.
The runner owns
database preparation, generated client availability, execution, and disposable database teardown.
Do not supply a production database or secrets in returned logs.

Run these suites externally against the final working-tree snapshot and return the command,
snapshot identification, exit code, per-file results, assertion failures, and any skipped cases:

- `src/lib/pharmacy/accounts/balance-sheet.test.ts`
- `src/lib/pharmacy/accounts/balance-sheet.coverage.test.ts`
- `src/lib/pharmacy/accounts/balance-sheet.postings.db.test.ts`
- `src/app/(app)/pharmacy/accounts/balance-sheet/page.test.tsx`
- `src/app/(app)/pharmacy/accounts/balance-sheet/balance-sheet-report.test.tsx`
- Existing `src/server/routers/pharmacy-finance.test.ts` authorization regressions.

Typecheck, lint, production build, and any broader regression checks also belong to the external
runner. No passing results are available here.

## Studio visual QA matrix — external results required

Route: `/pharmacy/accounts/balance-sheet`. Reuse of `PageHeader`, `SectionCard`, `StatusPill`,
shared controls/tables, and semantic tokens is retained. The new denied state uses the same
components. This matrix records outstanding work, not completed visual QA.

| Check | Required coverage | External result |
| --- | --- | --- |
| Viewports / themes / motion | 375, 768, 1024, 1440px; light and dark; normal and reduced motion (all 16 combinations) | Pending |
| Keyboard | Tab order, form submission, visible focus; Escape where applicable | Pending |
| Layout | No document horizontal overflow, bounded table overflow, zoom/reflow, large amounts | Pending |
| States | Loaded, loading, empty, source error, authorization denial, unavailable explicit branch, active controls | Pending |
| Disabled / destructive | Record applicability; this read-only report introduces no destructive action | Pending assessment |
| Console | No hydration, render, accessibility, or client-fetch errors | Pending |
| Product parity | Existing tenant Studio shell, typography, geometry, and theme behavior | Pending |
| Evidence | Screenshots and results tied to the tested snapshot, including denied branch with no rows | Pending |

Full ticket completion cannot be claimed until the external results and delivery discrepancies
above are resolved.
