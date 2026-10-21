[QA][Pharmacy][SEV3] Pharmacy license ledger lists every other vertical’s modules
Labels: qa, pharmacy, sev3-minor, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000/organization`
- Package: Pharmacy Professional

## Test case

PH-SA-06

## Steps

1. Sign in as the Clifton pharmacy owner.
2. Open `/organization`.
3. Read License and modules.

## Expected

The ledger shows the pharmacy modules this package grants. Agency, restaurant, and hospitality modules are not part of this workspace’s license list.

## Actual

The ledger lists the full catalog. Pharmacy modules above are ENABLED / PACKAGE. The rest are DISABLED / NONE, including Agency Core, Banquets and Events, Central Reservations, Hotel Core, Hotel Marketing, Menu and Costing, Night Audit, Restaurant Core, Restaurant Insights, Restaurant Workforce, Travel Agents, Projects, HR, and the other non-pharmacy modules. They are not enabled. They are still presented as this pharmacy’s license ledger.

Rival Essentials navigation correctly hides loyalty, marketing, prescriptions, the pharmacist queue, substitution, and the controlled register. This issue is the organization ledger, not the sidebar.

## Evidence

- `qa/pharmacy/evidence/fu-_organization.txt` (License and modules)
- `qa/pharmacy/evidence/fu-_organization.png`
- `qa/pharmacy/evidence/mt-01-rival-inventory.txt` (Essentials nav stops at cameras, regulatory, organization, settings)

## Suggested code area

`src/app/(app)/organization/organization-admin-content.tsx` — `entitlements.modules` is rendered in full. The entitlements payload includes modules outside the pharmacy vertical.

No fix is proposed here.
