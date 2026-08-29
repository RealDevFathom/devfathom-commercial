# Restaurant completion plan

## Planning authority

**Problem and business outcome.** The accepted restaurant plan still says implementation is not started, while the canonical checkout contains substantial restaurant functionality; this plan replaces optimistic labels with code/test evidence and identifies the smallest dependency-correct work needed to reach an honestly acceptanced restaurant release.

- Exact base: branch `WHA-301-restaurant-completion-plan-code-grounded-coverage-matrix-and-next-minimal-milestone`, canonical `restaurant/v1` at `27b4e51165428e00248edc12d1b6e175f31933a6`.
- Spec level: **full specification (planning-only completion baseline)** because the remaining work crosses UI, devices, external adapters, security boundaries, and four actor classes. The accepted product baseline remains `industry-specific-docs/restaurants/restaurant-management-system-plan.md`; this document reports implementation coverage, not new product scope.
- Evidence rule: `Delivered` means canonical source plus a focused automated test exists. `Partial` means a coherent core exists but a named plan behavior is absent or stubbed. `Needs browser acceptance` means source/tests exist but the responsive, device, accessibility, or actor workflow has not been proven on this exact base. `External` means completion requires a vendor, jurisdiction, hardware, or human product decision. `Unbuilt` means no canonical implementation evidence was found. Issue status is never delivery evidence.

## Code-grounded coverage matrix

| Plan module / requirement | Status | Exact canonical evidence | Missing proof or boundary |
| --- | --- | --- | --- |
| Vertical-aware platform, packages, onboarding, default branch, activation | Delivered | `prisma/schema.prisma` (`OrganizationVertical`, `Organization.vertical`, `RestaurantBranch`); `src/lib/vertical-catalog.ts`; `tests/vertical-foundation.test.ts` (default branch, admin assignment, role templates, mismatched packages, module compatibility, active-vertical immutability, activation preflight) | Production bootstrap/deployment is not claimed. |
| Restaurant Core: branches, staff, jobs, devices, operator credentials, sessions | Needs browser acceptance | schema models `RestaurantBranch`, `RestaurantStaffProfile`, `RestaurantJobRole`, `RestaurantRegisteredDevice`, `RestaurantTerminalSession`; routers `restaurant-staff.ts`, `restaurant-jobs.ts`, `restaurant-devices.ts`; routes `/restaurant/staff`, `/restaurant/staff/roster`, `/restaurant/devices`; `tests/restaurant-m2-contract.test.ts`, `tests/restaurant-m2-rls.test.ts` | Friendly branch/operator selection is active WHA-300; role-profile provenance UI is WHA-286. Do not duplicate. |
| Tax, service charge, business date, numbering | Delivered | schema `RestaurantTax*`, order/receipt sequences; `src/lib/restaurant/tax-calculator.ts`, `tax-contracts.ts`, `order-numbers.ts`; `tests/restaurant-tax-core-rls.test.ts`, `tests/restaurant-m4-acceptance.test.ts` (concurrent numbering/DST), `tests/restaurant-m5-acceptance.test.ts` (receipt allocation) | Jurisdiction/fiscalization policy remains External under D02/D15. |
| POS orders, floor, table, item/course lifecycle, KDS | Needs browser acceptance | schema `RestaurantFloor` through `RestaurantKitchenTicketItem`; order/KDS REST routes under `src/app/api/restaurant/{orders,kds}`; `/pos`, `/kds`; `tests/restaurant-m4-acceptance.test.ts`, `tests/restaurant-m4-kitchen-flow.test.ts`, `tests/e2e/restaurant-pos-kds.spec.ts`, `tests/e2e/restaurant-pos-kds-resilience.spec.ts` | Existing browser specs prove a fixture path, not final four-actor acceptance, tablet matrix, or hardware. |
| Bills, split tender, cash drawers, daily close, refunds/voids | Delivered | schema `RestaurantBill` through `RestaurantMoneyIdempotencyKey`; checkout/cash REST routes; `tests/restaurant-m5-acceptance.test.ts` (odd-cent split, tips, cross-day refund, immutable close, concurrent receipts), `tests/restaurant-terminal-payments.test.ts` | Real terminal integration is under independent review WHA-297; payment processor/card-device selection remains External (D03). |
| Menu, brands, catalog, recipes, modifiers, combos, price lists, publication/dayparts | Delivered | schema `RestaurantBrand` through `RestaurantBranchMenuItemOverride`; routers `restaurant-catalog.ts`, `restaurant-menus.ts`; `/restaurant/catalog`, `/restaurant/menus`; `tests/restaurant-m3-acceptance.test.ts` (canonical ownership/history/localization/module guards), `tests/restaurant-m3-publication-availability.test.ts` | RTL visual/device proof is not established; OCR import is a separate delivered adjunct (`restaurant-menu-import*`, focused router/DB/E2E tests). |
| Inventory and purchasing | Needs browser acceptance | schema `RestaurantStockLocation` through `RestaurantInventoryIdempotencyKey`; routers/pages `restaurant-inventory*`, `restaurant-purchasing*`; `tests/restaurant-m6-acceptance.test.ts` (receiving/WAC, counts, threshold, atomic transfer, negative stock/reversal, recipe conversion), M6 RLS/governance tests | Final admin workflows and reconciliation browser acceptance remain. Costing/backdating policy is External under D07. |
| Workforce scheduling and attendance | Partial | schema `RestaurantShift`; `src/server/routers/restaurant-shifts.ts`; roster route; `tests/restaurant-shifts-rls.test.ts` and router tests | Shift scheduling exists; no code-grounded evidence for swaps, break tracking, clock-in/out, late-arrival workflows, or labour-hour export. Payroll/tip payout remains excluded. |
| SOP, recurrence, evidence, verification, escalation, notifications | Partial | schema `RestaurantJob` through `RestaurantNotificationDelivery`; SOP/job/notification routers and routes; `tests/restaurant-m7-acceptance.test.ts` (worker concurrency/recovery, immutable versions/evidence, verification, late/missed, escalation, in-app read state), M7 RLS/governance/concurrency tests | In-app delivery is live. Page and `src/lib/restaurant/{notifications,sop-escalation,webhook-inbox}.ts` explicitly label email/SMS/push/WhatsApp and signature verification as stubbed; provider choice/delivery guarantee is External (D21). |
| Customers, consent, loyalty, visit/order history | Needs browser acceptance | schema `RestaurantCustomer`, identifiers/interactions/tags/consent, loyalty program/account/ledger; customer/loyalty routers/pages; `tests/restaurant-m8-{acceptance,governance,rls}.test.ts`, focused router tests | Wallet passes are active WHA-298 and are not delivered here. Final customer/loyalty browser acceptance and policy decisions D08 remain. |
| Insights, item mix, liability, restricted labour cost | Needs browser acceptance | schema `InsightDailyRollup`, `InsightLoyaltyLiability`, `InsightItemMixRollup`, `LabourCostFact`; router/page `restaurant-insights*`; `tests/restaurant-m8-governance.test.ts` and `src/server/routers/restaurant-insights.test.ts` (branch/consolidated guards, labour dual-capability) | Metric/freshness/rebuild policy is External under D22; final reconciliation and browser acceptance remain. |
| Promotions | Partial | schema `RestaurantPromotion*`; evaluator/snapshot/schedule source and tests under `src/lib/restaurant/` | Money/loyalty/insight integration is WHA-281; offline parity/admin console is WHA-282. Both blocked; do not create replacement lanes. |
| Integrations, cameras, terminal devices, webhooks | Partial | camera schema/router/route/tests; terminal payment adapter/source/tests; durable outbox/inbox/job source and M7 tests | Provider signatures and non-in-app delivery remain stubbed. Terminal integration review is WHA-297. Vendor/hardware choices D03/D05/D21 are External. |
| Physical printing | Unbuilt | No canonical `src/lib/restaurant/printing/` implementation or golden-byte fixtures | Entire lane already exists as blocked WHA-228; do not duplicate. |
| Offline POS/KDS | Needs browser acceptance | `src/lib/restaurant/pos-client-store.ts`, `pos-command-queue.ts`; E2E resilience spec covers stale state, reconnect, idempotent retry, cursor gap | Accepted offline promise/latency target is External under D04; promotion parity is WHA-282. |
| Localization/RTL and accessibility | Partial | catalog/menu localization fields and M3 round-trip tests; POS/KDS accessibility spec exists | Pilot language matrix and tablet/RTL browser proof remain External/acceptance work under D20. |
| Reservations/waitlist, gift/stored value, native mobile, payroll, full driver logistics | External | Explicitly deferred by plan §§17.2 D23 and 18.3; no delivery claim | Excluded unless a human approves scope and commercial case. |

