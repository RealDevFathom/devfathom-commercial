# Issue 447 archive recovery

Issue 447 requested recovery of `archive/fix/qa-b3-restaurant`. The archive tip was not suitable
for wholesale restoration: its eight commits include merge commits, an inherited blocker-file
cleanup, and fixes whose current-main status differs. The valuable missing behavior was ported as a
minimal current-code change instead.

## Ported

- `f09ced61` (`fix(pharmacy): grant app role pg_trgm search execution (#233)`): current extension
  preparation revokes `PUBLIC EXECUTE`, while the pharmacy RLS fixture demonstrates that catalogue
  search needs the exact `public.similarity_op(text,text)` function. The fresh-database runtime grant
  plan now grants only that function to the fixed runtime role. It does not grant all extension
  functions or broaden table privileges.

## Skipped

- `0c32cd2b` / PR #230 (`fix(pharmacy): seat-occupancy copy agreement (#134)`): already represented
  by current copy. The organization workspace calls these **licensed seats** and describes them as
  occupied by members, while restaurant floor-table occupancy is separately labelled **Occupied**.
  Reapplying old copy would risk regressing that distinction.
- `ba5086e9` records a historical typecheck blocker, and `bc1dccb9` removes an inherited
  `BLOCKED.md`; neither is a product fix to recover.
- Merge commits `79d4a3d9` and `66be65c3`, archive task wrapper `57b3e7f5`, and follow-up wrapper
  `1ca3e193` were not replayed. Cherry-picking wrappers would import unrelated ancestry and duplicate
  the fixes assessed above; the needed pg_trgm behavior was applied directly to today's deployment
  preparation path.

No migration is added. The current deployment contract emits reviewed runtime-role grants from
`renderPreparation`; keeping the exact function grant there avoids embedding a role-dependent grant
in the schema migration ledger.
