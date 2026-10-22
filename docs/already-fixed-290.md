# GitHub issue #290 — already fixed

Verified against the current code on 2026-10-22. No additional production or test code is
needed.

## Evidence

- `src/lib/pharmacy/regulatory.ts:64-86` derives the current calendar date with
  `workspaceToday(branch.organizationTimezone, at)` and compares that date with the stored licence
  start and end dates. A licence starting on `2026-10-21` is therefore valid from 00:00 in the
  organization's timezone rather than from 00:00 UTC.
- `src/lib/pharmacy/regulatory.ts:114-127` converts the operation instant to the organization's
  calendar date before selecting the effective regulatory profile. This makes the checklist and
  stored-profile guard select a profile effective "today" at local midnight.
- `src/server/routers/pharmacy-onboarding.ts:269-282` reads the tenant organization by
  `organizationId`, selects only its timezone, and derives the workspace-local date.
- `src/server/routers/pharmacy-onboarding.ts:291-333` keeps the profile query tenant- and
  branch-scoped, then calculates `inForce` from the workspace-local date. The profile UI therefore
  stops showing today's version as scheduled at local midnight.
- `src/lib/pharmacy/regulatory.test.ts:67-96` covers the issue's exact PKT boundary instants:
  `2026-10-20T19:00:00.000Z`, `2026-10-20T23:59:59.999Z`, and the instant immediately before the
  local start day.
- `src/server/routers/pharmacy-onboarding.db.test.ts:284-320` covers switching the displayed
  in-force profile at local midnight in both `Asia/Karachi` and `America/New_York`.

The existing implementation remains fail-closed for unconfirmed rules and invalid licences, and
this verification found no change to authorization grants, WhatsApp sending, logging, or database
migrations.
