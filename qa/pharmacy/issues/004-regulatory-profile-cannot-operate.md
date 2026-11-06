[QA][Pharmacy][SEV1] A Sindh pharmacy cannot record an operable regulatory profile
Labels: qa, pharmacy, sev1-critical

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000` (`qa-clifton`, Pharmacy Professional, status ONBOARDING)
- Branch under test: Clifton Chemist, code MAIN, city Karachi, province Sindh (`PK-SD`), created by platform onboarding
- Signed in as `owner@qa-clifton.test` (organization administrator)

## Test cases

PH-ST-01, PH-ST-03, PH-GAP-03

## Steps

1. Create the pharmacy with premises in Karachi, Sindh.
2. Sign in on `qa-clifton.localhost`.
3. Open `/pharmacy/regulatory`.
4. Read the first-version form for Clifton Chemist — Karachi.

The run stalled before Save this version was submitted. The page already states the branch cannot operate.

## Expected

The profile offers Sindh (and the other Pakistan provinces), published licence categories, and published medicine schedules. A complete profile can be saved and can satisfy premises-and-licences so activation is possible. A provisional rule set is labeled as such and is not the only choice for a Sindh premises.

## Actual

The form selects **Punjab (rules provisional)** for the Karachi branch. The page says: “These rules are still provisional, so this branch cannot operate on them yet.”

Licence category is “Provisional — awaiting published categories” with the note that this province has not published licence categories. Permitted schedules say “Nothing to choose yet” and that medicine schedules are not published. No regulatory version exists. Onboarding step 4 (Premises and licences) stays NEEDS YOU, and activation stays BLOCKED.

A pharmacy in Sindh cannot finish the evidence-backed licence gate. `assertStoredBranchMayOperate` treats an unconfirmed rule set as a reason the branch cannot operate. Seeded jurisdiction data in this tree exposes a provisional Punjab set; the form does not offer a published Sindh set.

## Evidence

- `qa/pharmacy/evidence/fu-_pharmacy_regulatory.txt`
- `qa/pharmacy/evidence/fu-_pharmacy_regulatory.png`
- `qa/pharmacy/evidence/fu-_pharmacy.txt` (activation BLOCKED, step 4 NEEDS YOU)

## Suggested code area

- Jurisdiction rule seed (only a provisional `PK-PB` set is present for this database)
- `src/lib/pharmacy/regulatory.ts` (`assertStoredBranchMayOperate`, `RULE_SET_UNCONFIRMED`)
- `src/app/(app)/pharmacy/regulatory/` profile form
- `src/lib/pharmacy/onboarding.ts` gate `PREMISES_AND_LICENCES`

No fix is proposed here.
