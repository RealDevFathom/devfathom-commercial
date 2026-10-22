# PR #310 review notes

## Scope reviewed

PR #310 fixes the invitation-withdrawal path for organization members. The review covered the
public invitation lookup and acceptance flow, the organization-admin member update transaction,
and their focused unit and PostgreSQL regression coverage.

The checkout has no configured Git remote, so `git fetch origin main` and a literal
`git diff origin/main...HEAD` were unavailable. The reviewed four-file PR delta was reconstructed
against commit `9194795`, the integrated-main parent of the branch's current merge commit.

## Findings and fixes

- **Withdrawn users were correctly denied, including during an acceptance race.** Public lookup now
  requires the related user to remain `INVITED`. Acceptance also conditionally changes only an
  `INVITED` user, in the same transaction as the invitation claim, so a failed activation rolls the
  claim back.
- **Invitation withdrawal is atomic with the member status update.** Moving a member away from
  `INVITED` expires every unaccepted invitation before updating the user, inside one transaction.
- **Tenant predicates were missing from the new write filters.** Database RLS and globally unique
  identifiers already provide protection, but security-sensitive writes should remain explicitly
  tenant-scoped. The invitation claim, user activation, and admin invalidation filters now all
  include `organizationId`.
- **Read-path regression coverage was incomplete.** The database regression now verifies that both
  invitation detail lookup and acceptance return the same generic not-found response for an
  inactive invitee, while leaving the user and invitation unmodified.
- **No pharmacy authorization/cap or monetary code is changed by this PR.** The review found no
  PR-local changes affecting DENY-over-ALLOW evaluation, exact-grant-only pharmacy caps, or money
  invariants.

## Validation

Per the task constraint, dependencies were not installed and tests were not run. Review validation
was limited to inspecting the branch delta and the resulting source/test diff.
