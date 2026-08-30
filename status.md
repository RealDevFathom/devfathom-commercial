# DevFathom delivery status

Last verified: 2026-08-30 17:11 PKT (UTC+05:00)

This is the concise release-evidence ledger. A Paperclip status, committed candidate,
or green isolated test does not by itself prove that the composed product is released.

## Current checkpoint

- Branch: `WHA-954-reconcile-restaurant-operator-documentation-and-live-status`.
- Local base SHA: `629cd28634a736560ff9f86b25cdc7a9346d45bb`.
- State at the start of WHA-954: local-only and clean. This documentation reconciliation remains
  local-only; nothing from this branch has been pushed, merged, deployed to staging or any other
  environment, or released.
- Restaurant core implementation is present in the local base. Correction integration and the
  fresh automated, restricted-database, and governed browser gates remain pending. This checkpoint
  makes no completion, release-readiness, or production-availability claim.

## Historical private-integration checkpoint (superseded as current)

- Latest verified code SHA before this status-only update:
  `b3bb94e6d41ea4f6ea13e89b86f3686488487478`.
- Private integration branch:
  `WHA-842-compose-the-actual-restaurant-candidate-union-on-a-private-integration-branch`.
- State: local, clean, and unpushed. No shared branch, deployment, staging, or production
  environment moved.
- The host reboot preserved Git commits/worktrees and Paperclip records. It removed only
  disposable `/tmp` database/runtime state and local preview processes; those are reproducible
  and are not production data.
- Restaurant is not release-ready yet. SuperAdmin and Agency final gates have not started.

## Recovered wave integrated and independently reviewed

| Lane                                         | Private integration commits        | Evidence and residual                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reports correction (`WHA-914`)               | `83132fb4`                         | Focused 16/16 and composed build green. Final ordinary-browser CSV/download proof remains; task stays in review.                                                                                                                                                                |
| Restaurant activation (`WHA-916`)            | `dab15030`, `5a2dc9ed`, `085a00a6` | Command/onboarding, restricted PostgreSQL, and production browser evidence accepted. No provider/device/printer side effects.                                                                                                                                                   |
| Dashboard accessibility (`WHA-917`)          | `ef75fc4d`, `956da025`             | Composed 8 files/27 tests and lint green. Production axe/computed-style, keyboard, dark, reduced-motion, mobile error recovery, and Agency smoke remain browser-only.                                                                                                           |
| Inventory/Purchasing attribution (`WHA-918`) | `33600bf9`, `4fc4e653`             | Server-derived actor identity and branch-bound stock locations accepted. Composed router tests 38/38; candidate restricted PostgreSQL matrix 106/106 with zero skips.                                                                                                           |
| Delivery fail-closed (`WHA-919`)             | `9f22285e`, `5a0a31c5`             | New Delivery orders/publications rejected before business writes; historical Delivery remains readable. Composed 11 files/152 tests green. Browser presentation and Dine-in/Takeaway regression remain.                                                                         |
| Device rotation (`WHA-920`)                  | `351fb0cf`, `541031af`, `b3bb94e6` | Server-derived actor, two-person authorization, CAS/replay protection, one-time reveal, and device-scoped approver directory accepted. Composed non-DB device/shared-helper tests green; candidate restricted PostgreSQL 15/15. Real permission-scoped browser journey remains. |
| Camera production safety (`WHA-921`)         | `a59bd8d0`                         | Simulator is development/test-only; production fails closed without a real gateway. Composed 4 files/16 tests green. Vendor/hardware/browser streaming is an external gate.                                                                                                     |
| Commercial-limit resolver (`WHA-922`)        | `a2fd72f0`                         | Canonical explicit/alias/zero/invalid resolution accepted; focused 56/56. This is resolver foundation only, not consuming enforcement.                                                                                                                                          |

## Composed checkpoint gate

Executed from exact code SHA `b3bb94e6d41ea4f6ea13e89b86f3686488487478`:

