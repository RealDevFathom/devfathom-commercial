# Issue #466 — archive recovery is on hold

Issue #466 asks for the dirty-worktree snapshot at
`archive/wip/WHA-8-dirty` (`a9051a78`) to be compared with `main` and for any
still-valuable work to be recovered. That comparison cannot be completed from
this checkout: the archive object and tag are absent, there is no configured
`origin`, and the environment rejects direct GitHub HTTPS access with HTTP 403.

The recovery must therefore remain **on hold**. This document does not classify
the archive as obsolete and does not claim that its complete contents are
already on `main`. Re-open `wip/WHA-8-dirty` for review after restoring the tag
in a checkout with repository access:

```sh
git fetch origin tag archive/wip/WHA-8-dirty
git push origin archive/wip/WHA-8-dirty:refs/heads/wip/WHA-8-dirty
git diff --find-renames main...archive/wip/WHA-8-dirty
```

## Current-code evidence (not archive-diff evidence)

The current tree contains one plausible WHA-8 outcome, vertical isolation:

- `src/components/layout/sidebar.tsx:543-552` resolves a navigation entry's
  owning module and hides the entry when the module and tenant verticals differ.
- `src/components/layout/sidebar.test.tsx:280-307` covers cross-vertical
  mis-provisioning in both directions.
- `src/lib/platform/commands.ts:1855-1887` rejects module enablement when the
  persisted organization and module verticals differ, before the upsert.
- `src/lib/platform/commands.vertical.test.ts:754-794` covers both mismatch
  directions and permits a shared platform module.

These lines establish only the state of the current tree. Without the archived
tree, they cannot prove that every independent change in the dirty-worktree
snapshot is present or intentionally superseded.

## Archive disposition

No archive hunk was ported or skipped. A hunk-by-hunk disposition would be
fabricated until `a9051a78` is available. In particular, the following remain
**unreviewed**, rather than “skipped as obsolete”:

- all application and test changes in the archived snapshot;
- authorization and tenant-isolation behavior;
- secret handling and logging;
- schema and migration changes;
- WhatsApp delivery behavior; and
- catalogue and exact-grant behavior.

Once restored, every changed hunk must be classified as (1) already present on
`main`, with current file-and-line evidence; (2) intentionally obsolete, with a
specific reason; or (3) still valuable and ported with focused tests. Until
then, the safe decision is to keep the recovery branch and issue open.
