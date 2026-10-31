# Restaurant promotions and checkout discount snapshots

Status: A0 full specification

Scope: domain and persistence contract only; no implementation or migration is authorized here

Baseline: `8a46543565edd47a616288eecb7e1d10082d2d31`

## 1. Decision summary

Promotions are a separate, tenant-owned, effective-dated layer. They do not mutate catalog prices, price-list versions, combo definitions, tax rules, comps, or loyalty configuration. A mutable promotion identity owns immutable published versions. Checkout evaluates one exact promotion-set revision and writes immutable order/bill discount snapshots containing every input required to reproduce the result without reading current configuration.

The server is authoritative online and at reconciliation. An offline terminal may quote and queue only from a complete, unexpired, signed cache revision. Cap-bearing promotions require a server reservation and are unavailable offline. A queued order carries its cache revision and locally computed snapshot; the server either reproduces it byte-for-byte or rejects it with a typed reprice response. It never silently changes the payable amount.

There is no emergent stacking. Eligibility, candidate construction, allocation, ordering, rounding, exclusivity, and tie-breaking are specified below as total functions.

## 2. Existing contracts preserved

- `RestaurantPriceListVersion` remains the configuration reference on an order. `RestaurantOrderItem.unitPrice` plus snapshotted modifier deltas remain the authoritative gross unit charge; promotions never rewrite either.
- `RestaurantBill.subtotal`, `compTotal`, `discountTotal`, and `grandTotal` retain the identity `grandTotal = subtotal + taxTotal + serviceChargeTotal - compTotal - discountTotal + roundingAdjustment`. Promotion benefits contribute only to `discountTotal`; manager comps contribute only to `compTotal`; loyalty redemption remains a discount but is separately classified in snapshots.
- `RestaurantTaxTransactionSnapshot` pins the tax profile and transaction totals. Each `RestaurantTaxRateBucketSnapshot` pins rule version, price mode, rate, taxable amount, tax, and gross. Promotion allocation must be complete before a tax bucket is calculated when the governing tax rule says discounts reduce taxable consideration.
- Loyalty accrual remains append-only and bill-pinned. It earns on non-negative settled consideration after promotions, comps, loyalty redemption, and refunds, excluding tax, service charge, tips, and gift-card purchase value.
- Daily close and insight projections remain rebuildable. Promotion discounts roll into `discountTotal`, never `compTotal`; promotion-specific analysis rebuilds from immutable application snapshots.

## 3. Domain model

Names below are logical contracts, not a migration prescription.

### 3.1 Promotion identity and versions

`RestaurantPromotion` is stable identity: `id`, `organizationId`, internal code, lifecycle (`ACTIVE`, `ARCHIVED`), timestamps. Codes are unique per tenant and are never reused.

`RestaurantPromotionVersion` is immutable after publication:

- identity: `id`, `organizationId`, `promotionId`, monotonically increasing `versionNumber`;
- lifecycle: `DRAFT`, `PUBLISHED`, `SUPERSEDED`; only drafts update/delete;
- schedule: `effectiveFrom`, optional exclusive `effectiveTo`, IANA `timezone`, seven-bit `dayMask` (bit 0 Monday through bit 6 Sunday), optional local `startMinute` inclusive and `endMinute` exclusive;
- authority: `activationMode` (`AUTOMATIC`, `COUPON_CODE`, `STAFF`, `MANAGER`), normalized coupon-code hash where applicable, required permission/co-authorization policy, approval actor/reference and published timestamp;
- targeting and benefit fields described below;
- `priority` signed integer, `stackingGroup` stable string, `stackingMode`, `stopFurtherProcessing`, and `maxApplicationsPerOrder`;
- constraints: allowed branch IDs, channels, minimums, customer/loyalty segment reference if any, per-order cap, global campaign cap, per-customer cap, and optional budget amount;
- canonical `ruleSnapshot` JSON plus `ruleHash` over its canonical serialization. The normalized relational rows drive evaluation; the immutable canonical snapshot is the reconstruction and audit boundary.

Publishing validates referential tenancy, schedule, money scale, benefit/target compatibility, and that every rule has a deterministic allocation method. It atomically supersedes the prior published version for the same identity. Published or superseded rows and their child rules cannot update or delete.

