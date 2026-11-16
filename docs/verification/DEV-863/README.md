# DEV-863 — prepaid tiers

The owner console is `/pharmacy/loyalty/prepaid`, linked from the loyalty console and its selected customer. No tiers or earning rate are seeded. Settings publish immutable dated versions. An upfront payment uses the current version; its refund terms and awarded tier remain attributable to that version. Existing funds retain their refund terms. Thresholds accumulate within a funded cycle; reaching zero clears both the tier and qualifying total. Discounts are configurable from 0.01% to 99.99%.

Cash receipts use an existing open drawer, create a prepaid liability journal entry, and state whether that payment is refundable. Mixed balances spend non-refundable funds first. Cash withdrawals use the signed-in owner's fresh refund PIN, including a solo owner. Sale refunds restore the original tender's refundable share to the wallet; cash withdrawals remain a separate PIN-protected operation. No medicine details are sent by WhatsApp.

The existing WALLET tender spends customer funds without an external adapter. Every movement has an immutable ledger entry, tenant scope and idempotency key. A customer transaction lock plus a conditional balance update prevents double spending; database checks prevent negative balances and deferred triggers require account/ledger reconciliation. Tier transitions write audit records. The bill's first tender freezes the discount, including on points or split payments. Existing price floors and regulated-line discount restrictions still apply. Original stock allocations stay immutable; a separate tier allocation snapshot feeds the shared return and journal arithmetic. Receipts show tier savings separately, already included in total discounts.

## Verification

- Unit tests exercise cumulative thresholds, zero-balance loss and requalification, immutable refund terms, idempotency conflicts, tenant rejection, liability postings, wallet settlement, points earning, floor protection and exact return pricing.
- The concurrency regression pauses both sales after reading the same balance, then lets both conditional writes race. Exactly one succeeds; the loser creates no ledger movement and the remaining balance reconciles.
- Router tests cover denied/foreign scope, fresh PIN refusals, solo-owner approval auditing, and replay without duplicate drawer/journal entries.
- Migration tests cover transaction framing, idempotence, tenant RLS, append-only evidence and deferred reconciliation. Existing allocation immutability is unchanged.
- Actual shared Studio components and the new forms were rendered in a local browser fixture at 375, 768, 1024 and 1440 pixels, in light/dark themes, with normal/reduced motion: all 16 combinations had no document overflow or browser errors. Checked loaded, empty, pending, error, saved, disabled-after-payment, refund PIN/confirmation, keyboard focus, preserved input after errors and printable refund terms. Screenshots accompany this note.
- The browser fixture stubs server actions and uses example customers. No database or signed-in tenant is available in this cloud task, so live tenant and database-backed end-to-end checks were not performed. The required database-free unit command preserves the repository's existing database-suite skipping convention.

The PR's Checks section records the exact required command results and tested commit.
