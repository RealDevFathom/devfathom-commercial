# Blocked after two failures at the same problem

Stopped under the user/repository two-failure rule. The broader relevant test run
failed twice in `src/components/pharmacy/medicine-pack-setup.procedure.test.ts`,
`makes the created effective pack selectable with the derived unit count`.

First run: the fixture defines a STRIP without a UNIT leaf, so packConversions
returns no selectable packs. Added the missing UNIT leaf to the fixture.
Second run: the hierarchy now resolves correctly, but the exact-array assertion
expects only STRIP while the workspace returns both UNIT and STRIP. No further
fix or test retry was attempted after this second failure.

Implementation in this commit:
- One shared router resolver derives purchasing multipliers from tenant-scoped,
  medicine-matched pack hierarchies for requisitions, quotes, purchase orders,
  goods receipts and central purchase orders; unresolved packs are BAD_REQUEST.
- Receipt and medicine creation require pharmacy:procurement, registered as a
  default-deny capability. Receipt medicine and pack reads explicitly pin tenant.
- Regression coverage includes inflated conversions, missing/wrong-medicine
  packs, permission refusal and explicit capability grants/denials.

Latest relevant test run: 6 files passed, 1 failed; 144 tests passed, 1 failed.
Initial focused router run: 2 files passed, 65 tests passed.
First typecheck identified the missing capability registration, now added.
The final typecheck result is recorded in the handoff response.

Remaining work: correct the pack fixture's expected selectable options, rerun
relevant tests and typecheck, and review before considering PR #173 complete.
