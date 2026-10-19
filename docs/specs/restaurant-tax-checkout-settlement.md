# Restaurant tax checkout settlement contract

## 1. Status, authority, and outcome

**FULL SPECIFICATION — WHA-313.** This document is the product and engineering contract for restaurant tax at checkout settlement. It is authoritative for WHA-313 implementation routing and resolves the product decisions in this scope. Exact base: branch `WHA-281-promotions-a2-tax-loyalty-bill-and-insight-integration` at commit `63225c25a87e9d771902afed08b34bb65e577539`.

Restaurants need every settled bill to use the correct effective, approved tax evidence for its actual tender mix, while remaining replay-safe, auditable, and deterministic to the cent. The business outcome is that checkout quotes can change with tender type, but a successful final tender atomically freezes one reconstructable financial result; partial, stale, conflicting, or unconfigured attempts cannot leave financial writes.

The engine and this contract are jurisdiction-neutral. They define selection, arithmetic, evidence, and failure behavior, not legal rates, taxability, filing, fiscal-device, or invoice requirements. Real rules and sources require separate legal/configuration approval. Synthetic rates in tests and examples are not legal advice or approved rates for Pakistan or any other jurisdiction.

## 2. Canonical payment categories

The server owns this fixed mapping:

| `RestaurantTenderType` | `paymentCategory` |
| ---------------------- | ----------------- |
| `CASH`                 | `CASH`            |
| `CARD`                 | `CARD`            |
| `OTHER`                | `OTHER`           |

`CASH`, `CARD`, and `OTHER` are reserved canonical category values. Operators and clients submit only tender type; they never submit, override, or persist raw `paymentCategory`. An unknown tender type fails with `TAX_PAYMENT_CATEGORY_UNSUPPORTED`.

At settlement, the effective published and approved profile must provide exactly one effective approved, unexpired rule for every canonical category actually allocated consideration. Zero or multiple effective rules fail closed. `OTHER` remains one conservative category. The server must not infer gift, voucher, loyalty, wallet, or any other subtype until a future versioned, server-owned subtype mapping replaces this contract.

## 3. Terms and bill identity

- **Bill identity** is `(organizationId, billId)`, with the bill's immutable `branchId`, `orderId`, and `businessDate`; the tax snapshot `transactionReference` identifies that bill settlement uniquely within the organization.
- **Settlement instant** is server time frozen only by the successful final-tender transaction.
- **Tender principal** is `RestaurantTender.amount`: the amount applied to bill payable. It excludes tip, `cashReceived`, and change. Tips and cash change never become allocation weights or tax basis.
- **Merchandise consideration** is each frozen line's catalog price plus frozen modifier deltas, less comps and `BEFORE_TAX` reductions, before tax, service charge, `AFTER_TAX` reductions, bill rounding, tips, and cash change.
- **Partial tender** is an accepted tender that does not exactly cover the current server quote's remaining due. It is a payment allocation only, not a frozen tax allocation.
- **Final tender** is the tender that exactly covers the server-computed remaining due for its proposed type and settles the bill.

## 4. Quote and split-tender algorithm

All arithmetic uses exact decimal/cents; binary floating point is forbidden. A quote is provisional and writes no tax snapshot.

### 4.1 Quote under lock

Before accepting every tender, the server starts one tenant-scoped database transaction, enters the money-command idempotency boundary, and locks the bill row with `FOR UPDATE`. Under that lock it reads accepted tender principals and recomputes a category-specific hypothetical total for the full bill as though all still-unallocated consideration were assigned to the proposed tender type. It returns `quoteId`/canonical input hash, proposed category, quoted total, already accepted principal, and remaining due.

The caller states `amount` tendered toward that server quote. `cashReceived` may exceed cash principal and produces change outside settlement allocation. A non-final amount may be less than remaining due and leaves the bill open. A final amount must equal the current server-computed remaining due exactly. If the payload refers to an older quote, or recomputation changes the amount because the category, bill, promotions, configuration, or time changed, fail with `TAX_SETTLEMENT_REPRICE_REQUIRED` and return the new quote without writes.

### 4.2 Non-circular allocation

The algorithm never guesses a final tender amount and never iterates to a fixed point. It separates **consideration weights** from the resulting tax-inclusive payable:

