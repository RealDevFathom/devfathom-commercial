# DEV-863 — prepaid tiers

The owner console is `/pharmacy/loyalty/prepaid`, linked from the loyalty console. Only the
organization's owner (session ADMIN) can open it, publish tiers, take upfront payments, refund
prepaid cash or reset a customer's PIN; a delegated employee is refused even with every grant and
their own valid PIN. No tiers or earning rate are seeded. Settings publish immutable dated versions.
An upfront payment uses the current version; its refund terms and awarded tier stay attributable to
that version. Reaching a zero balance clears both the tier and the qualifying total.

Upfront cash goes through an open drawer, posts a `CUSTOMER_PREPAID` liability and prints whether
it is refundable. The customer chooses a 4–8 digit spend PIN with their first payment; only its
bcrypt hash is stored. Prepaid cash refunds need the signed-in owner's fresh PIN (a solo owner uses
their own) and are refused for non-refundable funds.

At the counter, the Wallet tender spends the linked customer's prepaid balance only with that
customer's PIN. A wrong PIN commits a lockout strike in its own transaction (five strikes lock the
balance for 15 minutes) and the payment re-checks the PIN under the customer lock. An untouched
amount defaults to what the balance covers. The tier discount applies to the whole bill, respects
every lot price floor and the regulated-line rules, stacks with points and shows as its own receipt
line. A line added after a partial payment is priced; a line already on the bill when money was
taken is never repriced. Prepaid refunds always return to the balance: the return panel shows no
cash instruction and the server refuses a cash fallback. Failed deliveries restore prepaid tenders;
cash-on-delivery amounts and batch/supplier sales reports use the discounted bill.

Every movement is an immutable, numbered ledger entry. At commit the database requires the account's
balance, refundable share, qualifying total and tier to equal its newest entry, every entry's
post-balance to equal its running total, and every tier transition to chain from the previous
entry. Inserted or updated sale lines carrying a tier discount must have matching allocation
evidence at commit.

## Verification

- `src/lib/pharmacy/prepaid-tiers.db.test.ts` runs on a fully migrated PostgreSQL as a NOSUPERUSER
  NOBYPASSRLS role (`TEST_DATABASE_URL` + `PHARMACY_TEST_OWNER_DATABASE_URL`; skipped without them):
  non-negative balances, one winner for two concurrent spends, ledger reconciliation of balances,
  tiers and entry snapshots, tenant isolation, refusal of non-refundable refunds, the hashed spend
  PIN and insert-time line evidence. It passed twice on a local PostgreSQL 16 with the full
  migration history; the prepaid migration also re-applied cleanly.
- A temporary full-checkout probe on the same database (not committed) priced a tier sale,
  refused spends without or with a wrong PIN, priced a line added after a partial payment,
  completed the sale, refused a cash fallback on the prepaid refund and restored the balance.
- The changed counter, return and console components were rendered in a browser fixture at 375,
  768, 1024 and 1440 px, light and dark, normal and reduced motion: no document overflow, visible
  focus on the PIN field, no render errors. Screenshots accompany this note.