## Dependency DAG and next minimal milestone

```text
Human decisions D02/D03/D04/D05/D07/D08/D20/D21/D22
  ├─ active lanes WHA-228/281/282/286/297/298/299/300 (owned elsewhere)
  └─ L1 evidence manifest
       ├─ L2 workforce completion
       ├─ L3 browser actor/accessibility acceptance
       └─ L4 isolation/reconciliation E2E
            └─ L5 release-claim audit
```

The milestone is capped at five non-overlapping lanes. Each lane has one writer/surface and one owner; the Chief of Staff routes owners after confirming active-lane file sets.

| Lane | One writer / owned surface | Objective acceptance |
| --- | --- | --- |
| L1 — acceptance manifest | Documentation owner; new `tests/e2e/restaurant-acceptance-manifest.ts` only | Machine-readable list maps every matrix row to existing route/test IDs; validation fails on missing files, duplicate ownership, or any WHA-228/281/282/286/297/298/299/300 owned path. No behavior changes. |
| L2 — workforce closure | Workforce owner; `restaurant-shifts` domain/router plus one focused workforce UI surface and tests, excluding WHA-286/300 files | Staff can schedule, clock in/out, start/end breaks, record late arrival, and request/approve a swap; server timestamps and branch authorization are tested; payroll and payout do not exist. |
| L3 — browser actor/accessibility | Browser-QA owner; new E2E specs/fixtures only | At desktop and tablet widths, SuperAdmin, Agency, and Restaurant actors complete their permitted smoke paths; keyboard/focus/name/state assertions pass; RTL is tested only if D20 names a launch language. No source edits. |
| L4 — isolation and ledger reconciliation | Data-QA owner; new real-PostgreSQL/E2E tests only | Cross-org and cross-vertical reads/writes fail for routes used in the final matrix; one order reconciles order, bill, tender, inventory, loyalty, insight, drawer, and close facts; replay is idempotent. No schema/source edits. |
| L5 — release-claim audit | Documentation owner; this document and release evidence index only | After L1–L4 and active lanes resolve, every `Delivered` claim points to a passing gate; unresolved External/Partial items remain explicitly labelled; no production/deployment claim is introduced. |

