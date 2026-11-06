[QA][Pharmacy][SEV1] Onboarding sends the operator to a medicine page that cannot create a saleable medicine
Labels: qa, pharmacy, sev1-critical, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000`
- User: `owner@qa-clifton.test` (organization administrator)
- Routes read: `/pharmacy/medicines`, `/pharmacy/medicines/prices`, `/pharmacy/medicines/staged`

## Test cases

PH-PR-01, PH-PR-02

## Steps

1. Sign in and open `/pharmacy`. Step 8 says “Review and publish a medicine, then define its pack for receiving” and links “Set up medicines and packs”.
2. Open `/pharmacy/medicines`, `/pharmacy/medicines/prices`, and `/pharmacy/medicines/staged`.
3. Read every visible control. The reference-connectors disclosure was not expanded before the run stalled; the visible page text is what was captured.

## Expected

An administrator can create a medicine, give it a pack, and publish it as saleable, which is what onboarding step 8 and the inventory empty state ask for. With no imports, the page explains how to add the first medicine.

## Actual

The catalogue is a staged source review. The page says: “This screen establishes no linked draft, verified medicine or sellable balance.” With no preserved imports it says “No batches on this page.” There is no Create medicine, Publish, or Add pack control in the captured page text on any of the three routes.

Inventory then says “Set up a medicine and its pack, then receive a supplier delivery.” Purchasing says a medicine with an effective pack level is missing and links “Open the medicine register”, which is this same screen. Counter search has nothing to sell. Onboarding step 8 stays NEEDS YOU.

Opening stock, purchase receive, the first sale, discounts, returns, and batch/expiry selling are blocked behind this page.

## Evidence

- `qa/pharmacy/evidence/fu-_pharmacy_medicines.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_medicines.png`
- `qa/pharmacy/evidence/fu-_pharmacy_medicines_prices.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_medicines_staged.txt`
- `qa/pharmacy/evidence/fu-_pharmacy.txt` (step 8)
- `qa/pharmacy/evidence/fu-_pharmacy_inventory.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_purchasing.txt`

## Suggested code area

- `src/app/(app)/pharmacy/medicines/page.tsx`
- Staged catalogue and medicine reference workbench components used by that page
- `pharmacyMedicine.createMedicine` (server procedure exists; this issue is the operator screen)
- Onboarding copy that links step 8 to this screen (`src/lib/pharmacy/onboarding.ts` and the onboarding console)

No fix is proposed here.
