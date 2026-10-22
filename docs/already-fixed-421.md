# GitHub issue #421 is already fixed

Issue #421 reports that agency projects accept an end date before their start date through tRPC
create, tRPC partial update, and REST create. The current code already rejects all three cases:

- `src/lib/project-dates.ts:1-8` defines the shared comparison and accepts a complete range only
  when the end timestamp is greater than or equal to the start timestamp.
- `src/server/routers/projects.ts:74-89` applies that comparison to the tRPC create input and
  reports the validation error on `endDate`.
- `src/server/routers/projects.ts:162-176` authorizes access before loading the persisted dates,
  combines omitted update fields with those persisted values, and rejects an invalid effective
  range before updating the project.
- `src/app/api/v1/projects/route.ts:27-42` applies the same comparison to the REST create schema
  and reports the validation error on `endDate`.
- `src/server/routers/projects-dates.test.ts:48-84` contains focused regression coverage for an
  inverted tRPC create range, a partial tRPC update checked against the stored start date, and an
  inverted REST create range.

These protections were already present at the start of this issue verification, so no production
code or tests were changed.
