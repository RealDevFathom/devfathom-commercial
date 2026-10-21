[QA][Pharmacy][SEV4] People card says “1 licensed seats are currently occupied”
Labels: qa, pharmacy, sev4-trivial, ux

## Environment

- Branch: `qa/pharmacy-restaurants-agencies`
- Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`
- Date: 2026-10-21
- Tenant: `http://qa-clifton.localhost:3000/organization`
- Occupied seats: 1 of 10 (Pharmacy Owner only)

## Test case

PH-UX-03

## Steps

1. Sign in as the pharmacy owner.
2. Open `/organization`.
3. Read the People and access card.

## Expected

The sentence agrees with the count: “1 licensed seat is currently occupied.”

## Actual

The card description is “1 licensed seats are currently occupied.” The seat stat above it correctly shows `1/10`.

## Evidence

- `qa/pharmacy/evidence/fu-_organization.txt`
- `qa/pharmacy/evidence/fu-_organization.png`

## Suggested code area

`src/app/(app)/organization/organization-admin-content.tsx` — People and access `description` uses `` `${entitlements.activeSeats} licensed seats are currently occupied.` ``

No fix is proposed here.
