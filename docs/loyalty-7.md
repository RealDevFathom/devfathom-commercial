# Loyalty 7 — prepaid wallet tiers

## Go-live warning

> **Wallet terms require SBP/legal review before going live.**

The same warning must remain visible on the owner settings surface. Live WhatsApp sending remains blocked: any later wallet notification must use the existing pharmacy transactional provider/outbox, `PatientConsent`, opt-out checks, and message log. This piece adds no live send.

## Boundary and accounting decision

This is stored value, not the restaurant Apple/Google Wallet pass delivery code under `src/lib/restaurant/wallet`. Passes may display a balance later, but are not a ledger and are not wired here. The reusable `src/lib/stored-value` module owns account locking, append-only double-entry journals, balance derivation, idempotency, and statements. Pharmacy policy lives in `src/lib/pharmacy`.

A customer wallet is a **liability**. Khata remains a customer **receivable** and its events are not reused. A top-up debits cash/clearing and credits customer liability: it is cash in, but never sales or taxable revenue. A spend debits liability and credits sales clearing; the existing sale completion recognises revenue. Dashboard/day-close readers show `liabilityMinor` and `topUpCashInMinor` on separate lines outside sale/tax totals.

All amounts are integer paisa (`Int`, `Minor` suffix). No floating-point money is stored.

## Tier and basket rules

Default owner-editable tiers are Bronze (2,000,000 paisa top-up, 200 bps), Silver (5,000,000, 500 bps), and Gold (10,000,000, 1,000 bps). The qualifying top-up independently selects the highest reached tier. Policy/settings changes write old/new JSON to the append-only audit before update.

When balance is exhausted mid-basket, the tier discount applies **only to the wallet-funded portion**. The remainder is paid by another tender at full price. By default wallet discount, voucher, and points do not stack: the server applies the single largest customer benefit. An audited owner setting can enable stacking.

## Counter identity and authorization

The cashier looks up the customer by phone and checks the physical CNIC. Only the last four digits or a keyed HMAC of normalized 13 digits may be stored—never the full CNIC or an image. The entered last four must match before confirming redemption. Every mismatch creates append-only evidence containing tenant, customer, cashier, time and outcome, but no entered or stored digits. Sliding-window limits apply independently per customer and cashier.

`requireOtp` is off by default. `WalletOtpVerifier` is the pluggable boundary; the shipped stub fails closed and performs no send.

Every mutation must call central `can()` with the scoped auth DB. Counter top-up uses `pharmacy:wallet-topup`; adjustment uses `pharmacy:wallet-adjust` plus a non-empty reason; owner tier/settings use `pharmacy:loyalty-manage`. Central DENY precedence remains authoritative. Top-up journals require actor, branch, and tender attribution.

## Transaction and concurrency contract

Spend executes inside the surrounding sale transaction. It locks the tenant/customer account with `SELECT ... FOR UPDATE`, then uses a conditional balance update requiring a non-negative result. The journal has a tenant-unique idempotency key (sale callers use one key per sale), and both signed postings are inserted in that transaction. A deferred constraint trigger rejects fewer than two postings or a non-zero journal sum. UPDATE/DELETE triggers make journal rows, postings, policy audits, and failed matches immutable. RLS is enabled and forced on every tenant table.

Sale refunds re-credit the exact wallet-funded portion with a refund idempotency key. Unused top-up refunds are allowed only when the owner policy permits them and return to the original tender. The expiry worker posts `EXPIRY` against remaining eligible credit with a deterministic idempotency key; it never edits an old row. Manual corrections post `ADJUSTMENT` with manager capability and reason.

## API/read model

`readStoredValueStatement` reads the tenant-filtered statement view ordered by occurrence/id, including its running balance. `readWalletLiability` supplies separate dashboard/day-close liability and top-up cash-in figures. API/router adapters must wrap mutations in the existing tenant transaction and capability guard; raw unscoped Prisma access is prohibited.

## Follow-ups

- Build the owner settings screen with the warning above and old/new audit history.
- Add the sale-router adapter and receipt presentation after the counter flow lands; it must preserve the transaction contract above.
- Add the scheduled expiry runner to the existing job mechanism.
- Optionally project the derived balance into the existing restaurant `WalletPass` balance-update path. This is display-only; never move stored-value accounting into restaurant pass code.
- Implement OTP behind `WalletOtpVerifier`, using the existing consent-aware transactional WhatsApp outbox only after legal/product approval.
