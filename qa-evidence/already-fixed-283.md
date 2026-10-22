# Issue #283 — already fixed

Verified against the current main-line HEAD (`16a2a3705a0bdd287f09ef4d1a42c0ac7cbbb4ca`).

The reported mismatch already has the allowed clear-error resolution:

- Goods-receipt posting still requires the selected PIN holder to be the qualified person stored on the receipt (`src/lib/pharmacy/goods-receipt.ts`, lines 129–139).
- Every rejected witness path returns the explicit message, “A different qualified person must enter their PIN.” (`src/lib/pharmacy/goods-receipt.ts`, lines 78 and 113–145).
- The receiving form tells the user before selection that the witness must be the qualified person named on the receipt and cannot be the posting user (`src/app/(app)/pharmacy/purchasing/receiving/page.tsx`, lines 1287–1298).
- If posting is rejected, the surfaced form error explains that the qualified person named on the receipt must enter their PIN (`src/app/(app)/pharmacy/purchasing/_lib/console.ts`, lines 118–121).
- Existing coverage verifies that selecting somebody other than the receipt's qualified person returns the explanatory message and performs no credential update (`src/lib/pharmacy/controlled-purchase-witness.test.ts`, lines 73–91).

Per the task instruction for an already-fixed issue, no product code or tests were changed and no test command was run.
