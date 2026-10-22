# GitHub issue #482: already fixed

Issue #482 was already fixed on the current branch by commit `0984d5334300a18e7e9df169efcf78f4d8a243af`.

## Code evidence

- `src/server/routers/pharmacy-sales.ts:932-945` accepts only a strict approval credential
  (`staffProfileId` plus a PIN) and a strict FEFO override (`inventoryLotId` plus a reason). The
  caller can no longer supply `approvedByUserId` or either approval-policy string.
- `src/server/routers/pharmacy-sales.ts:148-183` resolves the credential inside the scoped
  database transaction and rejects a missing, revoked, locked, inactive, cross-tenant, or
  self-approving supervisor. It also verifies every required capability through `can` and verifies
  the PIN before returning the authenticated approver's user ID.
- `src/server/routers/pharmacy-sales.ts:971-990` requires `pharmacy:manage` for a discount and
  `pharmacy:safety` for a FEFO override, then derives both the approver ID and fixed policy names
  server-side before calling the sales domain.
- `src/server/routers/pharmacy-sales.fefo-override.test.ts:219-286` contains focused regression
  coverage for rejecting caller-supplied approval text, rejecting self-approval, requiring the
  discount capability, and persisting server-derived approval evidence.

No additional code change or migration is needed.
