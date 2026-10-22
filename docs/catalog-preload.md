# Pharmacy catalogue preload

## Mapping decision

The preload extends the existing medicine aggregate; it is not a second product master.

| Asset field            | Existing domain destination                                                           | Decision                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                 | `Medicine.productName`, with `Medicine.catalogVersion` as the immutable origin marker | Pharmaceutical medicine, always created **unsaleable**.                                                                                                   |
| `active`               | unreviewed `MedicineProvenance` evidence only                                         | Never mapped to `Medicine.saleable`; the source marks every row active.                                                                                   |
| `alias`                | `MedicineAlias` with `LEGACY_CODE`                                                    | The source value is a legacy code. It is never written to `MedicineBarcode`.                                                                              |
| `packUnits`, `packQty` | `Presentation` and `PackLevel`                                                        | One presentation (`"<packQty> <packUnits>"`) and one provisional `BOX` pack level per source item; the database allows only CARTON/BOX/STRIP/UNIT levels. |
| `category`             | unreviewed `MedicineProvenance` assertion                                             | Kept as source evidence without inventing a new taxonomy.                                                                                                 |
| `class`                | unreviewed provenance only for `NARCOTICS`/`FRIDGE`                                   | These are pharmacist review hints. `controlled` and `coldChain` remain false. Other generic class text is not treated as clinical truth.                  |
| default prices         | catalogue-default columns on `PackLevel`                                              | Reference defaults only. Applied prices live per branch in `PharmacyCatalogBranchPrice`. No `MedicinePackMrp` is created.                                 |

Generic/salt, manufacturer, and barcode remain blank. The strict input schema rejects every unknown field, including quantity, stock value, supplier, and distributor data. The seed does not touch inventory lots, manufacturing batches, balances, counts, movements, or opening entries.

## Lifecycle and tenancy

New pharmacy creation enqueues `pharmacy.catalog.seed.v1`; it does not add the large catalogue to the onboarding transaction. The worker narrows its transaction with `app.current_organization_id` and clears platform scope before every tenant write. Rows have deterministic identifiers, use batched `createMany({ skipDuplicates: true })`, and a unique `(organizationId, catalogVersion)` `CatalogSeedRun`. A completed run is a no-op; a `RUNNING` run safely resumes after partial failure.

The seed (onboarding job and backfill) writes catalogue reference rows only. It never writes a branch price, a branch setting or a saleable medicine; those exist only behind the authorized tenant writers below, and the branch tables' row level security refuses a session without an assigned user.

## Prices and availability (branch-scoped)

Applied selling and purchase prices (`PharmacyCatalogBranchPrice`) and "use catalogue default prices" (`PharmacyCatalogBranchSetting`) are kept **per branch** (migration `20261023150300`). Both tables are keyed by `(organizationId, branchId, ...)` and have forced row level security: a row is visible and writable only to a user (`app.current_user_id`) with an active assignment to that active branch, and, when a writer has bound `app.current_branch_id`, only for that branch.

Every catalogue price or availability change goes through `src/lib/pharmacy/catalog/commercial.ts`, takes a `branchId`, and needs `pharmacy:catalog-settings` (the Owner template reaches it through `pharmacy:*`). The tRPC procedures (`setCatalogDefaultPrices`, `setCatalogPackPrice`, `setCatalogMedicineAvailability`, `catalogMedicine`) check it, and each writer, inside its transaction and before any other read or write, runs the central `can()` with the branch as a resource attribute and requires the caller's active assignment to the active branch. There is no administrator bypass: an administrator assigns themselves to a branch first. Audit rows carry the branch.

- **One transaction.** Authorization, the setting change, every price write and the audit insert run in one tenant-and-branch-scoped transaction; any failure, including a failed audit insert, rolls all of it back. Locks are taken in one order: branch setting, medicine, pack, branch price.
- **Default prices.** Turning the setting on copies each reference default into that branch only where the branch has no price of that kind yet, as one set-based statement per kind over the locked target set; turning it off never erases a price. Re-applying is idempotent and fills what a later catalogue seed added. A retry that has nothing left to apply writes nothing and records no audit.
- **Pack prices** are a compare-and-set: the caller sends the branch's selling and purchase prices as it last read them (`expected`), and a stale write gets `CONFLICT`. An identical retry is a no-op.
- **Availability** is organization-wide. A catalogue medicine becomes saleable only through `setCatalogMedicineAvailability`, which needs a positive selling price on the current pack version in the caller's branch and the regulated saleability rules (presentation, strength, DRAP registration accepted in review). A reviewed publication of a catalogue medicine needs a positive price in at least one branch.
- **Database guards** (migration `20261023150300`): triggers keep `catalogSellingPriceCount` on each pack and catalogue medicine equal to its positive branch selling prices. A catalogue medicine cannot be inserted saleable, cannot become saleable with no such price, and cannot lose its last one while saleable. A selling price needs the current pack version, and a priced pack cannot be superseded or moved until its branch prices are removed. The origin marker and the counts cannot be written directly.

## Existing-tenant backfill

Preview first, then apply:

```text
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --org <organization-id> --dry-run
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --org <organization-id> --apply
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --all-pharmacy --dry-run
```

The server action and the service both authorize through the central `can()` for `pharmacy:catalog-backfill`, with the platform actor modeled as the principal (its role grants and any per-actor rules form one rule set, so an explicit DENY wins). Only `SUPER_ADMIN` holds the exact grant; a session that still has to enrol MFA, a deactivated user and every other platform role are refused before any database access. Dry-run performs tenant-scoped reads only and returns counts. Apply uses the same seed-run idempotency key and the same unsaleable seed as onboarding, and records platform audit metadata containing actor, organization, catalogue version, and counts. Tenant names or IDs are never hardcoded.
