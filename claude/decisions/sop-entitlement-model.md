# SOP entitlement model — capability gating by catalog, not by package

- Issue: WHA-264 (SOP entitlement lane 2 — capability gating), parent WHA-242
- Base: `8a46543565ed`
- Status: decided and implemented

## Problem

SOP depth is sold in tiers (bare execution / proof + verification + escalation /
cross-branch reporting + retention export), but every restaurant package includes
the `restaurant-sop` module. The existing `requireLicensedModule` middleware
therefore answers only "does this organization have SOP at all" — it cannot
answer "how deep", and there was no other gate.

The obvious shortcut — checking the organization's package key — is wrong:

- A package is only one of three ways an entitlement is acquired.
  `resolveOrganizationEntitlements` composes `PACKAGE`, `CONTRACT` and `OVERRIDE`
  sources into the same module/limit shape, so a package check denies an
  organization that legitimately holds the entitlement by contract.
- Package contents and limit values are repriced. A package check hard-codes
  today's matrix into authorization code in a dozen call sites.
- It leaks commercial naming into server error messages.

## Decision

Gate SOP depth on the **module and limit catalogs only**, through one
declarative table.

`src/lib/module-catalog.ts` gains:

- `EntitlementRequirement` — `{ modules, limits: [{ key, atLeast }] }`, where
  every key is a real `vertical-catalog` module key or limit key.
- `evaluateEntitlementRequirement(entitlements, requirement)` — pure, fail-closed
  (a limit key the organization was never granted counts as `0`), and reports
  which modules and limits were short.
- `SOP_DEPTH_REQUIREMENTS` — the single table mapping each SOP depth to its
  requirement, plus `evaluateSopDepth` / `hasSopDepth` / `sopDepthDenialMessage`.

`src/server/routers/restaurant-sop-execution.ts` calls `assertSopDepth` at the
top of each resolver, before any database work. Entitlement and authorization
stay independent gates: `sop:complete` / `sop:verify` still decide *who* may act,
the catalog decides *whether the organization bought the surface*. Both must pass.

## The depth table

| Depth | Required modules | Required limits |
| --- | --- | --- |
| `sop.execution` | `restaurant-sop` | — |
| `sop.evidence` | `restaurant-sop` | `sop.evidenceRetentionDays` ≥ 365 |
| `sop.verification` | `restaurant-sop` | `sop.evidenceRetentionDays` ≥ 365 |
| `sop.waiver` | `restaurant-sop` | `sop.evidenceRetentionDays` ≥ 365 |
| `sop.escalation` | `restaurant-sop`, `restaurant-integrations` | `integrations.connections.max` ≥ 1 |
| `sop.crossBranchReporting` | `restaurant-sop`, `restaurant-insights` | `restaurant.locations.max` ≥ 2, `restaurantInsights.retentionMonths` ≥ 36 |
| `sop.retentionExport` | `restaurant-sop`, `restaurant-insights` | `sop.evidenceRetentionDays` ≥ 1095, `restaurantInsights.retentionMonths` ≥ 36 |

Each threshold is a named, documented constant with a semantic justification,
not a tier ordinal:

- `AUDIT_EVIDENCE_RETENTION_DAYS = 365` — a manager's verify/reject/waive
  decision and the sha256-addressed artifact it was made against are only a
  control if they are still retained when an auditor arrives. The whole proof
  family therefore keys off the one limit that expresses that.
- `STATUTORY_EVIDENCE_RETENTION_DAYS = 1095` — exporting an evidence archive is
  only offered where the contracted window actually spans multiple years.
- `MULTI_BRANCH_MIN_LOCATIONS = 2` — cross-*branch* reporting is meaningless
  below two licensed branches.
- `MULTI_YEAR_ANALYTICS_RETENTION_MONTHS = 36` — reporting over historical
  periods needs analytics retention beyond the operating year.
- `MIN_INTEGRATION_CONNECTIONS = 1` — escalation chains fan out over the
  organization's licensed external connections.

Applied to the packages in the catalog at this base, the table reproduces the
intended commercial matrix exactly: entry tier gets execution; the middle tier
adds evidence, verification, waiver and escalation; the top tier adds
cross-branch reporting and retention/export. That mapping is an *outcome* of the
catalog values, not an input — `module-catalog.test.ts` asserts the matrix by
feeding each package's own `moduleKeys`/`defaultLimits` through the evaluator,
and a separate test proves a contract that raises only
`sop.evidenceRetentionDays` grants the proof family without changing the package.

## Consequences and known seams

- `sop.crossBranchReporting` and `sop.retentionExport` have no procedure at this
  base — no SOP reporting router exists. The catalog entries and their tests are
  in place so the surface, when built, gates through the same table instead of
  inventing a second rule.
- The scheduler-side escalation handler (`sopEscalationHandler`) is **not**
  gated. `RestaurantJobContext` carries only `db` and the claimed job — it has no
  entitlement view, and adding one means changing `job-handlers.ts`, which is out
  of this lane. Router-side acknowledgement is gated; the job seam is recorded
  for the union owner.
- `src/app/(app)/restaurant/sop/page.tsx` still renders every action. An
  under-entitled organization is refused by the server with a catalog-key
  message rather than having the control hidden. UI is out of lane.
- Role-based assignment pools are explicitly out of scope here; they land with
  the job-roles commit `0e345ab` in union pass 2.
