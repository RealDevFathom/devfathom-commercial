# PR #373 review notes

## Scope

Reviewed the `team.inviteMember` seat-limit fix for QA issue #360. The review stayed focused on
making invite creation atomic and preserving tenant isolation and existing invitation behavior.

## Findings and fixes

- **Fixed a time-of-check/time-of-use gap in duplicate handling.** The initial branch looked up the
  email before starting the transaction. Two concurrent requests for the same new email could both
  retain a stale “not found” result, leaving the second request to surface a database uniqueness
  error (or a misleading seat-limit error). The member lookup now happens after acquiring the
  organization row lock.
- **Kept the seat decision inside the tenant mutex.** New invites acquire a row lock on their
  organization, recount `ACTIVE`, `ON_LEAVE`, and `INVITED` users, enforce the entitlement seat
  limit, and create the invited user within the same transaction. Concurrent invite transactions
  for one organization therefore cannot both decide that the final seat is available.
- **Preserved re-invitation semantics.** A pending member is discovered under the same lock and can
  receive a refreshed invitation even when the workspace is at its seat limit, because that member
  already occupies a seat. Non-pending duplicates still fail with `CONFLICT`.
- **Made tenant boundaries explicit.** Department validation, duplicate lookup, seat recount,
  invited-user creation, and pending-user update all include the caller's organization identifier
  rather than relying only on row-level security or scoped database defaults.
- **Expanded focused regression coverage.** Tests now verify lock-before-read-before-count ordering,
  the organization used by the lock and tenant predicates, the occupied-status recount, and the
  full-seat re-invitation path.

## Security and invariant review

- The change does not alter authorization or module/capability resolution, including
  DENY-over-ALLOW behavior.
- It does not touch pharmacy grants/caps or money-writing code, so exact-grant-only pharmacy caps
  and money invariants are unchanged.
- The raw lock query remains parameterized; no user-controlled SQL is interpolated as SQL text.

## Validation

Per the PR completion request, dependencies were not installed and tests were not run. The final
diff was reviewed statically against the available base commit after the requested `origin/main`
fetch was attempted; network access to the remote was unavailable in this environment.
