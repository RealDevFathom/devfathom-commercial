# Pharmacy counter promotions (#727)

Administrators with the pharmacy counter module can use `pharmacySales.promotions`,
`createPromotion`, and `disablePromotion` for an active branch in their organization.
The current administrator authorizes the rule; creation and deactivation use the existing
admin audit middleware. Rule content is immutable in PostgreSQL. Replace an offer by
disabling it and creating another.

An offer has a name, branch, optional medicine target, start and end instants, priority,
and either percentage basis points or a fixed discount in PKR minor units. The window is
`effectiveFrom <= server instant < effectiveTo`. Pass explicit UTC-offset instants for
local date boundaries (for example, midnight in Pakistan is `19:00Z` on the preceding
UTC date). There are no recurring daily windows or coupons in this change.

The online counter evaluates offers when adding a line, after the actual lot prices and
costs are known. The restaurant promotion evaluator and its #242 exact money allocation
provide rounding and allocation. A percentage rounds once for the line; a fixed amount
applies once to the line. Eligible offers are considered by priority descending, then id
ascending; the first offer that preserves cost coverage applies. Offers do not stack with
one another or with a manual discount/complimentary line. Rx, restricted, and controlled
medicines never receive an automatic promotion. Signed offline replay and reserved order
checkout keep their existing quoted prices.

The line stores the promotion id/name, discount, and creator authorization. Its `LINE_ADDED`
event also records the rule benefit, date window, and evaluation instant. Existing tender,
journal, return, and refund logic consumes the same persisted `discountMinor`. Adding an
offer or disabling it does not reprice lines already in a cart or a completed sale.
Receipts show descriptive savings with English/Urdu labels; totals include the discount
once. Reprints read the stored name and price.

Coverage added (not executed in the implementation worktree):

- Pure evaluation: boundaries, exact rounding, amount caps, targeting, overlap priority,
  regulated medicine exclusion, and cost coverage.
- Counter hook: persisted price/authorization/event, manual discounts, offline compatibility,
  and the existing discount guardrails.
- Real router middleware: administrator/tenant/branch/module checks, explicit denials,
  regulated targets, scoped listing/deactivation, and audit metadata.
- Migration contract and PostgreSQL acceptance: FORCE RLS, cross-tenant/branch refusal,
  rule constraints/immutability, settled net, journal discount, and stable reprint.
  The DB suite uses a migrated disposable `PHARMACY727_TEST_DATABASE_URL` with database
  name `pharmacy727_*`, requires NOSUPERUSER NOBYPASSRLS, and rolls back all fixtures.
- Receipt formats: browser A4/thermal, receipt document, raw print facts, bilingual savings,
  escaping, and the existing receipt component.

Visual QA remains for machine C / the QA review. The receipt view reuses the existing
`text-text-muted` and `break-words` styles. No new shell, controls, or tokens are introduced.
The Studio matrix (375/768/1024/1440px; light/dark; normal/reduced motion; keyboard;
layout overflow; loading/empty/error/disabled states; console) has not been executed here.
No tests, typecheck, lint, build, Prisma commands, or security checks were run, as requested.