### 3.2 Schedule semantics

All instants are UTC; wall-clock tests use the version's IANA timezone, not device or branch clocks. Eligibility uses the server evaluation instant `evaluatedAt` and requires `effectiveFrom <= evaluatedAt < effectiveTo` when an end exists. The local weekday must be present in `dayMask`.

If no minute window exists, the whole selected local day is valid. For `startMinute < endMinute`, require `startMinute <= minute < endMinute`. For an overnight window (`startMinute > endMinute`), the interval starts on a selected day and ends the following day; e.g. Friday 22:00–02:00 accepts Saturday 01:00 under Friday's bit. Equal endpoints mean a full selected day, not an empty interval. Ambiguous fall-back local times are both eligible; nonexistent spring-forward times simply never occur. The snapshot records UTC `evaluatedAt`, timezone, resolved local date/minute, UTC offset, and schedule result.

### 3.3 Targets

One version has one target expression, composed only from these explicit predicates:

- `ITEM`: product IDs and optional variant IDs; modifiers do not independently qualify.
- `CATEGORY`: category IDs evaluated from the product's category snapshot at item-add time; descendants are included only when `includeDescendants=true` and the snapshotted ancestry contains the target.
- `ORDER`: all otherwise eligible non-voided lines.
- optional filters common to all: branch IDs, `RestaurantOrderChannel`, minimum eligible quantity, minimum eligible merchandise amount, and customer/segment.

Minimum merchandise amount is measured from pre-promotion item charges after comps allocated to those lines, excluding tax, service charge, tips, gift-card value, prior promotion discounts, and loyalty redemption. The exact qualifying item IDs, quantities, category ancestry, and qualifying amount are snapshotted.

### 3.4 Benefit kinds

The initial closed set is:

1. `PERCENT_OFF`: basis points off eligible extended charge (`1500` = 15%).
2. `AMOUNT_OFF`: fixed money off the target, capped at eligible remaining charge.
3. `FIXED_PRICE`: reduce the selected target quantity to a stated total price; never surcharge.
4. `BUY_X_GET_Y_PERCENT`: for every `buyQuantity`, discount up to `getQuantity` qualifying units by basis points.
5. `BUY_X_GET_Y_AMOUNT`: same selection, with a fixed per-unit discount capped at that unit's remaining charge.
6. `BUY_X_GET_Y_FREE`: shorthand for `BUY_X_GET_Y_PERCENT` at 10000 basis points.
7. `BUNDLE_PRICE`: specified component requirements receive a fixed bundle total for each complete set.

Every benefit declares `applicationBasis` (`LINE`, `UNIT`, `ORDER`), maximum applications, maximum benefit money, and allocation method. Currency must equal the order currency. Negative amounts, percentages above 100%, and benefits that increase consideration are invalid.

## 4. Deterministic evaluation

### 4.1 Canonical inputs

Evaluation begins from non-voided order-item snapshots. A unit's gross charge is `unitPrice + sum(modifier priceDelta)`; quantity conceptually expands into stable units `(orderItemId, unitOrdinal)`. Each unit also carries product, variant, category ancestry, add-time publication and price-list version. Money uses Decimal and rounds only where stated to currency minor units using the existing half-up money rule.

Candidates are built from the pinned promotion-set revision and sorted by:

1. `priority` descending;
2. promotion ID ascending;
3. version number ascending;
4. rule ID ascending.

Unit selection for quantity benefits sorts by eligible remaining unit charge ascending for free/percent/fixed-amount benefits (customer-conservative and deterministic), then `orderItemId`, then unit ordinal. Bundle requirements are matched in rule component order, then the same unit order. A candidate's unrounded benefit is computed against the remaining eligible charge after earlier accepted applications.

### 4.2 Stacking

`stackingMode` is one of:

- `EXCLUSIVE`: if accepted, reject every other promotion candidate.
- `GROUP_EXCLUSIVE`: at most one promotion identity in the same `stackingGroup`; repeated applications of the winner remain allowed within its limits.
- `STACKABLE`: may combine unless excluded by another accepted rule.

