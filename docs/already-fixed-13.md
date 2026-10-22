# GitHub issue #13: already fixed

Verified against the current branch on 2026-10-22. The reported platform-command audit gap is
already fixed, so no production code was changed for this issue.

## Code evidence

- `src/lib/platform/commands.ts:3868-3931` wraps action parsing, capability authorization,
  payload validation, and command execution in one failure-audited boundary. Its catch path calls
  `persistCommandFailure` before rethrowing, so capability denials, validation errors, preflight
  failures, and unexpected command failures do not bypass the ledger.
- `src/lib/platform/commands.ts:298-348` writes failed attempts outside the failed command
  transaction. Each row identifies the actor and attempted action, explicitly sets
  `success: false`, stores a safe categorical `error`, and records the missing capability for a
  capability denial. The failure projection deliberately excludes arbitrary payload values and
  hashes a validated request ID, preventing secrets supplied by an attacker from entering the
  audit row.
- `src/lib/platform/commands.ts:3888-3917` captures the validated operator reason and writes it to
  the queryable `reason` column. Successful command rows explicitly set `success: true` and
  `error: null`.
- `src/app/platform/(console)/audit/page.tsx:53-90` maps the Failure outcome to
  `success: false` and searches the dedicated `reason` column. The existing outcome selector at
  `src/app/platform/(console)/audit/page.tsx:218-230` exposes both Success and Failure filters.
- `prisma/schema.prisma:11473-11498` contains the audit columns and indexes used by the ledger,
  including organization/time, actor/time, action/time, and request-ID indexes. The existing
  100-row page limit remains in `src/app/platform/(console)/audit/page.tsx:51-55` and
  `src/app/platform/(console)/audit/page.tsx:95-100`.

## Regression evidence

- `src/lib/platform/commands.failure-audit.test.ts:78-95` verifies that a denied command creates
  one attributed `success: false` row containing the attempted action and missing capability.
- `src/lib/platform/commands.failure-audit.test.ts:98-111` and
  `src/lib/platform/commands.failure-audit.test.ts:188-201` cover validation and runtime failures,
  including the absence of submitted secrets from durable audit data.
- `src/lib/platform/commands.failure-audit.test.ts:204-215` verifies explicit success and error
  values on a successful command, while
  `src/lib/platform/commands.administrator-staff-profile.test.ts:343-347` verifies that an
  activation transition persists its operator reason in the audit column.
- `src/app/platform/(console)/audit/page.test.tsx:137-149` verifies that selecting Failure queries
  for `success: false`.

Per the issue instructions, no dependencies were installed and no tests were run (the supplied
environment has no database and npm access returns HTTP 403). This issue is not an
`archive/...` recovery request, so there was no archive branch to diff or skipped archive work to
report.
