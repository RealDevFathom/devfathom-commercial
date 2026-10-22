# GitHub issue #289 is already fixed

Issue #289 reported that a cash Family Khata collection reduced accounts receivable but did not increase the open cash drawer, producing a positive variance at close. The current code already contains the fix, so no production code was changed for this issue.

## Current-code evidence

- `settleFamilyKhata` requires the caller to supply `drawerSessionId` (`src/lib/pharmacy/family-khata.ts:153-161`).
- After recording the Khata payment allocations, the same settlement operation calls `recordPharmacyCashMovement` with that drawer, the full collected amount, and movement kind `PAID_IN` (`src/lib/pharmacy/family-khata.ts:193-219`).
- `recordPharmacyCashMovement` accepts only `PAID_IN` or `PAID_OUT`, validates the amount, locks the drawer's business day, and requires an `OPEN` drawer matching both the organization and branch before it writes the movement (`src/lib/pharmacy/settlement.ts:719-750`). These predicates preserve tenant and branch isolation.
- The expected-cash fold adds `PAID_IN` movements (`src/lib/pharmacy/settlement.ts:640-650`), and drawer close computes `expectedCashMinor` from that fold (`src/lib/pharmacy/settlement.ts:760-771`). Thus a 250 Khata cash collection now increases expected cash by 250.
- The focused unit test passes a drawer ID and asserts that a 7,000 Khata collection records a 7,000 `PAID_IN` movement against that drawer (`src/lib/pharmacy/family-khata.test.ts:73-90`).

## Archive recovery

This is not a “Recover work from archive/...” issue, and the repository has no archive branch to diff. No archived changes were ported or skipped.