Candidates are visited once in canonical order. A candidate is accepted only if eligible, positive after rounding, within every limit, and not excluded by accepted candidates. `stopFurtherProcessing` ends the visit after acceptance. An identity/version/rule cannot consume the same unit twice in one application. No “best deal” search occurs. Ties never depend on database row order. Coupon codes only add their exact eligible candidate; they do not alter ordering.

For a multi-line discount, compute the rounded total benefit once, allocate cents proportional to each selected unit's remaining charge by largest remainder, and break equal remainders by `(orderItemId, unitOrdinal)`. No line becomes negative. Repeated applications consume the next canonical eligible units.

### 4.3 Tax, comps, loyalty, and settlement order

The checkout pipeline is fixed:

1. freeze catalog unit prices/modifiers and category ancestry;
2. allocate manager comps to lines;
3. evaluate and allocate promotions against uncomped remaining merchandise;
4. evaluate tax rules per allocated line. A tax rule's immutable `discountTreatment` is either `BEFORE_TAX` (promotion allocation reduces taxable amount) or `AFTER_TAX` (tax basis remains pre-promotion). Mixed buckets allocate each discount proportionally only among their affected lines;
5. calculate service charge from its independently configured basis;
6. apply loyalty redemption as its own discount authority;
7. apply bill rounding adjustment and settle;
8. accrue loyalty on `max(0, merchandise after comps, promotion discounts, loyalty redemption, and refunds)`, explicitly excluding tax/service/tips/gift-card purchases.

Promotion applications are computed at order scope before bill splitting. Item-carrying splits inherit applications through line/unit allocations. Fractional splits allocate the order-level promotion total by the same bill weight/largest-remainder method as their subtotals. Re-split or void-and-recut creates new bill application snapshots linked to the same order evaluation; settled history is never rewritten.

## 5. Immutable reconstruction contract

### 5.1 Order evaluation snapshot

One `PromotionEvaluationSnapshot` is append-only per accepted server evaluation and contains:

- tenant, order, branch, channel, currency, evaluation ID and idempotency key;
- `evaluatedAt`, timezone/local schedule facts, engine version, money/rounding version;
- promotion-set revision ID/hash, cache revision/ETag, source (`ONLINE`, `OFFLINE_RECONCILED`), terminal/device ID;
- price-list version ID plus complete input lines: item ID, product/variant, category ancestry, quantity, unit price, modifier deltas, comp allocation, and pre-discount extended amounts;
- every considered candidate in canonical order with promotion ID, version ID/number, rule ID, `ruleHash`, full `ruleSnapshot`, authority/actor/code fingerprint, eligibility outcome and stable reason code;
- every accepted application with application ordinal, selected unit keys, unrounded and rounded benefit, cap counters/reservation ID, and allocated cents by order item;
- aggregate promotion discount and a hash of canonical input plus output.

Rejected candidates are retained because explaining why a lower-priority rule won is part of reconstruction. Coupon plaintext is never stored; only a non-reversible fingerprint and promotion identity are retained.

### 5.2 Bill application snapshot

Each bill receives immutable `PromotionBillApplicationSnapshot` rows containing tenant, bill/order/evaluation IDs, promotion/version/rule identity and rule hash, authority/actor, application ordinal, source order-item/unit allocations, subtotal basis, computed amount, tax treatment/allocation, and any reversal link. Bill `discountTotal` equals `sum(promotion computedAmount) + loyaltyRedemptionAmount + other explicitly classified non-comp discounts`. Separate classified totals or application kinds make that equality auditable.

The tax transaction snapshot records the promotion evaluation ID/hash and each rate bucket records pre-discount gross, allocated before-tax discount, taxable amount, rate, tax, and after-tax discount. This extends rather than replaces the current bucket authority.

No reconstruction query may join current promotions, catalog, category, branch timezone, tax configuration, or loyalty configuration. From these snapshots alone, an auditor six months later can reproduce candidate ordering, eligibility, unit selection, cents, tax basis, bill totals, and loyalty earnable amount. Foreign keys to mutable identities are navigation aids and may be `SetNull`; snapshot payloads and hashes are authoritative.