- Changed-file ESLint: zero errors; one test-only unused-argument warning.
- Prisma schema validation: passed.
- Prisma client regeneration: passed; generated output is ignored and the Git tree stayed clean.
- TypeScript with 8 GiB heap: passed.
- Standard production build: passed; Next.js 16.2.12 generated 134 routes/pages.
- Aggregate changed-test run: 34 files, 382 passed, 24 database-gated skipped,
  3 failed in the pre-recorded `tests/vertical-foundation.test.ts` baseline.
- Git diff check: passed.

The three open Vertical Foundation failures are not hidden:

1. Two module/vertical rejection tests expect HTTP 400 but receive 500 because mocked failure-audit
   persistence fails.
2. The approved-consumer audit does not include seven existing Pakistan-tax files.

These were observed before this recovered wave as the same 18-pass/3-fail baseline. They remain a
release blocker until corrected and independently re-run.

## Restaurant completion state

| Surface                                | State                                   | Remaining release evidence/work                                                   |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| Onboarding and activation              | Implemented and privately integrated    | Final composed browser smoke.                                                     |
| Dashboard and analytics                | Implemented and privately integrated    | Browser accessibility/error/permission acceptance.                                |
| Menu, catalog, modifiers, pricing, OCR | Broad implementation present            | Real-image OCR correction/duplicate/publish and menu-to-POS E2E.                  |
| POS, orders, KDS, tables, checkout     | Broad implementation present            | Operated open-to-close, split/refund/void, table and kitchen lifecycle E2E.       |
| Delivery                               | Safely unavailable for new operations   | Product decision D06 plus full schema/provider work if Delivery is enabled later. |
| Pakistan/custom tax                    | Implemented                             | Inclusive/exclusive rounding, receipt/refund and branch browser proof.            |
| Inventory and purchasing               | Corrected and privately integrated      | Fresh composed restricted-DB and operated receive/wastage/deduction/alert E2E.    |
| Staff and workforce                    | Core scheduling/timekeeping implemented | Final role/branch browser regression.                                             |
| Devices/operators                      | Rotation security integrated            | Real two-person browser rotation and old/new-secret acceptance.                   |
| SOP/compliance                         | Broad implementation present            | Recurrence, evidence, manager verification, missed/escalation operated E2E.       |
| Customers/loyalty                      | Broad implementation present            | Earn/redeem/refund E2E.                                                           |
| Reports                                | Integrated                              | Ordinary-browser exports and access-denial proof.                                 |
| Cameras                                | Honest fail-closed boundary integrated  | Real vendor selection and hardware/streaming acceptance.                          |
| Multi-branch                           | Foundations present                     | Isolation, switching and organization-wide reporting E2E.                         |

## Remaining critical path after this safe pause

1. Correct the three Vertical Foundation baseline failures.
2. Implement consuming commercial ceilings for devices/terminals, monthly orders,
   concurrent registers, operators, and stock locations.
3. Close the accepted ingredient-substitution schema/configuration seam.
4. Run one fresh restricted-role PostgreSQL gate with migration/RLS/extension non-vacuity and
   zero skips from the frozen composed SHA.
5. Run the governed Restaurant browser E2E once: onboarding through menu/OCR, POS, KDS,
   settlement, inventory/purchasing, SOP, loyalty, devices, dashboard, tax, and reports.
6. Reconcile administrator/product documentation with the final operated UI.
7. Only after Restaurant is frozen, run SuperAdmin/control-plane E2E, then Agency every-module E2E.
8. Obtain Saad's explicit authorization before push, shared-ref merge, deploy, or production smoke.

## External owner/provider decisions

- D03: production card processor/terminal provider.
- D05: physical printer, drawer, and KDS hardware/vendor integration.
- D06: whether and how full Delivery is supported.
- Production camera gateway/vendor and hardware/browser streaming.
- Pakistan production tax/legal/accounting sign-off.

## Operating constraints

- Codex-only Paperclip execution unless Saad changes the instruction.
- One writer per surface and one independent reviewer; no redundant verification loops.
- Expensive composed gates run once at phase boundaries.
- Browser behavior and restricted-role database evidence outrank optimistic task status.
- Saad alone authorizes push, shared-ref merge, deploy, or live release.

Historical detail remains in [claude/devfathom-status.md](claude/devfathom-status.md).