1. Let `B` be total merchandise consideration cents after comps and `BEFORE_TAX` reductions. Service-charge consideration is handled separately under section 5.
2. Process prior accepted tenders in `(createdAt, id)` order. For each principal, assign `min(principal cents, merchandise cents not yet assigned)` as its merchandise-weight cents to its canonical category. Any remaining principal is coverage of tax, taxable service charge, or other payable components and adds no merchandise weight.
3. Assign every merchandise cent still unallocated to the proposed final tender's category. Thus prior settled principal amounts determine their weights, while the final category is the residual category. Combine weights by category.
4. For each eligible line independently, allocate its merchandise consideration cents across `CASH`, `CARD`, `OTHER` in proportion to those category weights using largest remainder. If `B=0`, there is no merchandise allocation. Tied fractional remainders use category order `CASH`, `CARD`, `OTHER`.
5. Apply the category's effective rule to each line/category allocation. The resulting recomputed payable determines the final remaining due: `recomputed payable - sum(prior tender principal)`. This is a forward calculation from already persisted principal plus a server-owned residual allocation, not an equation containing the unknown final principal.

This line-level rule governs mixed inclusive/exclusive lines and prevents a bill-level proportional shortcut from changing cents. The phrase “proportional to settled tender principal amounts” therefore means the settled principal-derived merchandise weights above; principal covering tax or other non-merchandise charges cannot distort merchandise tax basis.

For an `EXCLUSIVE` rule, allocated merchandise is net taxable consideration and tax is added after allocation. For an `INCLUSIVE` rule, allocated merchandise is gross consideration: `net = halfUp(gross / (1 + rate))` and `tax = gross - net`. Apply the same treatment to a taxable service-charge bucket after its explicit allocation. The final tender principal is the remaining payable produced by this calculation; tips and cash change remain excluded.

### 4.3 Rounding

Money is calculated to cents with round-half-up once at each final line/category bucket. Largest remainder is used only to allocate already-rounded cents among lines/categories or refund units. Do not round an intermediate rate product and then round the same bucket again. Sum stored bucket cents to line, tax, and bill totals; never recompute totals from rounded display percentages.

## 5. Authoritative calculation pipeline

The final transaction executes this order:

1. Read frozen catalog prices, quantities, modifier deltas, and bill identity.
2. Apply comps.
3. Resolve and recompute promotions from their pinned authoritative inputs; consume no reservation yet.
4. Allocate `BEFORE_TAX` promotion/discount and separately classified loyalty-redemption reductions to lines.
5. Allocate each line's remaining consideration by section 4, then calculate inclusive or exclusive tax by line/category.
6. Apply `AFTER_TAX` discounts to payable after tax. They do not reduce taxable basis or tax. Loyalty redemption must be explicitly classified as before-tax or after-tax configuration; it is never inferred from tender type and is not `OTHER` tender tax treatment.
7. Calculate service charge from its separately configured basis. A service charge must declare non-taxable, or declare an explicit taxable rule/category allocation. It must never be silently folded into merchandise or inherit a tender category merely because one exists.
8. Apply bill rounding last. Rounding is not taxable.
9. Add neither tips nor cash change to bill payable or tax basis.

The identity is:

`grandTotal = merchandise after comps and all discounts + exclusive tax + taxable/non-taxable service charge effects + roundingAdjustment`,

where inclusive tax is already contained in inclusive merchandise/service-charge consideration, `AFTER_TAX` reductions lower payable but not tax basis, and all component and bucket cents reconcile exactly to stored bill and line totals.

## 6. Atomic final settlement and timing

Only the transaction accepting the final tender freezes tax. Under the bill `FOR UPDATE` lock and the same money idempotency boundary, it atomically:

1. freezes the server settlement instant;
2. resolves the one effective published, approved profile and all used category rules at that instant, including source expiry;
3. recomputes promotions, tax, service charge, and rounding using sections 4–5;
4. validates exact tender coverage against the fresh quote;
5. writes the immutable tax transaction snapshot and line/rate/category buckets;
6. updates bill and bill-line tax and total columns;
7. consumes the owning promotion reservations;
8. writes the final tender, payment/provider event, and cash drawer movement as applicable;
9. assigns receipt and settlement status; and
10. writes loyalty accrual from the final eligible net merchandise amount.