Corrections append a reversal snapshot that negates original allocations and references the original, then append a replacement evaluation if needed. Snapshot rows reject update/delete at the database layer.

## 6. Caps and concurrency

Per-order limits are calculated inside the evaluation. Global, per-customer, and budget caps use a tenant-scoped append-only reservation/consumption ledger keyed by `(promotionVersionId, scopeKey, evaluationId, applicationOrdinal)` and protected by a database transaction:

- lock the counter rows in stable `(promotionVersionId, scopeKind, scopeKey)` order;
- compute committed consumption plus live reservations;
- insert reservations and the checkout snapshot atomically or reject all with `PROMOTION_CAP_EXHAUSTED`;
- settlement converts each reservation to consumed in the owning transaction; cancellation/expiry appends a release;
- replay of the same evaluation idempotency key returns the original reservation/result; a changed payload under the same key is `IDEMPOTENCY_CONFLICT`.

No read-then-write counter, client-reported remaining cap, or asynchronous decrement may authorize a capped benefit. Deadlock/serialization failures are retryable at the command boundary; partial applications never commit.

## 7. Online/offline parity and invalidation

The POS document remains partitioned by organization, branch, and device. Its schema version is bumped when promotion cache/snapshot shapes are introduced. The allowlist admits only published promotion snapshots, set revision/hash, signed issuance/expiry, and non-sensitive coupon fingerprints; customer data, coupon plaintext, secrets, tender values, and manager credentials remain forbidden.

The server publishes one branch/channel promotion-set revision containing complete immutable rules and referenced category ancestry. A new publication, supersession, archive, emergency disable, cap-policy change, branch/channel assignment, or relevant category correction creates a new monotonically increasing revision. POS bootstrap and the existing 30-second active refresh carry its ETag. Push invalidation may accelerate refresh but is not correctness authority.

Offline evaluation is permitted only when:

- cache signature, tenant/branch/device scope, engine version, and schema version validate;
- server-signed `validUntil` has not passed according to a monotonic elapsed-time bound anchored at last trusted server time;
- all applicable rules are `offlinePolicy=ALLOW` and have no global/per-customer/budget cap, online-only segment, or manager-online authorization.

The queue stores command sequence, evaluation idempotency key, revision/hash, canonical inputs, and computed snapshot atomically with the draft. On sync the server re-evaluates using the pinned still-retained revision and evaluation instant. Exact match commits. A mismatch or unavailable/disabled revision returns `PROMOTION_REPRICE_REQUIRED` with old/new totals and reason; the order remains uncommitted until explicit operator/customer acceptance submits a new idempotency key. Capped or otherwise online-only rules return `PROMOTION_ONLINE_REQUIRED` while disconnected. Queue order never uses the device wall clock.

## 8. Combo boundary

`RestaurantComboComponentGroup` and `RestaurantComboComponentOption` are catalog composition only: choice cardinality, component product/variant, ordering, and price delta. Promotions may read the resulting frozen component selections to satisfy an item/category or bundle predicate, but must not reuse these tables for promotion requirements, benefits, schedules, stacking, or caps. A promotion bundle owns immutable rule components because it needs quantities, alternatives, benefit allocation, versioning, and audit semantics absent from combo CRUD.

A sold combo is one priced order line by default; its components are not separately discountable unless the order snapshot explicitly exposes component unit keys and the promotion rule declares `componentTargeting=true`. Even then, allocated component discounts roll back to the parent order line and may not exceed its remaining charge. This avoids silently treating catalog option `priceDelta` as an independently sold item.

## 9. Rollups and accounting

- `grossSales`: settled pre-comp/pre-discount merchandise subtotal from authoritative line snapshots.
- `compTotal`: manager comps only.
- `discountTotal`: promotion discounts plus loyalty redemption and any future explicitly classified discounts; daily close retains this total.
- `netSales = grossSales - compTotal - discountTotal - refundTotal`; refunds use processing business date and are deducted once. Tax, service charge, tips and voids remain separately reported under existing contracts.
- Add promotion rollups keyed by tenant, branch, business date, promotion ID/version/rule, source daily-close chain tip, with application count, discounted quantity, qualifying gross, and discount amount. They are rebuildable projections, never financial authority.
- Item-mix allocates promotion cents to product lines and computes `netSales = grossSales - comp allocation - promotion allocation - other classified line discounts`. Order-level and fractional cents use the immutable allocation rows; they are never guessed during projection.
- Refunds append proportional promotion reversals from the refunded unit allocations. They do not retroactively make another item eligible or re-run stacking. Loyalty reversal uses the refunded net merchandise amount.

