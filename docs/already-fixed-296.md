# GitHub issue #296: already fixed

The reported empty-history behavior is not present in the current code.

- `authorizeKhataCharge` loads Khata events before recording an over-limit manager override and
  passes those events to `calculateKhataHealthSuggestion`
  (`src/lib/pharmacy/family-khata.ts:375-391`).
- The history query is restricted by `organizationId`, `branchId`, and `familyAccountId`, preserving
  tenant, branch, and family-account isolation (`src/lib/pharmacy/family-khata.ts:381-387`).
- `calculateKhataHealthSuggestion` filters the supplied history to the requested window and derives
  charge, payment, overdue-charge, payment-time, and dishonoured-cheque values from it
  (`src/lib/pharmacy/family-khata.ts:51-86`).
- The derived figures are included in the suggestion returned for the recorded override decision
  (`src/lib/pharmacy/family-khata.ts:101-114`, `src/lib/pharmacy/family-khata.ts:378-399`).

Therefore, no production-code or test change is needed for issue #296.
