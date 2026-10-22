# GitHub issue #297 is already fixed

Verified against the current code on 2026-10-22. No production or test code changes are needed:

- `src/app/(app)/organization/organization-admin-content.tsx:296` pluralizes `seat` from
  `entitlements.seatLimit`, so a limit of one produces `licensed seat` while larger limits produce
  `licensed seats`. It independently chooses `is` or `are` from the active-seat count.
- `src/app/(app)/organization/organization-admin-content.people.test.tsx:112-130` renders the
  organization administration UI and verifies the complete copy for `(active seats, seat limit)`
  values `(1, 1)`, `(1, 10)`, and `(2, 10)`. The first expected value is
  `1 of 1 licensed seat is currently occupied.`

This directly covers the reported singular-limit regression and retains coverage for the reported
`1 of 10 licensed seats is currently occupied.` case.
