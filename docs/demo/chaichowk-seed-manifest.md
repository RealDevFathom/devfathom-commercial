# Chai Chowk staging seed manifest — preflight only

Issue: WHA-1382. Status: **blocked pending staging identity and permission metadata**.
No staging seed entry point has been implemented or executed. This document is
source preflight evidence, not a deployment handoff or a verified coverage report.

## Checkout provenance

- Checkout: `/Users/Saad/Developer/paperclip-worktrees/devfathom/codex/chaichowk-staging-demo-seed`
- Branch: `codex/chaichowk-staging-demo-seed`
- Exact source base: `2d3c0effc3af5d5bdd2351f831f231909b4432c0`
- Initial `git status --short`: empty; branch and HEAD matched the assignment.
- WHA-1382 assignment confirmed through the local Paperclip issue API.
- Only this manifest changed. Existing seeds, guards, schema and product code remain unchanged.

## Identity evidence and blocker

`scripts/seed-restaurant-e2e.ts` declares fixture organization `org_chai_chowk`.
`scripts/seed-restaurant-demo.ts:1278` creates the owner fixture using
`owner@chaichowk.pk`. Its control-plane helper stamps a Restaurant Operations
package on that fixture organization. These declarations do **not** establish
the actual staging organization, account existence, branch access or entitlements.

WHA-1384 owns the independent staging/account audit. At preflight, its issue thread
contained only the workspace-ready comment, with no verified target metadata.
The assignment explicitly requires stopping when identity or permissions are missing.

Unblock owner: WHA-1384 auditor, coordinated by Codex Chief of Staff. Supply sanitized
staging organization ID/slug/vertical; owner existence and ID or explicit absence;
existing branch and role assignments; enabled Restaurant/Catering modules; and
the approved target identifier plus secret **names**. If access is unavailable,
record the specific owner-run read-only preflight needed. Never put passwords,
password hashes, PINs, tokens or connection strings in the issue or this manifest.

Pharmacy is a separate vertical in `src/lib/vertical-catalog.ts`. No Pharmacy
workspace or membership is authorized here. A separate workspace/account decision
is required before provisioning Pharmacy; do not convert the restaurant tenant.

## Existing seed safety findings

| Source | Evidence | Staging implication |
| --- | --- | --- |
| `scripts/restaurant-e2e-database.ts` | Requires disposable database name, rejects staging hosts/targets and common PostgreSQL ports, checks competing URL settings | Preserve the complete guard; do not route staging through this entry point |
| `scripts/pharmacy-e2e-environment.ts` | Requires explicit Pharmacy E2E opt-in and disposable target; rejects staging, shared targets and common ports | Preserve the complete guard; Pharmacy fixtures are not staging provisioning |
| `scripts/seed-restaurant-e2e.ts:516` | Rejects runtime SUPERUSER/BYPASSRLS, then enters platform context; later replaces permission relations through nested `deleteMany` | Restricted runtime role alone does not make the seed additive |
| `scripts/seed-restaurant-demo.ts:1034` | Upserts package/module configuration and updates organization commercial settings | Cannot preserve existing entitlements by calling this helper |
| `scripts/seed-restaurant-demo.ts:1278` | Owner upsert replaces password on rerun and assigns fixture manager role on creation | Never invoke against an existing staging account |
| `scripts/seed-restaurant-demo.ts:1142` | Updates base fixture catalog, prices and device presentation | Fixture IDs are not permission to overwrite staging business rows |
| `scripts/seed-restaurant-demo.ts:2375` | `countSeeded()` returns planned array lengths | These are not observed database counts or proof of safe reruns |

Both environment guard files were read in full. Existing seed executables were
not imported or run. Full seed/service correctness review remains outstanding.
`src/lib/demo` is absent at this exact base; the historical graph pointer is stale.

## Proposed owned implementation, after unblock

- `scripts/seed-chaichowk-staging.ts`: separate, default-dry-run entry point with
  explicit target confirmation, tenant/account fence, stable synthetic IDs,
  transactional serialization and collision refusal. Preserve credentials,
  permissions and existing business rows; suppress external effects.
- `scripts/seed-chaichowk-staging.test.ts`: focused guard, failure, concurrency,
  rollback and rerun regression coverage, using one newly owned disposable DB
  when database verification is needed.
- This manifest: replace proposed coverage with observed counts and evidence.

The legacy source contains candidates for catalog/menu, floor/tables/staff,
customers/loyalty, suppliers/stock/purchases, orders/KDS, bills/payments/drawers,
daily closes and insights/history. Candidate data is not proof that these flows
are reachable by the staging owner. Modifier dependencies, refunds, catering and
report projection service paths still require assessment. No broader fixture file
ownership is claimed. WHA-1383 owns the independent workflow coverage report;
WHA-1384 owns the deployment handoff.

## Commands, counts and limitations

- `pwd`, `git status --short`, `git branch --show-current`, `git rev-parse HEAD`:
  exit 0; correct checkout, clean initial state, assigned branch and exact base.
- `codebase-memory-mcp cli list_projects '{}'`: succeeded; assigned checkout was
  not indexed. No index created because work stopped at the identity gate.
- `ls -ld node_modules`: exit 1, directory absent. Installed Next guides therefore
  unavailable. No code/UI work or dependency installation performed.
- `rg` unavailable; used focused `grep`/`sed` source reads. Initial historical
  path probes for `src/lib/demo`, `docs/demo` and
  `scripts/restaurant-e2e-environment.ts` failed; the actual restaurant guard is
  `scripts/restaurant-e2e-database.ts`.
- No runtime tests, typecheck, lint, format tool, migrations, build, browser,
  application or database commands executed. No runtime RLS claim made.
- Seed runs: **0**. Seed-created rows: **0**. Existing staging row counts: **unknown**.
  Dry-run zero-write proof, first-run invariants, rerun/password preservation,
  foreign-tenant preservation and concurrency tests: **not performed**.
- Runnable staging command and verified secure input names: **not yet available**.
  Do not substitute an E2E seed command. No account-ready or all-workflows-seeded claim.
- Ponytail skill and Claude-Mem tools were unavailable in this session; no nested
  CLI or agent launched. No shared index/cache or foreign worktree modified.
- No deployment, push, role changes, service restarts, cloud writes or schema changes.
  No data rollback required: this artifact is documentation only.
