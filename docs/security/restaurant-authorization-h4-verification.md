# Restaurant authorization verification — H4

Base commit: `c0881431a5a094b549e0bfd7a14a4e31bad9e9f2`.

## Behavior

- Full-administration web grants and active owner floor roles retain tenant-wide branch access. Ordinary managers remain branch-limited. The owner template enumerates the complete restaurant capability catalog; existing edited roles are not overwritten. Action-level DENY rules remain authoritative.
- Owner and full-administration branch reach is derived at decision time. Provisioning grants the administrator one owner holding at their primary branch; neither provisioning nor branch creation/reactivation persists generated per-branch owner holdings or branch assignments, so removing the owner holding, deactivating the owner role, or removing the web grant revokes access at every branch.
- The back-office device approver directory uses the same branch-membership rule and the same `coauth:approve` predicate as revoke/rotate, so it never offers an approver the mutation would refuse. When the actor is the server-verified solo branch owner, the directory reports `selfApprovalAllowed` and the console offers the actor as a PIN-only approver.
- Manual (admin-set) password resets are refused for members who have not accepted their invitation, before any credential changes, so the pending invitation remains a working onboarding path.
- Self-approval requires an active owner, exactly one active staff profile eligible for that branch, and fresh PIN re-authentication. Staff linked through primary branch, job roles, direct grants, explicit user assignments, or organization-wide access count toward the total. Badge credentials and prior terminal unlocks do not qualify. Server-only proof is single-use, expires after 30 seconds, and is bound to the request database client. Eligibility and approval capability are checked again when building evidence. The persisted reason records the branch, PIN re-authentication, and single-staff exception without credential material. Multi-staff approval still requires a second identity.
- Terminal, inline money/order, and back-office device/camera approval paths use the authenticated evidence builder. Web re-authentication retains its existing behavior without imposing a terminal shift-sign-in requirement.
- Fixed an existing complimentary-line failure discovered by PostgreSQL rollback tests: bills without a service-charge policy retain a zero service-charge basis rather than subtracting a merchandise subtotal from it. Database constraints remain intact.

## Database setup

Tests used the supplied localhost PostgreSQL database. A dedicated LOGIN NOSUPERUSER NOBYPASSRLS runtime role was granted table/sequence access; database-backed suites used that runtime URL through `DATABASE_URL`, `TEST_DATABASE_URL`, and `M8_TEST_RUNTIME_DATABASE_URL`. The original local owner URL was supplied only through `M8_TEST_OWNER_DATABASE_URL` and `WHA874_TEST_OWNER_DATABASE_URL` for fixture setup. No URL or password is recorded here. No Azure files were edited.

## Exact tests and results

Final main run: **22 files passed; 349 tests passed; zero failed or skipped**.

```sh
bunx vitest run \
  src/lib/restaurant/terminal-flow.db.test.ts \
  src/lib/restaurant/co-authorization.test.ts \
  src/lib/restaurant/organization-provisioning.db.test.ts \
  src/lib/restaurant/checkout-coauth-job-roles.test.ts \
  src/lib/restaurant/terminal-money-rollback.db.test.ts \
  src/lib/restaurant/terminal-checkout.db.test.ts \
  src/lib/restaurant/terminal-kds-routes.db.test.ts \
  src/lib/restaurant/terminal-auth.test.ts \
  src/lib/restaurant/job-roles.db.test.ts \
  src/lib/restaurant/bills.test.ts \
  src/lib/restaurant/refunds.test.ts \
  src/lib/restaurant/drawer-sessions.test.ts \
  src/lib/restaurant/daily-close.test.ts \
  src/lib/restaurant/staff-branch-authorization.test.ts \
  src/lib/restaurant/staff-branch-authorization.db.test.ts \
  src/server/restaurant-branch-scope.test.ts \
  src/server/restaurant-branch-scope.db.test.ts \
  src/server/routers/restaurant-devices.test.ts \
  src/server/routers/restaurant-branches.test.ts \
  src/server/routers/restaurant-staff-branch-guard.test.ts \
  src/server/routers/restaurant-cameras.test.ts \
  tests/vertical-foundation.test.ts \
  --maxWorkers=2
```

Follow-up after branch-reactivation assignment and its database assertion: **5 files passed; 46 tests passed; zero failed or skipped**. Two files overlap the main run; these are test executions, not 395 distinct tests.

```sh
bunx vitest run \
  src/server/routers/restaurant-branches.test.ts \
  src/lib/restaurant/organization-provisioning.db.test.ts \
  src/lib/restaurant/checkout-routes.demo.test.ts \
  src/lib/restaurant/checkout-routes.test.ts \
  src/lib/restaurant/terminal-orders-capability.test.ts \
  --maxWorkers=2
```

The new regressions cover all-capability owner/admin access across branches, active/inactive and foreign branch refusal, explicit DENY precedence, provisioning and real branch creation/reactivation assignment, assignment/grant idempotence and audit counts, PIN-only owner self-approval through real terminal and device-router requests, bad/missing PIN and badge refusal, active versus suspended second staff, role/direct-grant branch membership, second-identity approval, audit persistence, proof expiration, consumption, and isolation across database clients. Existing rollback, idempotency, RLS, and credential-lockout checks remain enabled.

## Static checks and limits

- `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck`: passed. An initial default-heap attempt exhausted Node's 4 GiB heap; the complete check was rerun successfully with additional memory.
- ESLint on every changed TypeScript file and all three new TypeScript modules: passed.
- Prettier check on the same files: passed.
- `git diff --check`: passed.
- `bun run lint`: failed on three pre-existing errors in untouched files: `src/app/api/restaurant/webhooks/[source]/route.replay.test.ts:22` (`no-require-imports`), `src/components/layout/app-shell.test.ts:93` (`no-children-prop`), and `src/components/pharmacy/counter/counter-console.tsx:993` (`set-state-in-effect`). It also reported four warnings in untouched files. No lint rules were disabled.
- An exploratory run across all restaurant library tests also reached catering acceptance suites that reject the supplied database because they require a separately reserved disposable acceptance harness, plus suites with additional missing fixture configuration. That exploratory run was not green. No harness guards or tests were weakened or bypassed; the final relevant suites above ran against local PostgreSQL without skips.
