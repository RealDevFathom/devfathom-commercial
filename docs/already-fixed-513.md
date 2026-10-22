# GitHub issue #513: already fixed

Issue #513 reported that a persisted `ALLOW` decision could bypass the mandatory
resource checks for `resignation:review`. The current code already fixes that
authorization path:

- `src/lib/abac/policies.ts:113-117` defines the resignation review resource
  predicate. It requires a `PENDING` resignation, rejects self-review, and
  prevents an HR reviewer from reviewing an administrator resignation.
- `src/lib/abac/policies.ts:120-126` registers that predicate as a mandatory
  policy for `resignation:review`, separate from the static allow-list.
- `src/lib/abac/index.ts:78-90` evaluates mandatory policies after a persisted
  permission returns `true` and denies when any constraint fails or throws.
- `src/lib/abac/index.ts:48-57` still gives persisted `DENY` rules precedence
  over persisted `ALLOW` rules.
- `src/lib/abac/index.test.ts:159-212` covers wildcard role grants, exact user
  overrides, self-review, non-pending resignations, valid reviews, and HR review
  of an administrator resignation.

The fix is present in commit `519064a` (`fix(#513)`) on the current branch, so
no production code or additional tests are needed for this issue.
