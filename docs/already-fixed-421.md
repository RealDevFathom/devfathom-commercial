# GitHub issue #421 verification and follow-up

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

These date protections were already present at the start of this issue verification. The follow-up
security review found that both tRPC writes and REST create also needed the central ABAC decision:

- `src/server/routers/projects.ts:71` and `src/server/routers/projects.ts:148` declare
  `projects:write` capability middleware before their create/update resolvers; update retains the
  project membership check as its object-level constraint.
- `src/app/api/v1/projects/route.ts:45-52` evaluates the token-bound user through `can()` before
  parsing or persisting a REST create request.
- `src/lib/abac/policies.ts` registers `projects:write` for active agency members, preserving the
  former baseline while the central engine continues to give an explicit DENY precedence over an
  ALLOW.
- `src/server/routers/projects-dates.test.ts` checks both tRPC write declarations, and
  `src/lib/project-authorization.test.ts` covers the baseline grant and DENY-over-ALLOW behavior.
