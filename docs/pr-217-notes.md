# PR #217 review notes

## Review scope

Reviewed the branch changes against the merge commit immediately preceding the PR (`b668f93`),
covering password-change throttling and auditing, centralized temporary-password enforcement, and
seat serialization across user creation and reactivation paths. The checkout has no configured Git
remote, so `origin/main` could not be fetched; `b668f93` is the available mainline baseline and the
parent of this branch's first PR commit.

## Findings

- **Fixed — tenant isolation in the shared seat helper.** The occupied-seat exemption looked up an
  existing user by id alone. That was safe behind tenant RLS but was also callable from platform
  transactions, where a user id belonging to a different organization could incorrectly bypass a
  full organization's seat cap. The lookup now requires both the requested user id and organization
  id, and a focused regression test pins the tenant predicate and fail-closed capacity check.
- **Reviewed — DENY-over-ALLOW and exact-grant-only pharmacy behavior.** The PR does not change the
  ABAC permission evaluator or pharmacy grant resolution. No relaxation of deny precedence or
  widening of pharmacy grants was found in the branch diff.
- **Reviewed — money invariants.** The PR does not alter monetary storage, arithmetic, settlement,
  or currency handling.
- **Reviewed — temporary-password enforcement.** Authenticated API routes consistently resolve the
  tenant actor and use the shared API wrapper to translate the central policy error. Public,
  webhook, cron, SCIM bearer-token, and authentication endpoints remain outside session resolution;
  only password change and sign-out procedures are exempt for flagged sessions.
- **Reviewed — password-change controls.** Password changes consume per-user plus the shared login
  account/IP budgets, preserve IP failures after success, clear only the successful account budget,
  revoke prior sessions, and rely on the outer tRPC audit middleware to record both successful and
  failed attempts without password input.
- **Reviewed — seat serialization.** User invite, create, JIT provision, SCIM activation, invitation
  acceptance, and administrative/assistant reactivation paths take the organization row lock before
  checking capacity. Already occupied users do not consume an additional seat.

## Validation

Per request, dependencies were not installed and tests were not run. Review was static only.
