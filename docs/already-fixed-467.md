# Issue #467 — archived white UI work is already superseded

## Decision

Close the archive-recovery issue as **already fixed / obsolete**. Do not restore the deleted
branch and do not cherry-pick any of its three commits.

The archived branch describes a Nuxt/FastAPI migration and a port of the white Studio shell to
that replacement stack. The current product already has the maintained Studio experience in the
active Next.js application:

- `package.json:6-18` makes Next.js the development, build, start, typecheck, lint, and test
  lifecycle; `package.json:100-134` keeps React, the Next.js ESLint integration, TypeScript, and
  Vitest in the supported application toolchain.
- `docs/design-system/DEVFATHOM-STUDIO.md:1-23` declares Studio the permanent UI source of truth,
  points implementation work to the live workspace, semantic CSS, shared UI components, and the
  tenant/platform shells, and explicitly rejects a second admin theme.
- `src/app/globals.css:186-279` supplies the live light Studio theme through canonical surface,
  text, border, action, and state tokens rather than an isolated prototype palette.
- `src/components/layout/app-shell.tsx:202-285` implements the responsive Studio viewport,
  mobile navigation dialog, top bar, primary navigation, bounded canvas, transitions, and
  entitlement-aware content in the production shell.
- `src/app/(app)/layout.tsx:23-97` composes that shell only after resolving the tenant actor,
  loading data through the tenant-scoped database wrapper, asserting workspace identity, and
  establishing the tenant session boundary. Replacing it with an old checkpoint would risk
  weakening isolation that the current shell deliberately preserves.

Git history also contains `ae7dae672ec8fda7efe0adbda4796102bc55d7e8` (`Restore white Next.js
dashboard`) as an ancestor of the current `HEAD`. Its object remains available locally and its
changes cover the dashboard, theme, application shell, sidebar, top bar, and shared card styling.
The maintained implementation above has continued to evolve since that restoration.

## Archive comparison and skipped work

The archive tag object is not present in this checkout, and this checkout has no `origin` remote,
so the requested fetch and a literal tree diff cannot be reproduced here. The recovery inventory
in issue #467 nevertheless identifies all three archive-only commits and is sufficient to decide
their disposition against the code-level evidence above:

| Archive commit | Disposition | Reason |
| --- | --- | --- |
| `c85ea42a` — `chore: checkpoint Nuxt and FastAPI migration` | Skipped | It is a checkpoint for a replacement stack, while the supported application lifecycle is Next.js and the active data layer is the tenant-scoped Prisma application. A checkpoint is not a focused fix to port. |
| `43a72f44` — `feat(ui): port white Studio shell to Nuxt` | Skipped | The valuable outcome—the white/Studio shell—is already implemented and governed in the current Next.js product. Porting a duplicate Nuxt shell would create the parallel UI architecture that the design contract forbids. |
| `f6f72ee0` — `wip: snapshot uncommitted white-ui checkout state before backup push (41 paths)` | Skipped | This is explicitly a broad dirty-worktree snapshot rather than a reviewable fix. Importing it wholesale would overwrite newer shell, entitlement, tenant-identity, and tenant-session behavior; no missing, independently valuable fix is identified by the archive inventory. |

No application code, dependency, database migration, authorization rule, WhatsApp behavior, or
logging behavior is changed by this resolution.
