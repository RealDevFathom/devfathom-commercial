# DEV-230 / issue #473: `fix/sec-next-upgrade` archive disposition

**Decision:** close the archived branch as obsolete. Do not recreate
`fix/sec-next-upgrade`, open a PR from the archived tree, or cherry-pick `bc7a1683`.
Keep `archive/fix/sec-next-upgrade` as historical evidence.

## Evaluation basis

The issue records one unmerged commit, `bc7a1683`
(`bc7a16830952fc543617db23fed10d489eda6153`), titled
`fix(security): scope dependency overrides and document blocked tests`.
Its patch changes `package.json`, `bun.lock`, and `BLOCKED.md`.
The decision below compares that patch with develop at
`47518cbf94ac912d0d657122625af03b23bbd1c1`.

## Current configuration and archived differences

Current `package.json` already scopes Undici to its consumers:

| Consumer                    | Current Undici override                             |
| --------------------------- | --------------------------------------------------- |
| `@ai-sdk/provider-utils@^4` | `6.29.1` (provider-utils itself pinned to `4.0.62`) |
| `@vercel/blob`              | `6.29.1`                                            |
| `@dotenvx/dotenvx`          | `7.30.1`                                            |
| `shadcn`                    | `7.30.1`                                            |
| `jsdom`                     | `8.12.3`                                            |

There is no global Undici override. Other current consumer-specific resolutions
include `exceljs` / `uuid` at `11.1.1` and `prisma` / `mysql2` at `3.24.6`.
The dependency-scoping intent therefore does not require restoring the archive.

The archived patch is not identical to the current configuration: it removes the
provider-utils override, selects `uuid` `8.3.2` for ExcelJS, adds an
`@prisma/config` / `deepmerge-ts` `7.1.6` override, changes Hono from `4.12.27` to
`4.13.13`, and makes the `mysql2` override global. Replaying those historical
version choices would change the accepted dependency configuration rather than
recover the missing disposition. This record does not claim that every archived
version change was merged, or that the current dependency tree has a clean audit.
Any new dependency update requires its own current compatibility and security review.

## Historical evidence and resolution

The archive's `BLOCKED.md` records two failed test attempts, a successful retried
typecheck/build, and a non-clean audit with 27 findings. Those reports describe
that archived tree and environment only. Do not restore the old root blocker note
as a current status report or treat those results as validation of this recovery.

- Do not restore `fix/sec-next-upgrade` as a branch.
- Do not open a PR from `archive/fix/sec-next-upgrade`.
- Do not cherry-pick `bc7a1683`.
- Leave `package.json`, `bun.lock`, and current dependency resolutions unchanged.
- Resolve DEV-230 through this disposition and focused regression source.

This is source-only recovery. No machine checks were run; regression source remains
unexecuted by instruction. Historical check reports do not validate recreated bytes.
