# Issue #494 / DEV-216: `rescue/WHA-242` archive disposition

**Decision:** close the archived branch as obsolete. Do not recreate the branch, open a PR from
the tag, or cherry-pick any of its commits. Keep tag `archive/rescue/WHA-242` (`d8696e47`) as
historical evidence.

## Evaluation basis

The issue lists five commits outside its historical `main` comparison. Each preserved commit was
inspected against `develop` at `9ea2d42`. Every feature is already on `develop`, usually in a
newer and broader form, so replaying the archive would duplicate migrations and overwrite
maintained code with older code.

| Commit     | Archived change                                      | Where `develop` already has it                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a678e149` | Chai Chowk tenant fixture in the restaurant E2E seed | `scripts/seed-restaurant-e2e.ts` seeds the `chai-chowk` tenant                                                                                                                                                    |
| `a24e10f0` | Bind workspace chrome to the session organization    | `assertWorkspaceIdentity` in `src/lib/tenant-brand.ts`, called from `src/app/(app)/layout.tsx`; ADR `docs/admin-platform/adr/006-workspace-identity.md`                                                           |
| `5b44fd62` | Gate SOP depth on the module and limit catalog       | `evaluateSopDepth` in `src/lib/module-catalog.ts`, enforced by `src/server/routers/restaurant-sop-execution.ts`; decision `claude/decisions/sop-entitlement-model.md`                                             |
| `296440a2` | Separate unavailable from exhausted SOP entitlements | `TemplateCapacity` union in `src/app/(app)/restaurant/sop/admin/sop-admin.tsx`                                                                                                                                    |
| `d8696e47` | Time-boxed checkout promotion engine                 | Migration `prisma/migrations/20260828140000_restaurant_promotions_core`, `src/lib/restaurant/promotion-evaluator.ts`, `promotion-snapshot.ts`, `promotion-caps.ts`, `src/server/routers/restaurant-promotions.ts` |

The archived promotion commit used different file names (`promotion-rules.ts`,
`promotion-snapshots.ts`) and its own migration. Its versioned rules, immutable application
snapshots, cap-safe reservations and forced row-level security are covered by the maintained
implementation, which also adds cap reservations, audit events and database tests
(`src/lib/restaurant/promotion-caps.db.test.ts`). Restoring the archived migration would create
a second, conflicting promotion schema.

## Resolution

- Do not restore `rescue/WHA-242` as a branch.
- Do not open a PR from `archive/rescue/WHA-242`.
- Do not cherry-pick any of the five commits.
- Any further promotion, SOP entitlement or workspace identity change starts from `develop`.

`tests/archive-recovery-494.test.ts` checks this record and that each evidence path still exists.
