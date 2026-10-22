# Pharmacy loyalty 6/6 — owner dashboard

## Design

The Pharmacy Insights area now reads a dedicated loyalty dashboard for a bounded date range and
one server-authorized branch or all server-authorized branches. The dashboard reports voucher
issue/redemption counts and integer paisa, redemption and repeat-visit rates in basis points,
customers whose latest completed visit is older than the selected churn threshold, points
liability in integer paisa, and realized net margin impact. Empty cohorts produce a zero rate.

Each source is queried through a small adapter: vouchers, completed customer sales, the existing
`PharmacyLoyaltyPointsEntry` ledger, and redeemed-sale lines. Points liability uses the canonical
`LOYALTY_POINT_VALUE_MINOR`; it does not create another points model. Redeemed-sale margin uses the
existing per-category margin basis points, keyed by `Medicine.productFamily`, with the configured
default margin fallback. Net impact is category-basis-point gross margin less redeemed voucher
face value. No monetary calculation accepts or stores floating-point values.

## Authorization and tenancy

The tRPC read is tenant-scoped by the existing scoped database and module middleware. It calls
central `can()` with `pharmacy:loyalty-manage` before reading branches or metrics, so an explicit
DENY wins. A client-supplied branch must occur in the server-derived active branch set. Raw queries
also assert the session organization and selected branch ids; FORCE RLS remains the final boundary.
No migration is required for this read-only piece.

## Parallel-build decisions and follow-ups

This branch is additive and **will be rebased onto the relevant loyalty-2/3/5 or wallet sibling
once it lands**. It does not duplicate consent, reminders, messaging, voucher, points, or tender
tables, and it performs no WhatsApp send. The sibling source tables required by the current metric
contract are present in this build, so no zero-return compatibility adapter is active.

After rebase, confirm the sibling's category identifier contract. If it introduces a category
other than `Medicine.productFamily`, update only the redeemed-margin query adapter and retain the
default-basis-point fallback. Also add disposable PostgreSQL coverage for the FORCE RLS boundary
and cross-branch assignments when the sibling migrations are composed.