All ten actions commit or roll back together. The final tender must not be inserted before successful recomputation in any separately committing step. A card authorization that cannot participate in the same rollback boundary must remain an external attempt and be reconciled/voided by its explicit provider contract; it is not a committed restaurant tender until this transaction succeeds.

Partial tenders create their existing payment/tender/drawer records atomically but create no tax snapshot, do not freeze a profile/rule/rate/promotion result, do not consume promotion reservations, do not settle, issue a receipt, or accrue loyalty. Their tax displays are provisional quotes.

## 7. Replay, concurrency, reversal, and legacy

The idempotency record binds `(deviceId, idempotencyKey)` to a canonical exact request payload/hash and original result reference. Same key plus byte-equivalent canonical payload returns the original result without recalculation, current-time lookup, or current-config join and writes nothing. Same key plus different payload fails `TAX_SETTLEMENT_CONFLICT`. Replay precedence occurs before live bill/config validation once the original binding is found.

Concurrent final tenders serialize on the bill lock. Exactly one may commit. A loser observes the bill no longer open and receives the existing bill-not-open/settled tender error with no writes; it does not create a second snapshot, receipt, tender, payment, drawer movement, promotion consumption, or loyalty entry.

Refunds and void reversals append snapshots linked to the original settlement. They use the original frozen profile, rule/rate/category, line/unit, promotion, discount-treatment, and service-charge evidence; they never read current rules or requalify promotions. A full reversal is an exact cent-for-cent negation. A partial refund allocates refundable cents from original bucket/unit cents by original eligible amounts using largest remainder and stable original `(lineId, unitOrdinal, category order)`; cumulative reversals may not exceed original cents. Tax, promotion, loyalty, payment, and cash movements append their corresponding reversal evidence atomically. Conflicting, duplicate, over-value, cross-bill, or cross-tenant reversals roll back.

Legacy settled rows remain readable and are not backfilled or joined to invented tax evidence. Rollout may keep an explicitly versioned legacy/no-profile path only for transactions begun before branch enablement. Once tax settlement is required for a branch, every newly begun settlement uses this contract and there is no zero-tax or legacy fallback. A branch without an effective published approved profile fails closed.

## 8. Stable errors

Every error below rolls back the transaction and produces no tender, payment, drawer movement, snapshot/bucket, bill/line total, promotion consumption, receipt/status, reversal, or loyalty write. Existing `TenderError` reasons remain authoritative for non-tax tender validation.

| Code                               | Trigger                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `TAX_PROFILE_UNAVAILABLE`          | No single effective published, approved branch profile exists at final settlement.                                                  |
| `TAX_RULE_UNAVAILABLE`             | A category actually used has no single effective published, approved rule.                                                          |
| `TAX_RULE_CONFLICT`                | More than one effective rule/profile candidate applies to a used category.                                                          |
| `TAX_SOURCE_EXPIRED`               | A selected rule's authoritative source is expired at settlement.                                                                    |
| `TAX_PAYMENT_CATEGORY_UNSUPPORTED` | Tender type has no canonical server mapping or an unreserved/raw category is attempted.                                             |
| `TAX_SETTLEMENT_REPRICE_REQUIRED`  | Current proposed-category quote/hash or remaining due differs from the caller's quote/amount.                                       |
| `TAX_SETTLEMENT_CONFLICT`          | Same idempotency key is reused with a different canonical payload, or persisted partial-tender evidence cannot form one settlement. |
| `TAX_SNAPSHOT_CONFLICT`            | A settlement snapshot/reference already exists with non-identical evidence, or reconstruction totals do not reconcile.              |
| `TAX_REVERSAL_CONFLICT`            | Reversal is duplicate, over-value, cross-boundary, or inconsistent with original bucket/unit evidence.                              |

## 9. Synthetic numerical examples

All rates below are synthetic, non-legal test values. They do not describe or approve any jurisdiction's rates.

### 9.1 Cash/card split with exclusive rates

One line has 100.00 merchandise consideration. A prior CASH partial tender principal is 40.00; CARD is proposed final. Weights are CASH 40 and CARD 60, so line allocation is 40.00/60.00. With synthetic CASH 5% exclusive and CARD 10% exclusive, tax is 2.00 + 6.00 = 8.00 and payable is 108.00. Already accepted principal is 40.00; the server CARD remaining-due quote is 68.00. A CARD final principal of 68.00 settles. The 8.00 difference between CARD's 60 merchandise weight and 68.00 principal covers calculated tax and does not feed back into weights.

