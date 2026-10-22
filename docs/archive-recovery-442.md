# Issue 442: `archive/fix/qa-287` recovery

The archive is obsolete as a branch. Two still-useful presentation fixes were recovered into the
current tree: the regulatory version-history scroller is a named, keyboard-focusable region, and
the neutral `StatusPill` uses the normal body-text token instead of the lower-contrast muted token.
`tests/issue-442-archive-recovery.test.ts` pins both recovered contracts without needing a database.

The remaining archive commits were deliberately not replayed:

- Merge commits for QA-301, QA-306, QA-307, and QA-308 were skipped because replaying historical
  merges would also replay their obsolete parent topology. The current consolidated tree already
  contains the affected application surfaces; only the two independently identifiable fixes that
  were absent were ported.
- The superseded QA-301 and QA-306 changes, and their matching reverts, cancel one another and were
  skipped as a unit. Replaying either side alone would restore code that its own archive reverted.
- The QA-134 seat-copy work was skipped because the current organization administration UI already
  describes active seats as occupied licensed seats and explains that a new member occupies one.
- The QA-233 `pg_trgm` grant migration and its follow-ups were skipped because extension ownership
  and ACLs are now handled before migration by `prisma/prepare-extensions.sql`. Reintroducing an old
  application-role grant after that owner-aware hardening would widen database execution rights
  without a current call site that needs a trigram function.
- The archived `BLOCKED.md` removal needs no replay because that file is absent from the current
  tree.
- The opaque archive task commit was not replayed wholesale: its independently named accessibility
  and contrast fixes are the only changes shown by the archive history that were still absent.

No authorization, tenant scoping, pharmacy exact-grant rules, WhatsApp delivery behavior, logging,
or database schema was changed by this recovery.
