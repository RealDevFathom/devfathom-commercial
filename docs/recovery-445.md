# Issue 445 archive recovery

Issue 445 asked whether the eight commits named from
`archive/fix/qa-b3-pharmacy` should be restored. The archive object was not present in the supplied
checkout, and the checkout has no `origin` remote, so the review used the issue's commit inventory
and compared each substantive change with the current code.

## Ported

- `f09ced61` (`fix(pharmacy): grant app role pg_trgm search execution (#233)`) remained valuable.
  Extension preparation revokes `PUBLIC EXECUTE` from `pg_trgm`, while the medicine RLS test had to
  grant `public.similarity_op(text,text)` to its disposable runtime role explicitly. The new
  migration now gives the production runtime role that same exact privilege. It deliberately does
  not grant all extension functions, grant `PUBLIC`, or alter default privileges.

## Skipped

- `0c32cd2b` (`fix(pharmacy): seat-occupancy copy agreement (#134)`) is already on the current line:
  the onboarding label pluralizes `seat` from `defaultSeats`, and its focused test covers both one
  and ten seats. Reapplying it would duplicate current behavior.
- `79d4a3d9` and `66be65c3` are merge commits for the two changes assessed above; merge topology is
  not product behavior and was not replayed.
- `1ca3e193` and `10d268de` are archive/automation follow-up commits without a distinct fix named in
  the supplied inventory. With no archive object available to prove an additional current-code
  delta, replaying them would be speculative rather than a minimal recovery.
- `ba5086e9` records an old typecheck memory blocker. It does not fix production behavior and is not
  current operational documentation.
- `bc1dccb9` removes an inherited `BLOCKED.md`; that file is absent on the current line, so there is
  nothing to port.

The recovery therefore ports the one missing privilege fix rather than reopening the stale branch.
