# Pharmacy loyalty 4/6 — win-back

## Design

Win-back is disabled by default. An owner configures an inactivity threshold
(45 days by default), a campaign-window length, a minimum historical spend,
minimum next basket, and non-overlapping spend tiers. Voucher values are limited
to Rs 200–1,000, represented as 20,000–100,000 integer paisa. Historical spend
is the net paid amount from completed `PharmacySale` records; the points ledger
is deliberately not an input.

Eligibility requires an active retail customer whose last completed sale is at
least the configured age, current `LOYALTY` consent, and current WhatsApp opt-in.
The scheduled adapter must aggregate sales within the tenant and pass those
facts to the win-back service. A unique customer plus campaign-window claim is
made in the same transaction as voucher issuance and transactional outbox
preparation. Vouchers are created only through the loyalty-1 voucher service, so
its expiry and abuse limits remain authoritative.

## Margin preview and enable gate

Before enablement, an owner with `pharmacy:loyalty-manage` must generate a
preview. The immutable preview stores the canonical SHA-256 settings hash,
eligible count, total face-value liability, expected redemptions, expected
voucher cost, expected gross margin, and net margin impact. Enabling records the
preview id and hash and fails when settings have changed since preview.

The documented default assumption is a 25% redemption rate. Expected voucher
cost is face-value liability times that rate. Expected gross margin is each
eligible customer's expected basket times the same rate and their primary
category margin, falling back to 1,450 basis points (14.5%). Net impact is
expected margin less expected voucher cost. All calculations use integer paisa
and basis points; no floating-point money is stored or accepted.

Owner settings changes and enablement are audited with actor and old/new state.
Every owner mutation calls central `can()` so an explicit permission DENY wins.
All new tenant tables use the session organization default and forced RLS.

## Messaging and safety

The job prepares a `WIN_BACK` transactional message in the existing pharmacy
message log/outbox transaction after rechecking consent and opt-out eligibility.
It does not call a live transport. The existing provider factory continues to
block live Meta sends in code, while mock mode can prepare the configured
`PHARMACY_WHATSAPP_TEMPLATE_WIN_BACK` template for testing.

## Parallel-build integration and follow-ups

This branch is based on loyalty-1 and **must be rebased onto the relevant sibling
loyalty branch once it lands**. Loyalty-2/3/5 behavior is intentionally not
implemented here. During that rebase, wire the repository adapter into the
existing jobs schedule, using completed-sale net paid aggregation and latest
`PatientConsent` records, and expose the owner form using the shared Studio
components. Keep the unique issuance claim as the database concurrency boundary
and add PostgreSQL RLS/race coverage in the integration suite.
