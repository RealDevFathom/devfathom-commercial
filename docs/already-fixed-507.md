# GitHub issue #507: already fixed

Issue #507 reports that `team.getRoster` could enumerate the tenant roster even
when the caller had an effective `DENY team:view`. The current code already
prevents that behavior, so no production-code change is required.

## Code evidence

- `src/server/routers/team.ts:114-121` resolves the caller's ID, evaluates
  `team:view` through the shared ABAC engine with the tenant-scoped `ctx.db`, and
  adds `where: { id: me }` when the decision is false. A denied caller therefore
  receives only their own roster row rather than every tenant member.
- `src/lib/abac/index.ts:48-57` evaluates matching user overrides before custom
  role permissions and returns `false` for a matching `DENY` before accepting an
  `ALLOW`. This preserves DENY-over-ALLOW semantics for the decision used by
  `getRoster`.
- `src/server/routers/team.account.test.ts:330-363` contains focused coverage for
  `getRoster`: the allowed case has no self-only filter, while both a per-user
  `DENY team:view` and a custom-role wildcard `DENY team:*` require
  `where: { id: 'user_self' }` and return only the caller's row.

## Verification conclusion

The reported authorization gap is already fixed on the current branch. The
endpoint consistently follows `team.getAll`'s self-only fallback for callers
without directory access, including callers denied by either supported custom
permission source.