Dependencies: L1 first. L2 and L3 may run after L1 in parallel because file ownership does not overlap. L4 depends on the stable workflows from L2 plus any accepted WHA-281/297 changes it exercises. L5 depends on all preceding lanes and the disposition of every active lane.

## Objectively checkable acceptance and verification gates

| Gate | Check | Passing evidence |
| --- | --- | --- |
| G0 Base and scope | `git rev-parse HEAD`, `git status --short`, changed-file list | Work begins from exact canonical SHA; only lane-owned paths change; unrelated/dirty work preserved. |
| G1 Static contract | Formatter plus repository typecheck/lint scoped as supported | Exit 0; no skip/deletion or weakened negative assertion. |
| G2 Focused behavior | Named unit/router tests for each touched domain | Exit 0 with test names matching lane criteria. |
| G3 Database isolation | Real non-superuser PostgreSQL RLS/append-only tests | Tenant A/B, branch, replay, UPDATE/DELETE negative cases pass. |
| G4 Browser | Playwright desktop + tablet, four actor classes, loading/empty/error/recovery, keyboard and accessibility assertions | Exit 0 with trace/screenshot references; no raw IDs in normal workflows. |
| G5 Reconciliation | Final order-to-close E2E | Exact monetary/stock/loyalty/insight totals reconcile and replay produces no duplicate ledger facts. |
| G6 Coverage audit | Matrix-to-manifest validator and release-claim review | Every claim has source and test evidence; partial/external items stay labelled. |

## Final E2E matrix

| Actor | Allowed proof | Denied/isolation proof |
| --- | --- | --- |
| SuperAdmin | Create Restaurant with compatible package, default branch/admin/templates; activate only after preflight; inspect tenant without silently changing its vertical | Agency package on Restaurant rejected; active vertical change rejected; ordinary tenant RLS still applies to tenant data path. |
| Agency | Existing agency dashboard/modules remain usable after restaurant delivery | Restaurant package/module/routes/procedures/API denied; no restaurant nav or tenant data; agency records unchanged. |
| Restaurant admin/operator | Admin configures branch, staff/device, catalog/menu, floor, tax, inventory/purchasing, SOP, customer/loyalty and insights; operator signs in, opens drawer, completes order/KDS/split tender/refund/close | Wrong branch, inactive operator, missing capability/module, locked/revoked terminal, cross-day mutation, and replay fail closed with usable recovery. |
| Cross-vertical and cross-tenant | Same-host Agency and Restaurant sessions route to their own surfaces; Restaurant A branch/ledger facts remain visible to permitted Restaurant A actors | Agency cannot read Restaurant data; Restaurant cannot read Agency data; Restaurant A cannot read/write Restaurant B; branch-scoped actor cannot access another branch; consolidated insight requires explicit capability. |

## Exclusions, risks, and genuine human decisions

- Excluded: implementation in this planning lane; schema/product/config/test edits; remote push, merge, deploy, shared-ref advance; native mobile; reservations/waitlist; gift/stored value; payroll/tip payout; full driver logistics; generic vertical builder; vendor SDK/OS daemon; claims of production readiness.
- Do not overlap active work: WHA-228 printing; WHA-281 promotion money integration; WHA-282 promotion offline/admin; WHA-286 role-profile UI; WHA-297 terminal-payment verification; WHA-298 wallet L1; WHA-299 guide; WHA-300 friendly selectors.
- Risks: active lanes can change evidence paths; mocked router tests do not prove domain/DB behavior; browser fixtures do not prove real devices/providers; plan decisions D02–D22 can block an honest launch claim.
- Human decisions required before applicable lanes: jurisdiction/tax/fiscalization (D02/D15); processor and terminal vendor (D03); offline SLA (D04); printer/drawer/KDS hardware (D05); inventory policy (D07); loyalty/privacy (D08); package/limits (D10); identity/branch enforcement where still open (D11/D12); localization (D20); notification providers (D21); analytics freshness/rebuild/retention (D22). Until accepted, these remain External rather than inferred from code.

## Routing handoff contract

Codex Chief of Staff must route this exact plan from base `27b4e51165428e00248edc12d1b6e175f31933a6`, preserve the lane ownership and DAG above, forbid broad repository scans, preserve unrelated/dirty work, and refuse any lane that overlaps active WHA-228/281/282/286/297/298/299/300. No specialist is assigned by the Portfolio CTO.
