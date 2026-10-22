# GitHub issue #434: already fixed

## Disposition

No archive code was ported. The security fix preserved by
`archive/fix/sec-next-upgrade` is already present on the current main-line history, so the
archived branch is obsolete and should not be reopened or cherry-picked.

## Current-code evidence

The archived change replaced broad dependency overrides with overrides scoped to the
consumers that require each dependency major. The current tree retains that behavior:

- `package.json:139-177` scopes `undici` independently beneath
  `@ai-sdk/provider-utils`, `@dotenvx/dotenvx`, `@vercel/blob`, `jsdom`, and `shadcn`.
- `package.json:155-157` scopes the `uuid` pin to `exceljs`.
- `package.json:168-170` scopes the `mysql2` pin to `prisma`.
- `package.json:139-177` contains no broad `deepmerge-ts`, `undici`, `uuid`, or
  `@fastify/busboy` override.
- `bun.lock:106-145` mirrors the same scoped override graph, so the manifest and lockfile
  agree.

The relevant archive patch changed only `package.json` and `bun.lock`. Its substantive
commit (`bfe0d34227ac32b0a6afd09e9ca9a50306394c49`) is an ancestor of the current tree and
was merged by PR #160. Later dependency updates changed versions and lockfile contents,
but did not undo the scoped-override fix.

## Archive review

Skipped every archived hunk because each is already represented on the main line:

- **Scoped `undici` overrides:** skipped to avoid replacing the same consumer-specific
  configuration with an older snapshot.
- **`exceljs`/`uuid` and `prisma`/`mysql2` scoping:** skipped because the exact scoping is
  already present.
- **Removal of broad `deepmerge-ts` and `@fastify/busboy` overrides:** skipped because
  those broad overrides are already absent.
- **Archived lockfile changes:** skipped because the current lockfile already records the
  scoped resolution graph and includes subsequent dependency upgrades.

No migration, runtime behavior, authorization rule, tenant boundary, pharmacy grant, or
WhatsApp delivery path is changed by this disposition.
