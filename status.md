# DevFathom delivery status

Last reconciled: 2026-09-02 — Phase B documentation checkpoint for the exact candidate below.

Restaurant is **not yet release-complete**: the accepted local implementation candidate and its
clean automated evidence exist, but the complete browser E2E gate, Linux/amd64 image gate,
authorized integration, deployment, and production smoke remain.

## Authoritative checkpoint

| Item                        | Exact state                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Canonical private candidate | `fee1686e16f532cb6ffad61f4c1320fd29909e7d`                                                                      |
| Candidate parent            | `4042a1a96159674da6cf3c7d16fbdee637a74d9f`                                                                      |
| Candidate working tree      | Exact candidate used for the automated gate and pending browser completion                                      |
| Browser checkpoint          | Restaurant 13/15 on `f2c59457`; SuperAdmin and Agency rerunning on `fee1686e` after fixes `4042a1a9`/`fee1686e` |
| Remote/release state        | Nothing from this candidate was pushed, merged, deployed, or production-smoked                                  |

## What is implemented in the candidate

The assembled source covers Restaurant onboarding; staff, roles, branches, and devices; catalog,
menu, pricing, modifiers, and OCR import; POS, dine-in/takeaway/direct delivery, tables, KDS, orders,
discounts, complimentary items, payments, split bills, refunds, voids, drawers, and daily closing;
Pakistan tax and custom tax profiles; recipes/BOM, ingredients, stock, wastage, suppliers, purchasing,
and alerts; shifts/workforce; SOP library, schedules, evidence, verification, escalation, scores, and
audit; customers/loyalty; dashboard, finance, reports, analytics, and multi-branch foundations.

Important product boundaries:

- Printing has durable jobs, routing, idempotency, and ESC/POS rendering, but only a simulation
  adapter. No physical, network, or OS printer I/O has been accepted.
- Direct connected Delivery includes publications, addresses, zones, frozen snapshots, PREPAID/COD
  kitchen handoff, settlement, close, Reports, and Insights. Marketplace providers and full driver
  logistics are deferred.
- Offline POS supports the accepted local new-order capture/replay design. Its browser scenario is
  not green because the open-order count assertion failed under WHA-1144.
- OPay New 9220 is only a candidate card terminal. No provider documentation, credentials,
  authorization, reconciliation, or hardware acceptance has been completed.
- Pakistan tax calculation/configuration exists. Fiscal filing, fiscal-device certification,
  authority e-invoicing, and legal/accounting approval remain external.

## Accepted evidence

- Exact-candidate automated gate on `fee1686e16f532cb6ffad61f4c1320fd29909e7d`:
  serialized Vitest **1139 files / 4046 tests**, **0 failed**, **0 skipped**. The evidence file
  `vitest.json` has SHA-256
  `0283e2c28797f46488ce284457f5c6b732e421690dab9874122627b812740b3c`.
- The gate applied **56 migrations**. The restricted runtime role was LOGIN-only with superuser,
  bypass-RLS, create-database, create-role, and inherit all false.
- Lint, `tsc`, Next.js build/type generation, Prisma generation, RLS verification, and email-collision
  verification each exited 0. The Linux/amd64 image gate was **NOT RUN** because Docker remains
  pending.

- WHA-1108 final-controls artifact `fc2841e5c6dd08d184f9e091f145b0ca912f7198`
  (parent `958575ba`): focused Vitest **63 passed**; final-controls browser acceptance **5/5**.
  One separately opt-in restoration test was skipped in that focused run.
- WHA-1116 composition `6cd73e4b5eb747b1d017d28ce6858d6606a7c6f9`: exact ten-file
  composition; focused Vitest **4 files / 81 passed**; correction rerun **11/11**; changed-file
  ESLint and Prettier passed; 8 GiB `tsc --noEmit` passed; worktree was clean.
- WHA-1129 static completion audit found no remaining repository-resolvable runtime development
  blocker. It made no changes and did not substitute for database, build, or browser QA.

The stale claims in `tests/e2e/restaurant-acceptance-manifest.ts` (friendly selectors as WHA-300,
offline order capture as under correction, golden-byte printing as WHA-228, and closed lanes
WHA-228/282/286/297/298/299/300 listed as active — all `done` in Paperclip, artifacts present in the
candidate; only WHA-281 remains open) are corrected in the commit that carries this status.
`validateRestaurantAcceptanceManifest()` reports no violations; Prettier passes.

## QA evidence that must not be treated as a green gate

- Restaurant browser acceptance is **13/15** on `f2c59457`, not a final count. WHA-1144 remains for
  the offline replay open-order count and split-tender receipt scenarios.
- SuperAdmin and Agency browser lanes are rerunning on `fee1686e` after fixes `4042a1a9`/`fee1686e`.
  Their final counts are placeholders for the supervisor until those runs finish.
- No browser result above proves the exact-candidate browser gate green. No release is claimed.

## Current work state

| Issue                         | State at handoff                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| WHA-1130 — documentation pass | Phase B reconciliation on the assigned documentation branch                               |
| Automated evidence            | Green on exact candidate `fee1686e`; Linux/amd64 image not run                            |
| Browser evidence              | Not green; WHA-1144 has two Restaurant failures, and SuperAdmin/Agency reruns are pending |

## Required continuation order

1. Preserve the exact candidate and evidence identifiers recorded above; do not treat the
   documentation commit as a new implementation candidate.
2. Run the pending Linux/amd64 image gate with Docker and retain its exact result.
3. Resolve WHA-1144 and complete Restaurant, SuperAdmin, and Agency browser acceptance against the
   exact candidate lineage. Do not promote provisional counts to final evidence.
4. Ask Saad for explicit authorization before any push, shared-ref merge, deployment, or production
   smoke. A healthy local preview or Paperclip Done count is not release proof.

## External inputs code work cannot close alone

- Card/online acquiring provider contract, OPay New 9220 documentation and credentials, test
  merchant account, device protocol, settlement, refunds, and physical acceptance.
- Physical printer, drawer, KDS, and camera hardware acceptance.
- Notification provider credentials and deliverability acceptance.
- Restaurant-authored SOP content, tax/rate/effective-date choices, loyalty and inventory operating
  policy, retention policy, and legal/accountant approval.

## Optional or deferred scope

Marketplace APIs, live rider tracking, route optimization, native mobile, reservations/waitlist,
stored value, payroll execution, tip payout, production batches, and full driver logistics remain
optional or deferred unless explicitly approved.

Detailed decisions and module-level scope remain in the
[Restaurant management system plan](industry-specific-docs/restaurants/restaurant-management-system-plan.md).
