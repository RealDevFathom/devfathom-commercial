# Issue #283 — already fixed

Verified against the current code at `9f30725`.

The reported picker/server mismatch already uses the expected clear-error resolution:

- `src/lib/pharmacy/goods-receipt.ts:78` defines the rejection as “A different qualified person must enter their PIN.”
- `src/lib/pharmacy/goods-receipt.ts:129-145` requires the selected PIN holder to be the receipt's qualified person and returns that clear rejection for an ineligible witness or invalid PIN.
- `src/app/(app)/pharmacy/purchasing/receiving/page.tsx:1287-1298` tells the user that the selection must be the qualified person named on the receipt and cannot be the posting user.
- `src/app/(app)/pharmacy/purchasing/_lib/console.ts:118-121` maps a blocked post to a field-level message explaining that the qualified person named on the receipt must enter their PIN.
- `src/lib/pharmacy/controlled-purchase-witness.test.ts:73-91` covers selecting somebody other than the receipt's qualified person, including the explanatory response and absence of a credential update.

Per the issue instructions, no product code was changed and no test command was run.
