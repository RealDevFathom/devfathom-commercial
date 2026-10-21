# Restaurant growth evidence candidate — WHA-1400

This is a partial source component, not the full reviewed campaign loop.
Base/parent: `83899072f6f702d490f913faed86bf6430659437`.
Branch: `codex/restaurant-growth-20261007`.

## Changed files

- `src/lib/restaurant/growth-evidence.ts`
- `src/lib/restaurant/growth-evidence.test.ts`
- `docs/restaurant/growth/handoff.md`
- `docs/restaurant/growth/evidence.md`

Before: authorized financial comparison existed, but no Restaurant growth evidence
projection. After: server-only bounded comparison evidence with authorization,
strict input/source validation, exact major-to-minor conversion, private scope/hash,
code-owned definitions, and distinct unknown/stale/partial/zero/available states.
Gateway facts are empty and ineligible pending compatible shared definitions and
qualifying cohort evidence. No recommendation is fabricated.

## Verification

Commands from the isolated checkout:

```sh
node node_modules/vitest/vitest.mjs run src/lib/restaurant/growth-evidence.test.ts --no-cache
node node_modules/typescript/bin/tsc --project "$PAPERCLIP_RUN_SCRATCH_DIR/restaurant-growth-tsconfig.json" --pretty false
node node_modules/eslint/bin/eslint.js src/lib/restaurant/growth-evidence.ts src/lib/restaurant/growth-evidence.test.ts
node node_modules/prettier/bin/prettier.cjs --check src/lib/restaurant/growth-evidence.ts src/lib/restaurant/growth-evidence.test.ts
```

Final results: focused Vitest 1 file / 48 tests passed, exit 0; scoped TypeScript
exit 0, no diagnostics; ESLint exit 0, no diagnostics; Prettier exit 0.
TypeScript scratch configuration extends the absolute checkout `tsconfig.json`,
sets `incremental:false`, includes the two absolute changed source/test paths plus
`<checkout>/src/**/*.d.ts`, and `exclude:[]`. Imported dependencies are checked.

Initial focused run also passed 48/48. Initial scoped TypeScript exited 2:
BigInt literals were incompatible with the repository's ES2017 target, and the
scratch include omitted existing ambient auth declarations. One correction pass
replaced literals with `BigInt(...)` and included those existing declarations.
Final focused tests/type/lint/format passed after correction.

Used existing local dependencies through an ignored symlink; tests used
`--no-cache`. No install/package/lock edits. Generated an owned ignored Prisma
7.9.1 client with `node node_modules/prisma/build/index.js generate`, exit 0,
using deliberately nonworking synthetic loopback DATABASE_URL and
SHADOW_DATABASE_URL. No DB operation. Read installed Next component guide.
Code graph/Claude-Mem tools were unavailable; used narrow named source searches.

## Scope and evidence limits

Mocks prove adapter contracts and fail-closed projection; they do not prove SQL/RLS,
provider execution, posted receipts, persistence or delivery. Existing financial
core was not retested. Runtime code delegates to its current banked readers;
refunds are already included in net sales and are never subtracted twice.

Source review checked tenant/branch predicates, Restaurant/module/financial
capability denials, strict input/amount/source validation, source projection,
redacted failures, read-only calls, and absence of model/promotion mutations.
The private reports-router branch policy is mirrored because shared edits are
outside this lane; future policy changes must keep these aligned.

Not implemented: persisted generation/review/draft, recipe/inventory/waste/catering
adapters awaiting owners' contracts, UI, campaign dispatch/capture/outcomes.
No runnable composed browser/restricted-DB acceptance tests are delivered yet:
there is no composed route or approved storage contract to target. Such tests
must assert runtime role is neither superuser nor BYPASSRLS before tenancy claims.
Duplicate-review/draft, stale-generation approval, consent withdrawal and
unknown-no-resend tests await the actual persistence/delivery interfaces; these
are not covered by the 48 adapter tests. Generator malformed/injection/timeout
acceptance belongs to shared owner; this component tests only source validation,
projection and redacted source failure.

No heavy build/browser/DB tests, configured-model calls, credentials/private env
reads, live data/outreach/payment, migrations, push/merge/rebase/deploy, schedules,
or changes in concurrent owners' worktrees. Full campaign acceptance remains
blocked on frozen shared exports, centrally composed Restaurant review/draft
storage, qualifying cohort evidence and approved configured-model availability.
See `handoff.md` for exact interface/schema needs and coordinator actions.

Rollback: omit this additive candidate before integration. No shared runtime
registration or migration was changed.
