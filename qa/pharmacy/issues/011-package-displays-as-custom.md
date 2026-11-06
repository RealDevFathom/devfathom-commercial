[QA][Pharmacy][SEV3] Assigned Pharmacy Professional package displays as Custom
Labels: qa, pharmacy, sev3-minor, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000/organization`
- Created on the control desk as Pharmacy Professional, seat limit 10, currency PKR
- Organization id: `cmvhhkj1v000ggtjsplibyd6k`

## Test case

PH-SA-06, seen again on the tenant organization page

## Steps

1. Create the organization with the Pharmacy Professional package.
2. Sign in as the tenant owner.
3. Open `/organization` and read the summary cards and the license ledger.

## Expected

The package card shows Pharmacy Professional. Module rows that came from that package say so.

## Actual

The summary card reads **Package / Custom**. Seat card reads `1/10`, which matches the limit QA typed at creation. Pharmacy Core, Counter, Inventory, Procurement, Finance, Reports, Dispensing, Safety, and CRM are ENABLED with source PACKAGE. The name of the package is not shown.

The header uses `organization.package?.name ?? 'Custom'`, so a missing package relation is presented as a custom package.

## Evidence

- `qa/pharmacy/evidence/fu-_organization.txt`
- `qa/pharmacy/evidence/fu-_organization.png`
- `qa/pharmacy/evidence/sa-04-created.png` (control-desk create)

## Suggested code area

- `src/app/(app)/organization/organization-admin-content.tsx` line that renders `organization.package?.name ?? 'Custom'`
- The tenant query that loads `organization.package` (platform package rows are not visible to the tenant role if RLS hides `platform_packages`)

No fix is proposed here.