### 9.2 Inclusive extraction and largest remainder

One line contains 110.00 gross inclusive merchandise. Prior CASH principal is 55.00 and CARD is final, producing 55.00/55.00 gross allocations. At synthetic CASH 10% inclusive, CASH net/tax is 50.00/5.00. At synthetic CARD 25% inclusive, CARD net/tax is 44.00/11.00. Total payable remains 110.00; the CARD final remaining due is 55.00. Nothing is added on top of inclusive gross.

For a 10.01 line with weights CASH 1, CARD 1, OTHER 1, raw allocations are 3.336… each. Largest remainder plus category tie order produces CASH 3.34, CARD 3.34, OTHER 3.33; category tax then rounds once per line/category bucket.

### 9.3 Before/after tax, comp, service charge, and rounding

A frozen line is 50.00, comp is 10.00, and `BEFORE_TAX` promotion is 5.00, leaving 35.00 tax basis. At a synthetic 10% exclusive rate, tax is 3.50. An `AFTER_TAX` discount of 2.00 lowers payable to 36.50 but leaves tax 3.50. A separately configured non-taxable 5.00 service charge makes 41.50. A final non-taxable bill rounding adjustment of +0.01 makes 41.51. Tips and cash received/change remain outside 41.51. If that service charge were taxable, its explicit rule/category would create its own bucket; it would not inherit the merchandise bucket silently.

## 10. Implementation boundary and file-lane routing

WHA-313 authorizes this specification only. The smallest future WHA-281 implementation lanes are non-overlapping and have one owner role each; Chief of Staff owns actual assignment/routing:

| Lane                                                 | Files                                                                               | Single owner role              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------ |
| Arithmetic                                           | `src/lib/restaurant/tax-calculator.ts`, `src/lib/restaurant/tax-calculator.test.ts` | Tax calculation engineer       |
| Settlement                                           | `src/lib/restaurant/tenders.ts`, `src/lib/restaurant/tenders.test.ts`               | Checkout settlement engineer   |
| Bill orchestration, only if atomic totals require it | `src/lib/restaurant/bills.ts`, `src/lib/restaurant/bills.test.ts`                   | Billing engineer               |
| Transport, only for quote/error transport            | `src/lib/restaurant/checkout-routes.ts`, one focused existing route/DB test         | Checkout API engineer          |
| Database acceptance                                  | `tests/restaurant-tax-core-rls.test.ts`                                             | Database verification engineer |

No implementation lane may modify `prisma/schema.prisma` or `prisma/migrations/**`. Also excluded: promotion evaluator, schedules, stacking, or caps; UI; offline cache; legal-source/rate configuration; tax authoring/admin API; fiscal devices, filings, invoices, or legal approval. Frozen catalog/modifier and existing promotion evidence are inputs, not implementation scope expansion.

## 11. Dependency DAG and verification gates

`legal/config approval (real data only)` and `canonical tender mapping` feed `effective-rule resolution`; `frozen bill + promotion evidence` and `partial principal ledger` feed `line/category allocation`; those feed `tax/service/discount/rounding`; that feeds `atomic final settlement`; frozen settlement buckets feed `replay, receipt, loyalty, refund/reversal, and reconstruction`.

Implementation gates are:

1. **G1 — Contract mapping:** raw category input is impossible and all three tender types map exactly.
2. **G2 — Cent arithmetic:** category quotes, residual allocation, inclusive/exclusive extraction, and pipeline totals reconcile without double rounding.
3. **G3 — Atomicity:** injected failures at each final-settlement write boundary leave no partial financial state.
4. **G4 — Replay/concurrency:** exact replay is historical; payload conflicts and concurrent losers write nothing.
5. **G5 — Frozen evidence:** reversals and six-month reconstruction succeed with live configuration unavailable.
6. **G6 — Database acceptance:** restricted runtime role, immutability, tenant isolation, snapshot/reversal constraints, and two-connection final-tender concurrency pass.

Legal/configuration approval remains a genuine human lane for production rule content and branch enablement. It does not block synthetic contract/unit/DB tests. There is no unresolved human product decision in this specification.

## 12. Objectively checkable acceptance criteria and named tests

