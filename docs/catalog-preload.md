# Pharmacy catalogue preload

## Mapping decision

The preload extends the existing medicine aggregate; it is not a second product master.

| Asset field | Existing domain destination | Decision |
|---|---|---|
| `name`, `active` | `Medicine.productName`, `Medicine.saleable` | Pharmaceutical medicine; inactive rows remain searchable but not saleable. |
| `alias` | `MedicineAlias` with `LEGACY_CODE` | The source value is a legacy code. It is never written to `MedicineBarcode`. |
| `packUnits`, `packQty` | `Presentation` and `PackLevel` | One presentation and one versioned pack level are created per source item. |
| `category` | accepted `MedicineProvenance` assertion | Kept as source evidence without inventing a new taxonomy. |
| `class` | unreviewed provenance only for `NARCOTICS`/`FRIDGE` | These are pharmacist review hints. `controlled` and `coldChain` remain false. Other generic class text is not treated as clinical truth. |
| default prices | catalogue-default columns on `PackLevel` | They are reference defaults, separate from nullable tenant selling/purchase prices. No `MedicinePackMrp` is created. |

Generic/salt, manufacturer, and barcode remain blank. The strict input schema rejects every unknown field, including quantity, stock value, supplier, and distributor data. The seed does not touch inventory lots, manufacturing batches, balances, counts, movements, or opening entries.

## Lifecycle and tenancy

New pharmacy creation enqueues `pharmacy.catalog.seed.v1`; it does not add the large catalogue to the onboarding transaction. The worker narrows its transaction with `app.current_organization_id` and clears platform scope before every tenant write. Rows have deterministic identifiers, use batched `createMany({ skipDuplicates: true })`, and a unique `(organizationId, catalogVersion)` `CatalogSeedRun`. A completed run is a no-op; a `RUNNING` run safely resumes after partial failure.

`PharmacyCatalogSetting.useCatalogDefaultPrices` is false by default. Enabling it copies each default only where that tenant pack's corresponding price is still null and appends an audit record. Disabling it does not erase owner-entered or previously applied prices.

## Existing-tenant backfill

Preview first, then apply:

```text
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --org <organization-id> --dry-run
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --org <organization-id> --apply
PLATFORM_ACTOR_ID=<superadmin-id> tsx scripts/backfill-pharmacy-catalog.ts --all-pharmacy --dry-run
```

The CLI and server action both require an actual `SUPER_ADMIN`. Dry-run performs tenant-scoped reads only and returns counts. Apply uses the same seed-run idempotency key as onboarding and records platform audit metadata containing actor, organization, catalogue version, and counts. Tenant names or IDs are never hardcoded.