## 10. Tenancy, authorization, privacy, and audit

Every promotion, version, rule child, snapshot, reservation, and rollup carries `organizationId`. Composite foreign keys enforce same-tenant references. Forced RLS applies to runtime roles; policies fail closed when `app.current_organization_id` is absent. RLS tests must assert the runtime role is neither `SUPERUSER` nor `BYPASSRLS` before testing cross-tenant denial.

Draft authoring requires the promotion-management permission; publish/supersede/emergency-disable requires the configured elevated permission and records actor, reason, approval/co-authorization reference, and server time. Staff/manager activation snapshots the acting staff and authorization reference. Evaluation is permitted only for a terminal authorized to the order's branch. Coupon validation uses a keyed hash and constant-shape failure; plaintext, customer attributes, secrets, PINs, and full payloads are never logged.

Audit events are append-only for create draft, edit draft, publish, supersede, archive, emergency disable, evaluate, cap reserve/consume/release, offline mismatch, and reversal. They record IDs, hashes, reason codes, actor/device, and timestamps—not sensitive rule inputs or coupon plaintext.

## 11. Error contract

Stable reasons are: `PROMOTION_NOT_FOUND`, `PROMOTION_NOT_ACTIVE`, `PROMOTION_NOT_ELIGIBLE`, `PROMOTION_CODE_INVALID`, `PROMOTION_AUTH_REQUIRED`, `PROMOTION_CAP_EXHAUSTED`, `PROMOTION_ONLINE_REQUIRED`, `PROMOTION_CACHE_INVALID`, `PROMOTION_REPRICE_REQUIRED`, `PROMOTION_RULE_INVALID`, and `IDEMPOTENCY_CONFLICT`. Expected ineligibility is a candidate outcome, not a transaction failure. Command failures throw and roll back the owning transaction; no catch converts an error into a committed partial checkout.

## 12. Numerical owner examples

All amounts are USD and round to cents.

1. **Percent and minimum:** two meals at 12.00 and 8.00 meet a 20.00 minimum. `PERCENT_OFF 15%` gives `20.00 × .15 = 3.00`; subtotal 20.00, discount 3.00, pre-tax net 17.00. At quantity one (12.00), the candidate is ineligible and discount is 0.00.
2. **Amount cap:** eligible subtotal 7.50 with `AMOUNT_OFF 10.00` yields 7.50, never -2.50; payable merchandise is 0.00.
3. **Fixed price:** three identical items total 18.00 with `FIXED_PRICE 14.00` yields 4.00. If their total is 12.00, it yields 0.00 because promotions never surcharge.
4. **Buy two, get one 50%:** unit charges 5.00, 7.00, and 9.00 satisfy one set. The canonical cheapest benefit unit is 5.00; discount is 2.50 and net is 18.50.
5. **Buy one, get one amount:** two 3.00 units with `BUY_X_GET_Y_AMOUNT 5.00` discount the selected get unit by min(5.00, 3.00) = 3.00; net is 3.00.
6. **Buy two, get one free:** charges 4.00, 6.00, 8.00 discount the canonical cheapest unit 4.00; net is 14.00.
7. **Bundle price:** burger 9.00 + fries 4.00 + drink 3.00 = 16.00; bundle price 12.00 yields 4.00. Proportional allocation by gross is 2.25, 1.00, 0.75.
8. **Largest remainder:** order-level 1.00 across lines 10.00, 10.00, 10.00 produces raw 0.333… each. Allocations are 0.34, 0.33, 0.33; the lowest `(orderItemId, unitOrdinal)` receives the extra cent.
9. **Explicit stacking:** priority-20 10% and priority-10 fixed 5.00 are both `STACKABLE` on 100.00. Apply 10% first = 10.00, then 5.00 = 5.00; total discount 15.00, not 14.50. If both are `GROUP_EXCLUSIVE` in group `meal`, only the priority-20 rule applies and total is 10.00.
10. **Tax ordering:** on gross 100.00, a 10.00 promotion and 10% exclusive tax: `BEFORE_TAX` gives taxable 90.00, tax 9.00, grand 99.00; `AFTER_TAX` gives taxable 100.00, tax 10.00, grand 100.00.
11. **Comp interaction:** a 40.00 line has a 10.00 comp allocation, then a 25% promotion applies to the 30.00 remainder = 7.50. `compTotal=10.00`, `discountTotal=7.50`, net merchandise 22.50.
12. **Loyalty:** merchandise 100.00 - promotion 15.00 - comp 10.00 - loyalty redemption 5.00 - merchandise refund 20.00 = earnable 50.00. At 2 points per currency unit, accrue 100 points; tax and service charge do not increase it.
13. **Cap race:** a campaign has one remaining application and checkouts A/B reserve concurrently. Stable row locking lets exactly one consume 1; the other receives `PROMOTION_CAP_EXHAUSTED`. Total consumption remains 1.
14. **Overnight schedule:** Friday bit set, 22:00–02:00 in Asia/Karachi. Friday 23:30 and Saturday 01:30 are eligible; Saturday 02:00 is not.

