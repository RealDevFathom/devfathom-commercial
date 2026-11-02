# Issue #506 / DEV-213: white UI archive disposition

**Decision:** close the archived branch as obsolete. Do not recreate the branch, open a PR from
the tag, or cherry-pick any of its commits.

## Evaluation basis

The preserved tag `archive/wip/white-ui-dirty-20260828` points at `f6f72ee0`. The issue records
three commits outside its historical `main` comparison. Their preserved objects were inspected
against the maintained `develop` snapshot `47518cbf94ac912d0d657122625af03b23bbd1c1`:

| Commit     | Archived change                                   | Disposition                                                   |
| ---------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `c85ea42a` | Checkpoint Nuxt and FastAPI migration              | Superseded runtime; do not replay                              |
| `43a72f44` | Port white Studio shell to Nuxt                    | Superseded by the maintained Next.js Studio shell              |
| `f6f72ee0` | Snapshot described as uncommitted white UI state   | Historical checkpoint; no additional tree changes to recover   |

`c85ea42a` adds the Vue application under `app/`, the Python application under `backend/`,
`nuxt.config.ts`, and a replacement dependency manifest. Its
`docs/architecture/NUXT-FASTAPI-MIGRATION.md` explicitly makes Nuxt responsible for SSR and UI,
FastAPI responsible for authentication and business APIs, and the old `src/` and Prisma tree
historical references. Replaying that migration would replace the supported runtime rather than
recover an incremental UI fix.

`43a72f44` changes eight Nuxt UI paths, including `app/layouts/default.vue`, the shared styles,
sidebar, top bar, and top navigation. The layout uses the Studio viewport, shell, and canvas
composition. That design is maintained in the current React shell and shared design system;
the Vue port is not an additional runtime that needs restoring.

Although `f6f72ee0` is titled "snapshot uncommitted white-ui checkout state before backup push
(41 paths)", its preserved tree is identical to its parent `43a72f44`:
`15f6215b0ca75fe430695254e6db5bc1e5026900`. The title does not establish 41 recoverable changes.
Keep the checkpoint as history; do not reconstruct unrecorded dirty files or replay the archived
Nuxt/FastAPI tree.

## Current implementation

The supported application is Next.js and React. `package.json` runs `next dev` and `next build`
and declares the current Next.js, React, Auth.js, Prisma, and tRPC dependencies.

- `src/components/layout/app-shell.tsx` owns the tenant Studio viewport, shell, top navigation,
  canvas, mobile navigation, and route transition composition.
- `src/components/platform/platform-shell.tsx` supplies the matching platform shell.
- `src/app/globals.css` and `docs/design-system/DEVFATHOM-STUDIO.md` own the semantic tokens,
  typography, geometry, themes, responsive behavior, and shared component contract.
- `src/components/ui/` contains the maintained shared primitives.
- `src/app/api/trpc/[trpc]/route.ts` serves the current tRPC runtime with tenant actor and
  organization resolution; the archived FastAPI server is not its replacement.

These current sources supersede the archived Nuxt shell and FastAPI migration. Historical
prototypes are evidence, not current visual authority. This recovery changes documentation and
regression coverage only; it does not replace application code, dependencies, or deployment
configuration.

## Resolution

- Keep the archive tag as historical evidence.
- Do not restore `wip/white-ui-dirty-20260828` as a branch.
- Do not open a PR from the archived tree.
- Do not cherry-pick any of the three commits listed above.
- Resolve DEV-213 / issue #506 through this disposition record; no archive runtime is required.

The completion recorded as `ed873a6` is unavailable in this recovery checkout, so this document
and its regression coverage are reconstructed from the latest issue receipt and preserved
source. Source, diff, and Git metadata were inspected. Tests and all machine checks remain
unrun for this reconstruction, as requested.
