# Pharmacy loyalty 3/6 — points

## Design and binding defaults

The existing `PharmacyLoyaltyPointsEntry` is the only points ledger and the existing
`LOYALTY` tender remains the redemption tender. No customer, consent, messaging, or payment
model is duplicated. Money is integer paisa throughout.

Eligible net paid is split between drug (`PHARMACEUTICAL` and `BIOLOGICAL`) and non-drug
catalogue families. Each category is rounded down independently: medicines earn 1 point for
each complete Rs 100 (10,000 paisa), while non-drug items earn 3. A partial payment is allocated
proportionally with integer arithmetic before those independent floors. The deterministic paisa
remainder is assigned to non-drug. An enabled Gold tier multiplies the resulting whole-point
award by 2 after a customer reaches Rs 50,000 (5,000,000 paisa) eligible spend in the preceding
12 months. Gold is off by default.

One point is Rs 1 (100 paisa), and checkout rejects a redemption request below 200 points.
Checkout retains the loyalty-1 consent and stacking/benefit-selection rules. It locks the linked
customer/consent boundary, lazily appends expiry entries, checks balance, writes the existing
`LOYALTY` tender and an idempotent `REDEEM` entry in the sale transaction. Thus concurrent sales
cannot both spend the same balance, and a retry with the same sale key cannot debit twice.

Earning rows expire six calendar months after posting. Consumption and expiry use earliest-expiry
first (FIFO); expiry is represented by an append-only `EXPIRE` debit tied to its source earning.
The lazy writer is suitable for checkout and can also be invoked by a future scheduled batch.
Refunds reverse the immutable award proportionally, so a later settings or tier change cannot
reprice the historic earning.

## Configuration, authorization, and isolation

Owners can edit medicine/non-drug earn rates, earn block, point value, redemption minimum,
expiry months, and Gold threshold/multiplier through `pharmacy:loyalty-manage`. The mutation uses
central `can()`, so an explicit DENY overrides an ALLOW, locks the tenant settings row, and writes
full old/new JSON to `PharmacyLoyaltySettingsAudit`. Counter redemption continues to use the
existing sale capability. Tenant predicates and the existing forced-RLS settings/ledger policies
remain the database boundary; points ledger rows remain branch-scoped.

This piece does not send WhatsApp. Any later notification must use the existing pharmacy
provider/outbox and message log transactionally and must honor current consent and opt-out.

## Parallel-build and follow-ups

This branch is intentionally additive and will be rebased onto the loyalty-2 spend-vouchers
sibling after that piece lands. Voucher stacking and benefit selection must continue to use only
loyalty-1 core rules; this piece does not implement or modify the sibling voucher behavior.

- Invoke the lazy expiry service from a scheduled pharmacy job for inactive customers.
- Add PostgreSQL integration coverage for the two-session redemption race and forced-RLS tenant
  isolation when the shared database harness is available.
- Reconcile any settings-row migration conflict during the loyalty-2 rebase without merging the
  two independently authorized settings mutations.