## 13. Named acceptance tests

- `promotion_percent_obeys_minimum_and_rounds_once`
- `promotion_amount_and_fixed_price_never_make_line_negative`
- `promotion_bxgy_selects_canonical_units`
- `promotion_bundle_allocates_largest_remainder_by_stable_unit_key`
- `promotion_schedule_handles_day_mask_overnight_dst_and_exclusive_end`
- `promotion_item_category_order_targets_use_frozen_ancestry`
- `promotion_branch_channel_customer_and_per_order_limits_fail_closed`
- `promotion_stacking_priority_group_exclusive_stop_and_ties_are_total`
- `promotion_before_tax_and_after_tax_pin_bucket_allocations`
- `promotion_comp_discount_and_bill_identity_reconcile`
- `promotion_split_and_fractional_bills_preserve_order_discount_cents`
- `promotion_loyalty_earns_on_net_merchandise_and_refund_reverses_net`
- `promotion_daily_close_item_mix_and_campaign_rollups_rebuild_from_snapshots`
- `promotion_snapshot_reconstructs_six_month_old_checkout_without_live_joins`
- `promotion_offline_same_revision_matches_online_byte_for_byte`
- `promotion_offline_stale_revision_requires_explicit_reprice`
- `promotion_offline_refuses_cap_segment_and_online_authority_rules`
- `promotion_cache_scope_schema_signature_expiry_and_invalidation_fail_closed`
- `promotion_queue_replay_is_idempotent_and_payload_conflict_rolls_back`
- `promotion_cap_race_allows_exactly_remaining_capacity`
- `promotion_cap_failure_rolls_back_snapshot_and_reservation_atomically`
- `promotion_combo_components_do_not_become_independent_discount_lines`
- `promotion_cross_tenant_references_and_reads_are_denied_under_forced_rls_runtime_role`
- `promotion_publish_is_immutable_and_audited_without_sensitive_payloads`
- `promotion_reversal_is_append_only_and_preserves_original_evidence`

Database RLS setup for the named RLS test must first assert `rolsuper=false` and `rolbypassrls=false` for the runtime role. Concurrency tests use two independent transactions and assert ledger rows, snapshots, and totals—not only response codes.

## 14. Migration and rollback plan

This is a future implementation DAG, not authorization to migrate:

1. add enums and tenant-owned identity/version/rule tables in a forward-only migration;
2. add append-only evaluation/application and cap-ledger tables, composite tenant FKs, checks, forced RLS, immutable triggers, and indexes;
3. add nullable snapshot/revision references and classified discount fields to order, bill, tax snapshot, and projection inputs;
4. deploy readers tolerant of null (legacy checkout) and dual-write promotion snapshots behind a disabled tenant feature flag;
5. backfill no historical promotions—legacy rows remain explicitly `promotionEvaluationId=null`; rebuild projections with the new version while preserving totals;
6. enable shadow evaluation, compare hashes/totals, then enable online uncapped rules, offline rules, and capped rules in that order;
7. only after the compatibility window, require snapshots for checkouts that claim a promotion revision.

