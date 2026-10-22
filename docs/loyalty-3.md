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

One point is Rs 1 (100 paisa), and a redemption debits at least 200 points. The minimum applies
to the points actually debited: a request is first capped to what the bill can take, and a
capped redemption below the minimum is refused (there is no rounding up). Every award is
computed in integer arithmetic and refused above the PostgreSQL `INTEGER` points column.
Checkout retains the loyalty-1 consent and stacking/benefit-selection rules. It locks the linked
customer/consent boundary, lazily appends expiry entries, checks balance, writes the existing
`LOYALTY` tender and an idempotent `REDEEM` entry in the sale transaction. Thus concurrent sales
cannot both spend the same balance, and a retry with the same sale key cannot debit twice.

Earning rows expire six calendar months after posting. Expiry is an append-only `EXPIRE` debit
of one source lot. The lazy writer (`expireCustomerPoints`) opens its own transaction (or joins
the caller's), locks the customer's points account (the tenant-scoped `pharmacy_customers` row,
which must be exactly one row), reads the branch ledger, plans and inserts in that transaction.
Earning, redemption, restoration and earn reversal take the same lock, so a second caller waits
and plans from the first one's committed debits. It is suitable for checkout and for a future
scheduled batch. Refunds reverse the immutable award proportionally, so a later settings or
tier change cannot reprice the historic earning, and a refunded points tender restores the
share of its points that the refunded share of the tender bought, at that redemption's own
point value.

### Source lots

The planner replays every balance-changing entry of one customer in one branch in order:

| Kind                   | Effect                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EARN`                 | A lot with its own `expiresAt`. Awards written before expiry existed have none and never expire.                                                              |
| `ADJUST` > 0           | A lot; it must carry an `expiresAt`.                                                                                                                          |
| `REDEEM`, `ADJUST` < 0 | Consume lots earliest-expiry first, skipping lots already expired at that time. A redemption remembers the lots it consumed.                                  |
| `REFUND`               | Restores a refunded redemption into the lots that redemption consumed, most recently consumed first, so restored points keep their original earning's expiry. |
| `EARN_REVERSAL`        | Debits the `EARN` of its sale (new rows name it as `sourceEntryId`).                                                                                          |
| `EXPIRE`, `REVERSAL`   | Debit the lot named by `sourceEntryId`.                                                                                                                       |

A debit a named lot cannot cover is consumed like a redemption; a debit nothing can cover is
debt that the next credit repays first. Every remaining point of a lot whose expiry has passed
expires, capped at the balance, so expiry never takes a balance below zero. Each `EXPIRE` key
names its lot and the lot's running expired total, so a lot can expire again after a later
restoration, but the same plan can never be written twice. The database enforces one shape per
kind: `EXPIRE` and `REVERSAL` must name a lot of the same tenant, branch and customer (a
composite foreign key), a positive `ADJUST` must carry an expiry and a negative one must not,
and every `EARN` written from now on must carry its expiry.

## Configuration, authorization, and isolation

Owners can edit medicine/non-drug earn rates, earn block, point value, redemption minimum,
expiry months, and Gold threshold/multiplier through `pharmacy:loyalty-manage`. The capability is
a registered ABAC action with no static policy; the Owner holds it through the canonical
`pharmacy:*` grant of the Owner template, as migrated Owner roles already do, and no other
pharmacy template grants it. The mutation uses central `can()`, so an explicit DENY overrides an
ALLOW. A tenant without a settings row has nothing for `SELECT ... FOR UPDATE` to lock, so both
settings mutations first take the same tenant-keyed transaction advisory lock, then read, upsert
and write the full old/new policy JSON to `PharmacyLoyaltySettingsAudit`: each audit's old value
is exactly the previous audit's new value (the column defaults for the first write). Counter redemption continues to use the
existing sale capability. Tenant predicates and the existing forced-RLS settings/ledger policies
remain the database boundary; points ledger rows remain branch-scoped.

This piece does not send WhatsApp. Any later notification must use the existing pharmacy
provider/outbox and message log transactionally and must honor current consent and opt-out.

## Parallel-build and follow-ups

This branch is intentionally additive and will be rebased onto the loyalty-2 spend-vouchers
sibling after that piece lands. Voucher stacking and benefit selection must continue to use only
loyalty-1 core rules; this piece does not implement or modify the sibling voucher behavior.

- Invoke the lazy expiry service from a scheduled pharmacy job for inactive customers.
- Reconcile any settings-row migration conflict during the loyalty-2 rebase without merging the
  two independently authorized settings mutations.
