# Issue #467 — archive recovery remains on hold

## Decision

Do **not** close this recovery as already fixed, do not reopen the deleted branch, and do not
cherry-pick any of its commits yet. The archive must remain on hold until its Git objects are
available for inspection.

This checkout cannot support the previous “obsolete” conclusion:

- `git cat-file -t f6f72ee0`, `git cat-file -t 43a72f44`, and
  `git cat-file -t c85ea42a` each report that the object name is invalid.
- `git cat-file -t archive/wip/white-ui-dirty-20260828` likewise reports that the tag object is
  invalid.
- `git remote -v` is empty, so the documented `git fetch origin tag
  archive/wip/white-ui-dirty-20260828` cannot be run in this checkout.
- A direct attempt to query the likely GitHub repository is blocked by the environment's HTTP 403
  proxy response. No archive content was obtained that way.

Commit subjects are not a substitute for comparing commit contents. In particular, the stated
41-path dirty-worktree snapshot could contain a focused fix, asset, or configuration change that
is independent of the abandoned migration. Therefore this document does not claim that the
archive-only work is superseded.

## Current-code evidence

The maintained product is a Next.js Studio application, which is relevant to a future archive
review but does not prove that every archive-only change is obsolete:

- `package.json:6-18` defines the Next.js development, build, start, typecheck, lint, and Vitest
  lifecycle.
- `docs/design-system/DEVFATHOM-STUDIO.md:7-23` makes the live Studio implementation the product
  source of truth and rejects a second admin theme.
- `src/app/(app)/layout.tsx:23-96` resolves the tenant actor, uses `withTenantDb`, verifies the
  workspace identity, and establishes the tenant session boundary before rendering the shell.
- `src/components/layout/app-shell.tsx:202-285` contains the active responsive Studio shell.
- `ae7dae672ec8fda7efe0adbda4796102bc55d7e8` (`Restore white Next.js dashboard`) is an ancestor of
  this branch, but that ancestry alone cannot establish semantic equivalence with the unavailable
  archive.

## Archive inventory and present disposition

No archive change is classified as ported or permanently skipped without a content diff:

| Archive commit | Present disposition | Reason |
| --- | --- | --- |
| `c85ea42a` — `chore: checkpoint Nuxt and FastAPI migration` | Deferred, not skipped | The commit tree is unavailable. Its migration work may be obsolete, but independent fixes cannot be excluded from its subject. |
| `43a72f44` — `feat(ui): port white Studio shell to Nuxt` | Deferred, not skipped | The active shell makes a wholesale Nuxt port unlikely to be valuable, but the commit must be inspected for reusable behavior or assets. |
| `f6f72ee0` — `wip: snapshot uncommitted white-ui checkout state before backup push (41 paths)` | Deferred, not skipped | A 41-path snapshot cannot be assessed from its subject; every archive-only path must be inventoried. |

When the tag is available, compare it to the current main lineage with rename and copy detection,
inventory every archive-only path (including non-Nuxt/FastAPI files), and classify each change as
already present, valuable to port, or intentionally skipped with file-level evidence. Any port
must preserve tenant isolation, DENY-over-ALLOW, exact-grant-only pharmacy permissions, the
code-level live WhatsApp send block, and secret-safe logging.

No application code, dependency, database migration, authorization rule, WhatsApp behavior, or
logging behavior is changed while the recovery is on hold.
