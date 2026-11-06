# PR #374 notes: inventory write-off witness and branch authorization (#362)

These notes record what the pharmacy inventory write-off change enforces and how
its tests are arranged. Review results recorded against earlier heads of this
branch do not transfer to later commits.

## Authorization and no-effect contract

- Keep the `inventoryControl` / central `can()` decision for canonical
  `pharmacy:inventory`; do not duplicate role names, change wildcard/exact-grant
  rules, or weaken DENY-over-ALLOW precedence.
- Require an active actor assignment in the active tenant branch named by
  **input.branchId** before any witness, inventory, stock-balance, movement or
  custody read/write. Neither a selected-branch decoy nor a real witness is authority.
- No new admin exemption is inferred: ADMIN/SUPERADMIN still need an effective
  inventory grant and the actual-branch assignment. The inventory capability
  has no default static admin ALLOW (`src/lib/abac/policies.ts`).
- Retain the distinct active same-tenant witness requirement. Authorized control
  writes one negative WRITE_OFF movement and matching custody evidence.
- Regression matrix: authenticated-router cases (no grant, both DENY sources,
  wildcard DENY, missing/inactive assignment, sibling/foreign branch, assigned
  authorized control, explicit system-admin cases, witness failure) and
  PostgreSQL cases (full balances/movements/custody no-effect snapshots plus
  positive projection 10 -> 8 units).
- The real-DB suite explicitly skips without separate `TEST_DATABASE_URL` and
  `TEST_DATABASE_ADMIN_URL`. It requires a non-superuser/non-BYPASSRLS runtime and
  forced RLS on all four scoped stock/custody/assignment tables. Setup-owner
  snapshots are intentional so RLS cannot conceal an unauthorized write.
  Run only against a verified isolated migrated throwaway database. Synthetic
  fixtures remain; there is no reset/delete/cleanup SQL.

## Fixtures

- The schema and migration `20260828100000_vertical_configurable_departments`
  require `User.(organizationId, department)` to reference
  `OrganizationDepartment.(organizationId, key)`.
- The DB suite creates and asserts an active synthetic `LEADERSHIP` department for
  **each** of the two fresh organizations, before any actors or same/foreign-tenant
  witnesses. Migration-time backfill does not populate subsequently created test
  tenants. This fixture key supplies no permission.
- The synthetic organization fixture supplies schema-required `legalName` and
  `displayName`.
- Both foreign/inactive organization-reference rejection assertions expect
  canonical `BAD_REQUEST` with `That record is not in this workspace.` Router
  no-read/no-write checks and the complete setup-owner DB snapshot stay intact.

## Witness validation

- `writeOff` previously accepted any non-actor string as `witnessId`. It now resolves
  the witness by ID, organization, `ACTIVE` status and an active assignment to the
  write-off branch before reading or mutating inventory. A missing, inactive,
  unassigned or cross-tenant user therefore fails closed with `COAUTH_REQUIRED`.
- **Tenant isolation:** The lookup includes `organizationId` explicitly rather than
  relying only on tenant-scoped database policy. The persisted custody record
  continues to use the same organization and branch as the inventory movement.
- **DENY-over-ALLOW:** An unresolved witness is denied before lot, balance, movement,
  or custody operations. The existing self-witness denial remains in place.
