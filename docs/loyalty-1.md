# Pharmacy loyalty 1 — voucher core

## Design

The existing pharmacy customer, `PatientConsent` (`LOYALTY` purpose), points
ledger, sale, and `LOYALTY` tender remain canonical. Vouchers add a separate
single-use value instrument rather than another customer or payment model.
Values and subtotals are integer paisa (`*Minor`); floating-point money is not
accepted.

Codes contain 12 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`. Generation
uses `crypto.randomInt`; the database uniqueness boundary is organization plus
code, and issuance retries a unique collision up to eight times. Default expiry
is issue time plus 30 days and is configurable by the owner.

Every tenant row has the session organization default and forced RLS. Settings
mutations require central `can(..., 'pharmacy:loyalty-manage')`; counter issuance,
lookup, and redemption reuse the counter/sale capability. Explicit DENY therefore
wins. Settings audits contain the full old/new documents. Exceptional redemption
also records actor, reason, voucher, sale, and violated rules.

Lookup consumes both a user+IP bucket and a branch bucket from the shared rate
limiter. Unknown, expired, redeemed, void, and cross-tenant codes return the same
`VOUCHER_NOT_FOUND` result.

## Checkout and concurrency

Voucher redemption runs within the pharmacy checkout transaction. It locks the
organization-scoped voucher row, checks `ISSUED`, abuse limits, expiry, minimum
basket, and scope eligibility, then conditionally changes `ISSUED` to `REDEEMED`
before writing one `LOYALTY` tender. A unique `(organizationId, redeemedSaleId)`
constraint makes one voucher per sale/visit non-stackable. The sale idempotency
key is carried into the tender adapter, so replay returns the prior sale result.
The conditional status transition means two sales racing for one code have one
winner even if a storage adapter's row lock is ineffective.

`WHOLE_BASKET` is the binding default. When an owner selects `NON_DRUG_ONLY`, Rx
and OTC catalogue lines are excluded and value is capped at the remaining
subtotal.

## Refund rule

A refund reverses value in the same proportion as the refunded eligible sale
value and never returns cash beyond the amount originally paid by non-voucher
tenders. Full reversal voids the redemption and reissues remaining voucher value
as a new code (preserving the original expiry and scope) rather than reopening a
known code. This follow-up must be implemented atomically in the existing
pharmacy refund transaction and journal path.

## Messaging and privacy

This core does not send live WhatsApp messages. A future notification must use
the existing pharmacy provider/outbox and message log, must be transactional,
and must check current consent and opt-out state. Voucher phone data must not be
used to bypass `PatientConsent` or the existing customer opt-out.

## Follow-ups

- Wire the storage adapter into the sales router checkout transaction and its
  existing money-idempotency record.
- Complete proportional refund/reissue and finance journal evidence.
- Add owner settings and cashier lookup surfaces without enabling live sends.
- Add PostgreSQL concurrency/RLS coverage in the database integration suite.
