
## DEV-665 part 2 — 2026-11-03 source investigation and change scope

Base: `04e502ff` (`fix/dev-665-part2`, matching origin/develop at handoff; local develop is older). No reset, rebase, push or merge. No live database read or mutation. CLI artifacts: `/tmp/dev665-part2-evidence/`.

### Verified source root cause (not an assertion about live Ahmed data)

At the base, `src/app/(app)/pharmacy/loyalty/page.tsx:127-159` used a GET form with a submit-only Search button. Typing Ahmed did not initiate any search. There was no autocomplete, debounce or keyboard result selection. `src/lib/pharmacy/customer-loyalty.ts:416-431` searched **only** `PharmacyCustomer.displayName`, using `contains` and `mode: 'insensitive'`; phone and account ID were absent. So name matching was already partial/case-insensitive, not exact. The source does not prove that a submitted name Ahmed returned no rows in production.

The old directory required an active customer in the current organization. It validated an active branch but did NOT filter customers to that branch and did NOT apply a consent predicate. Branch affects points balances/history, not the retail identity directory. Thus neither branch-membership nor a read-time loyalty-consent filter is a verified reason for Ahmed being missing. A patient-only record is not a retail loyalty customer: `linkCustomerToSale` in the same service creates/updates the retail identity only after its existing loyalty-consent check. Those write/consent rules remain unchanged. Whether live Ahmed is absent, inactive, belongs to another tenant, has a different retail name, or was never linked was NOT inspected and is unverified.

Initial search previously used `contains: ''`, alphabetic first 50 retail identities, with no list balances or recent-points ordering. The unselected page then rendered an empty “Choose an account” card. Fixed with a bounded recent-activity directory and balances plus direct inline history selection. There is no separate loyalty-number field in `prisma/schema.prisma:1129-1157`; the existing customer ID is shown/searchable truthfully as **Account ID**, without inventing a schema field.

### Pre-edit reach and safety map

- `listLoyaltyCustomers`: one production caller, the local loyalty router; unit callers in `customer-loyalty.history.test.ts`. No change to counter snapshots, earning, redemption, refunds, expiry, adjustment, settlement, or consent writers.
- `pharmacyLoyaltyRouter.customers`: server page loader and its new read-only server search action. Existing admin capability, session, CRM entitlement, tenant identity and active-branch checks preserved. Protected `patient.phone` relation lookup uses the existing counter-or-dispense ABAC pattern from `pharmacy-prescriptions.ts:39-55`. When both are denied, retail name/account ID/last4 still work and the patient predicate is omitted. Audit middleware remains active; search input is suppressed before parsing/authorization because it may contain a full phone.
- Page + loading + focused client search: house Input/Button/PageHeader/SectionCard/Stat and semantic tokens retained. Search projection is only id/displayName/phoneLast4/pointsBalance. Full phone, patient ID, CNIC, address, DOB, prescriptions and consents are never returned. Selection/pagination URLs exclude search text. Legacy incoming query parameters are still accepted.
- Existing history rows, signed values, source receipts/devices/sales/tenders/refunds, pagination/page-limit behavior, language-save action and counter link retained. Selecting the already-selected customer refreshes server data.
- Tests: existing service/router/page suites plus a new client interaction suite. No schema, migration, dependencies, central router registration, exports or shared UI components changed. Browser fixtures/logs live outside checkout.
- Base lacks the report medicine picker; supervisor provided a read-only sibling reference. Local combobox follows its min2/250ms/version-counter/keyboard/IME/blur/click pattern without importing sibling work.

Claude-Mem: no callable tool in this session; plugin config entries disabled. No broad history retrieved or global config changed. Codebase Memory worktree index created and graph discovery used. Ponytail/Caveman/Codebase Memory skills read; Studio contract read in full; installed Next use-client/use-server/use-router guides read.

Validation in progress; append final commands/results below. This file MUST remain untracked/uncommitted.
