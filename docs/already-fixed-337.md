# GitHub issue #337: already fixed

Issue #337 reported that creating a contract copied its temporary seat allowance into the
organization's durable `seatLimit`, leaving the higher allowance in place after the contract
expired or was terminated.

## Verification against the current code

The current implementation already keeps the two values separate:

- `src/lib/platform/commands.ts:595-642` synchronizes only contract-backed module entitlements.
  Its input no longer includes a seat limit, and it does not update the organization; the comment
  at lines 639-641 explicitly records why contract seats must remain contract-scoped.
- `src/lib/platform/commands.ts:2917-2953` stores `seatLimit` on the new contract and then calls the
  entitlement synchronizer without any operation that writes it to the organization.
- `src/lib/entitlements.ts:94-114` selects only live, in-window contracts. Expired and terminated
  contracts therefore cannot contribute an allowance.
- `src/lib/entitlements.ts:148-151` starts with the durable organization limit and raises the
  effective limit only for the live contracts returned by that query. When none remain, the
  organization base is the effective limit.

Focused regression coverage is also already present:

- `src/lib/platform/commands.contract-entitlements.test.ts:43-67` verifies that contract creation
  persists the contract allowance and module entitlement without updating the organization.
- `src/lib/entitlements.test.ts:131-169` verifies that an expired contract is excluded and the
  resolver falls back to the organization's base seat limit.

## Changes intentionally skipped

No production code, migration, or additional test was added because the reported defect and both
relevant regression paths are already fixed in the current tree. This issue is not a
`Recover work from archive/...` request, so there is no archive branch whose unrelated changes
should be ported.
