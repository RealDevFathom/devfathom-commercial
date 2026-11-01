# PR64 dependency audit follow-up

This supersedes the remaining-advisory and initializer-check limitations recorded
in `../pr64-operation-approval/README.md`. No Azure files, AGENTS.md, application
security migrations, initializer pins or existing tests were changed.

## Dependency decisions

All nine previously affected packages were inspected using the installed lockfile,
`bun audit --production`, full `bun audit --json`, and published npm metadata on
2026-10-29. Eight now resolve outside every reported vulnerable range:

| Package           | Before | After   | Compatibility validation                                                                                                                                                                                |
| ----------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @azure/msal-node  | 5.4.3  | 7.1.2   | Scoped override beneath the existing identity SDK; real SDK client-secret, cache, DefaultAzureCredential and bearer-provider tests with an injected transport; existing storage/AI tests                |
| @vitest/mocker    | 4.1.10 | 4.1.12  | Updated with its matching Vitest patch release; affected test suites exercise mocks and component rendering                                                                                             |
| vitest            | 4.1.10 | 4.1.12  | Matching coverage-v8 patch; existing tests retained and run                                                                                                                                             |
| deepmerge-ts      | 7.1.5  | 8.0.2   | Prisma uses the unchanged deepmerge function, not the changed mergeInto or metadata types; nested-config/input-immutability/cyclic-graph tests, Prisma generation and full fresh-database migration run |
| fast-uri          | 3.1.8  | 3.1.9   | Same-major patch override; configuration loading, migrations and application tests                                                                                                                      |
| qs                | 6.15.2 | 6.17.1  | Same-major minor override; application/router tests and build                                                                                                                                           |
| systeminformation | 5.31.7 | 5.33.18 | Same-major patch override under development tooling                                                                                                                                                     |
| vite              | 8.1.5  | 8.3.5   | Same-major minor override; complete affected Vitest run                                                                                                                                                 |
| deepmerge         | 4.3.1  | 4.3.1   | Unavoidable development-only finding described below                                                                                                                                                    |

The MSAL override is scoped to @azure/identity; the identity SDK and application
integration code remain unchanged. Synthetic credentials and an injected HTTP
transport exercise actual SDK/MSAL request construction, trusted endpoint origin,
token acquisition and caching without network calls or host credentials. The
Prisma deepmerge override is validated through real config loading and migrations.
No audit suppression, severity filter, dependency removal, test skip or reduced
assertion was used.

## Final audit results

`bun audit --production`: **PASS**, exit 0, no vulnerabilities, 752 production
packages checked.

Full `bun audit`: **FAIL**, exit 1, one low-severity development-only advisory:
[GHSA-gcqx-w48m-w2h4 / CVE-2026-93753](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
prototype poisoning in deepmerge mergeObject. Affected range is `>=4.2.0 <=4.3.1`;
the advisory's patched-version field is **None**. The npm registry's latest release
is **4.3.1**, and the current shadcn 4.23.0 and @shadcn/registry 0.2.1 both declare
`deepmerge: ^4.3.1`. It is reachable only from the shadcn development dependency;
`bun audit --production` excludes it. There is no published patched version to
select. Downgrading outside the advisory range, silently replacing the API with a
different merger, or removing the developer tool would not be a verified compatible
security update. The full audit is therefore explicitly not claimed to pass.

Metadata evidence:

- [Published deepmerge metadata](https://registry.npmjs.org/deepmerge/latest)
- [Published shadcn metadata](https://registry.npmjs.org/shadcn/4.23.0)
- [Published registry-tool metadata](https://registry.npmjs.org/@shadcn%2fregistry/0.2.1)
- [DeepmergeTS 8.0.0 release changes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0)

## Initializer snapshot check

The original test compares the approved frozen initializer against the explicitly
selected source root. Testing the evolving application root cannot satisfy its
immutable pins. Preserved Git revision
`96969faa8e0451bb4058cf6f77d7d0405eaeb388` matches all 159 approved source records
exactly. `scripts/test-initializer-snapshot.py` materializes those verified
bytes and runs the **unchanged** original tests through INITIALIZER_SOURCE_ROOT:
**25 passed, zero skipped**. No snapshots or expected hashes were regenerated.
CI now runs this source check and `bun audit --production` as recorded gates.

## Validation

- Typecheck: PASS with `NODE_OPTIONS=--max-old-space-size=8192`.
- Lint: PASS.
- Production webpack build: PASS.
- Affected Vitest: 669 passed, zero failed, zero skipped. Includes all earlier
  PR64 regressions plus real SDK/merger compatibility and affected storage/AI tests.
- Fresh isolated local DB: 102 passed, zero skipped, plus full tenant-isolation
  verification. Includes all 44 wallet bridge and 36 reporting opt-in cases and
  actual Prisma configuration loading, role preparation, migrations and seeding.
- Frozen install: PASS (`bun install --frozen-lockfile --ignore-scripts`).
- Initializer source runner: 25 passed, zero skipped, unchanged original assertions.
- Production audit: PASS, exit 0. Full audit: exit 1 for only the exact unpatched
  development advisory in [full-audit.json](./full-audit.json).