- `tax_tender_type_maps_reserved_category_and_rejects_raw_payment_category`: exact mapping; client/operator category input is rejected/ignored before calculation.
- `tax_quote_cash_card_other_uses_effective_category_rule`: each proposed type returns its distinct server quote from synthetic rules.
- `tax_split_final_category_receives_residual_without_fixed_point`: prior principal becomes weight, final category receives residual, and final due is forward-calculated.
- `tax_split_allocates_each_line_by_largest_remainder_category_order`: every line conserves cents with `CASH,CARD,OTHER` ties.
- `tax_mixed_inclusive_exclusive_extracts_or_adds_once`: inclusive gross is extracted; exclusive tax is added; no double rounding.
- `tax_before_after_discount_preserves_tax_basis`: before-tax lowers basis; after-tax lowers payable only.
- `tax_comp_service_charge_and_rounding_pipeline_reconciles`: comp ordering, explicit service-charge taxability/category, last non-taxable rounding, and bill identity hold.
- `tax_partial_tender_writes_no_snapshot_and_keeps_bill_open`: partial payment has no frozen tax/promotion/loyalty result.
- `tax_final_settlement_is_one_atomic_transaction`: snapshot/buckets, bill/lines, reservation consumption, final payment/tender/drawer, receipt/status, and loyalty all commit or all roll back.
- `tax_final_stale_category_or_amount_returns_reprice_no_writes`: category-dependent quote drift yields `TAX_SETTLEMENT_REPRICE_REQUIRED` and a fresh quote.
- `tax_idempotent_exact_replay_uses_original_result_without_live_lookup`: identical payload returns original bytes/evidence after config changes.
- `tax_idempotency_payload_conflict_rolls_back`: same key/different payload yields `TAX_SETTLEMENT_CONFLICT`.
- `tax_concurrent_final_tenders_settle_exactly_once`: two independent transactions produce one settlement; loser is bill-not-open/settled with no writes.
- `tax_partial_refund_allocates_original_unit_bucket_cents`: partial refund uses original cents and stable largest remainder without current-rule joins.
- `tax_full_reversal_is_exact_negation_and_single_use`: full reversal negates every original bucket and duplicate/over-reversal conflicts.
- `tax_no_effective_profile_fails_closed_without_zero_tax`: newly begun required settlement yields `TAX_PROFILE_UNAVAILABLE` and no writes.
- `tax_legacy_rows_read_without_backfill_and_pre_enable_transaction_finishes_versioned_path`: legacy visibility and the narrow rollout exception are enforced.
- `tax_stable_errors_map_to_no_write_failures`: every section 8 code is transported unchanged and rolls back.
- `tax_snapshot_reconstructs_bill_without_live_catalog_promotion_tax_or_loyalty_joins`: stored evidence alone reproduces line/bucket/bill totals and accrual basis.
- `tax_other_never_infers_gift_voucher_or_loyalty_subtype`: `OTHER` uses only the canonical `OTHER` rule.

Focused code tests cover pure arithmetic and command behavior; the existing route/DB test covers quote/error transport; `tests/restaurant-tax-core-rls.test.ts` covers restricted-role snapshot, reversal, reconstruction, and two-connection concurrency acceptance.

## 13. Risks, rollout, and rollback

- Mixed price modes and cent allocation can surprise operators; the server quote, stable reprice error, and receipt bucket evidence are the mitigation.
- External card authorization cannot always roll back with PostgreSQL; provider attempt/reconciliation must remain outside committed tender identity until the atomic database transaction succeeds.
- Expiring sources or missing rules can stop checkout. This is intentional fail-closed behavior; operational monitoring and approved configuration are the mitigation, not zero tax.
- Existing idempotency storage may not yet retain a payload hash or full reconstructable result. Implementation must satisfy this contract within the allowed lane or stop for a separately authorized schema decision; it must not weaken replay semantics.
- Existing snapshots may not encode every required line/unit allocation. Implementation must prove reconstruction in the allowed lane or escalate a separately authorized schema contract; no live-join reconstruction is acceptable.

Rollout is branch-scoped behind an explicitly versioned enablement boundary. Transactions begun before enablement may finish on the named legacy/no-profile version; transactions begun after enablement cannot fall back. Operational rollback may disable new transaction starts for a branch but must not mutate or delete snapshots, finish post-enable transactions under legacy rules, or reinterpret settled rows. This docs-only task performs no migration and authorizes no deployment.