Each migration is transactional where PostgreSQL permits and fails closed on invalid existing rows. No destructive rename/drop occurs in the rollout. Operational rollback disables the feature flag and returns to legacy checkout while retaining all new immutable evidence. Schema rollback is forward-fix: leave additive tables/columns dormant; do not drop snapshot or ledger data. A faulty published promotion is emergency-disabled by appending an audited control event/new set revision, never by editing historical versions.

## 15. Rejected alternatives

- **Price-list entries as promotions:** rejected because prices express one winning base price, not eligibility, benefits, stacking, caps, authority, or application evidence; mutation would also undermine authoritative item snapshots.
- **Combo groups as bundle rules:** rejected because catalog composition lacks effective dating, schedule, stacking, caps, and checkout audit semantics.
- **Only store `discountTotal`:** rejected because it cannot reconstruct which version/rule/authority/units produced the money or reproduce tax and loyalty effects.
- **Re-read live promotion configuration for reports/refunds:** rejected because supersession, archive, category edits, and timezone changes would rewrite history.
- **Client-authoritative offline totals:** rejected because stale configuration and cap races cannot be reconciled safely. Offline is a pinned deterministic quote subject to server equality.
- **Automatic best-price combinatorial search:** rejected because it is costly, hard to explain, and makes stacking depend on an optimizer. Canonical priority order is the contract.
- **Last-write-wins cap counters:** rejected because oversubscription is possible. Reservations and settlement consumption share one locked transaction boundary.
- **Promotions after all tax by default:** rejected because tax treatment is jurisdiction/rule specific. The immutable tax rule explicitly chooses before/after basis and snapshots it.

## 16. Dependency DAG

```text
catalog/price snapshots + category ancestry
                    \
promotion identity -> immutable version/rules -> branch/channel set revision -> POS cache
                                                |                         |
tax rule discount treatment --------------------+-> deterministic evaluator <- command queue
manager comp allocation ------------------------+           |
cap reservation ledger <------------------------------------+
                                                            v
                                      order evaluation snapshot
                                                            |
                                   bill split/allocation snapshots
                                      |             |             |
                                      v             v             v
                                tax buckets     settlement    refund/reversal
                                                      |             |
                                                      v             v
                                              net loyalty accrual/reversal
                                                      |
                                                      v
                                      daily close + rebuildable insights
```

Implementation ordering follows the arrows. Offline enablement depends on the same canonical evaluator running in client-safe form plus server parity fixtures; capped promotion enablement additionally depends on the reservation ledger and concurrency battery.

## Bounded draft bundle authoring (000w)

The owner/admin Offers editor supports 1–20 ordered `BUNDLE_PRICE` components. Each component has a positive integral quantity and product alternatives, category alternatives, or both. A component matches either alternative set. Rows can be added, removed, and moved; their order matters to the existing greedy evaluator. The editor preserves saved selection order and duplicate membership on unchanged and name-only saves. Changing a target type clears only incompatible targeting selections. Temporary benefit-type changes retain the in-progress bundle rows; saving another benefit type explicitly removes bundle components.

Editing remains limited to the latest automatic draft, with the displayed version ID, rule hash, and update time checked again by the transactional write. Component variants, malformed or noncontiguous ordinals, empty alternatives, oversized components, and stored benefit/name/currency values the editor cannot preserve remain read-only. Existing approval, publication, advanced activation, and global-cap restrictions continue to apply. Picker references are checked in the current workspace before any write; components are replaced within the guarded version update and an audit event records the resulting rule hash.

This increment does not publish or activate offers in checkout. Source-level tests exercise authoring, optimistic concurrency, synthetic evaluation, and snapshot replay. They do not establish live database behavior, visual acceptance, or POS rollout. The broader publication and operational contracts elsewhere in this specification remain separate integration work.
