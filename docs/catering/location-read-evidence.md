# Catering location selector and unit labels — 2026-10-07

Issue WHA-1294; original owner 7025. Base 9797386ed42f739f765ad4de11c7df09e7c7b360, branch codex/restaurant-catering-20261007, owned catering-core/owned-repo checkout. No graph tool available in this session; used named router/service/test files. Prior authorized three-copy cleanup complete and reused; no further deletion.

## Change and exact files

- `src/server/routers/restaurant-catering.ts`: add `bookingLocations({branchId})` using existing catering read/module/actor/branch guards, active tenant+branch filter and id/name-only projection. Add current nullable base-unit metadata to live/frozen production requirements without mutating frozen snapshots.
- `src/server/routers/restaurant-catering.test.ts`: four selected cases covering actual ABAC role decisions, inventory/report denial, branch denial, capability/module/actor/input guards, live/frozen unit labels and missing-unit fallback.
- `src/lib/restaurant/catering-endpoints.db.test.ts`: one prepared restricted-DB case for catering-only staff, active/inactive/other-branch locations and inventory/report/cross-branch denial.
- `docs/catering/api-handoff.md`: exact additive UI contract, also copied to task-root api-handoff.md.
- `docs/catering/location-read-evidence.md`: this receipt.

Previously the UI location selector required inventory/report permission; catering now provides the minimum scoped labels. Existing consumption history already returns canonicalUnit id/name/abbreviation; no history change needed. Base-unit quantities remain distinct from canonical movement quantities. Labels are current metadata, not historical snapshots. Missing base-unit metadata is explicit null with original ID preserved.

## Commands and results

From owned-repo:

- `node node_modules/prettier/bin/prettier.cjs --write src/server/routers/restaurant-catering.ts src/server/routers/restaurant-catering.test.ts src/lib/restaurant/catering-endpoints.db.test.ts`: exit 0.
- `env -u DATABASE_URL -u TEST_DATABASE_URL node node_modules/vitest/vitest.mjs run --configLoader runner src/server/routers/restaurant-catering.test.ts --testNamePattern 'booking locations|groups exploded requirements|labels frozen requirements' --cache=false --maxWorkers=1`: exit 0, 4 passed, 20 skipped, 32.57s. Tests use real tRPC/ABAC/actor middleware with mocked persistence; not DB acceptance.
- `node node_modules/eslint/bin/eslint.js src/server/routers/restaurant-catering.ts src/server/routers/restaurant-catering.test.ts src/lib/restaurant/catering-endpoints.db.test.ts`: exit 0, no diagnostics.
- `node node_modules/prettier/bin/prettier.cjs --check src/server/routers/restaurant-catering.ts src/server/routers/restaurant-catering.test.ts src/lib/restaurant/catering-endpoints.db.test.ts`: exit 0.
- `git diff --check`: exit 0.
- `df -k .`: 2,442,892 KiB available (~2.33 GiB), below 4 GiB floor. No DB/build/browser launched, dependencies installed, or broad rerun.

Logs: task-root `location-read-evidence/{tests,lint,format,diff-check}.log`.

## Security review and limits

Scoped diff review: explicit tenant and branch predicates; strict input prevents caller-selected organization or extra projection; select exposes only id/name. Existing actor and module guards precede location lookup. Actual ABAC test has only catering role grants and proves both inventory:read and reports:operational remain denied. Shared roles, auth, procedure mapping and schema unchanged. Frozen label lookup uses stored baseUnitId, in-tenant units and no recipe recalculation. No newly observed source finding; no independent reviewer run claimed.

Restricted-DB test not run. Runtime queue adds exactly one new location case to the existing four endpoint/four changed-finance cases; no unchanged green service rerun. Existing runtime selector automatically includes the new endpoint case. Scoped typecheck remains unverified after prior bounded timeouts; not retried this run. Historical 12 DB-service/76 focused-source passes remain prior evidence, not proof for this delta.

Disposition: resource blocked. Local-board/coordinator owns restoring >=4 GiB free or supplying a concrete scoped resource decision, then returning the original owner for the bounded runtime queue and outstanding scoped typecheck. Parent heavy priority unchanged. Source is reviewable, not runtime accepted. Rollback is reverting this additive router/test/doc change; no data migration or historical ledger write occurred.
