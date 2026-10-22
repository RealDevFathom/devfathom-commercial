# GitHub issue #454: already fixed

Issue #454 asked us to recover the terminal-payments core from
`archive/rescue/WHA-238` (commit `07e1b047`). No archived code was ported because
the current branch already contains the valuable WHA-238 behavior, together with
later webhook hardening.

## Current-code evidence

- `prisma/migrations/20260827070000_restaurant_terminal_payments/migration.sql:1-61`
  adds the terminal provider mode and event status, provider configuration and
  reconciliation tables, organization-scoped compound foreign keys and unique
  indexes, and forced row-level security policies.
- `prisma/schema.prisma:5263-5314` maps those provider configuration and
  reconciliation models into the current Prisma schema.
- `src/lib/restaurant/terminal-payments.ts:15-55` strictly validates the
  provider-neutral event payload and verifies a timestamped HMAC with a bounded
  replay window and constant-time comparison.
- `src/lib/restaurant/terminal-payments.ts:80-194` deduplicates external event
  IDs, resolves the terminal, bill, and operator through the tenant-scoped
  database, rejects branch or amount mismatches, and applies approved events
  through the existing idempotent CARD tender path.
- `src/app/api/restaurant/webhooks/[source]/route.ts:62-107` derives the tenant
  only from an explicit host, rejects demo or unknown tenants, validates terminal
  signatures before writing, and records the event through a tenant-scoped
  database.
- `src/server/routers/restaurant-payments.ts:40-131` exposes capability-gated,
  branch-scoped terminal configuration and reconciliation operations.
- `tests/restaurant-terminal-payments.test.ts:68-180` covers strict payloads,
  signature tampering and freshness, exactly-once tender application, amount
  rejection, replay behavior, unconfigured terminals, and simulation-mode
  separation.

## Archive disposition

The archive tag is not present in this shallow checkout, and this checkout has
no `origin` remote from which to fetch it. The issue-provided archive inventory
contains only `07e1b047 feat(restaurant): add terminal payments core`; every
valuable responsibility named by that commit is evidenced above in current
code. Therefore the archived implementation was skipped in full as already
present. Reintroducing it wholesale would risk regressing the newer timestamped
signature and replay protections, while a migration or a second implementation
would duplicate the existing schema and payment path.

Issue #454 can be closed as obsolete rather than reopening the deleted rescue
branch.
