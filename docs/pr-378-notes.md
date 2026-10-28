# PR #378 review notes

## Finding

Invitation acceptance reads the invitation before performing the deliberately expensive password
hash. Resending an invitation updates the existing invitation row with a replacement token during
that gap. The previous atomic claim checked only the row id, acceptance state, and expiry, so a
request authenticated with the superseded token could claim the refreshed row and activate the
user.

## Resolution

The claim now also requires the row's token hash to equal the hash observed by the initial lookup.
Because the claim remains a single conditional `updateMany`, a resend, expiry, or competing accept
that wins the race makes the stale request affect zero rows. It then receives the same generic
not-found response as every other invalid invitation, and its transaction does not update the user.

The regression coverage pauses password hashing, replaces the persisted token, and verifies that
the old request cannot update the user. A success-path case also verifies that an unchanged token
is still claimed and activates the invited user.

## Review scope

- Tenant isolation is unchanged: anonymous token routing selects the tenant first, and the claim
  executes through that tenant-scoped database client. The globally unique token hash is also part
  of the write predicate.
- The failure remains fail-closed and uses the existing generic invitation response; no new
  authorization grants or error distinctions were introduced.
- Pharmacy grants and monetary operations are not touched by this invitation race fix.
- No schema or migration change is required.
