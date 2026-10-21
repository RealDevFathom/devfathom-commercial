[QA][Pharmacy][SEV2] Every pharmacy package is offered as 1 default seat
Labels: qa, pharmacy, sev2-major, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Host: `http://admin.localhost:3000/platform/organizations/new?vertical=PHARMACY`
- Catalog source: `bun run db:seed` → `syncPlatformCatalog` (`prisma/catalog-sync.ts`)

## Test case

PH-SA-02

## Steps

1. Sign in as the platform super admin.
2. Open the new-organization form and continue as Pharmacy.
3. Read the commercial package options.

## Expected

The three pharmacy packages show the catalog seat ceilings: Essentials 10 users, Professional 50, Chain 2500 (`PHARMACY_PACKAGES` in `src/lib/vertical-catalog.ts`). The option grammar agrees with the number.

## Actual

The package dropdown labels are:

- Pharmacy Chain · 1 default seats
- Pharmacy Essentials · 1 default seats
- Pharmacy Professional · 1 default seats

All three are the same seat number, and the sentence uses the plural “seats” with 1. The form still lists only pharmacy packages, and the province names are human-readable. QA set the Clifton seat limit to 10 by hand; the saved org shows `1/10` seats. The defect is the package default shown to the operator, not the override.

## Evidence

- `qa/pharmacy/evidence/sa-02-pharmacy-form.png`
- `qa/pharmacy/evidence/gap-02-defaults.png`
- `qa/pharmacy/evidence/results.json` (`PH-SA-02`)

## Suggested code area

- `src/app/platform/(console)/organizations/new/page.tsx` — option label `` `${item.name} · ${item.defaultSeats} default seats` ``
- `prisma/catalog-sync.ts` — package rows are created without the catalog user limits, so `defaultSeats` stays at the schema default of 1
- `src/lib/vertical-catalog.ts` — `PHARMACY_PACKAGES` default limits (`pharmacy.users.max`)

No fix is proposed here.
