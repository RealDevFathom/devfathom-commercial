# SOP PRD

Operator workflow: [Restaurant administrator guide](restaurant-administrator-guide.md#12-execute-sops-and-evidence).

## Problem

Restaurants need versioned operating-procedure templates, branch-timezone scheduling, staff proof, and independent manager verification. The end-to-end acceptance cases are in `tests/restaurant-m7-acceptance.test.ts`.

## Users and roles

- Staff execute assigned occurrences and attach evidence; managers verify/reject and may waive with distinct co-authorization. See `keeps evidence append-only through rejection, resubmission, and verification` and `requires verify permission and distinct manager co-authorization for a waiver` in `tests/restaurant-m7-acceptance.test.ts`.
- Restaurant-admins create/publish templates and schedules. Platform-admins control organization/module availability only; restaurant operations use `src/server/routers/restaurant-sop.ts` and platform control uses `src/lib/platform/auth.ts`.
- Staff roles are M:N memberships. SOP assignments target either a role pool or a named person,
  with eligible staff claiming role-pool work and duplicate eligibility collapsed: **IMPLEMENTED**.
  The target contract is in `src/lib/restaurant/sop-assignment.ts`; projection tests are in
  `src/lib/restaurant/sop-template-packs.test.ts`, and pool eligibility/claim coverage is in
  `src/lib/restaurant/job-roles.db.test.ts`.

## Current behaviour

- Template families start with editable drafts; publishing freezes versions, retires the prior published version, and scheduling pins the published version. See `creates a family with an initial DRAFT v1 when under the cap`, `retires the prior published version and publishes the draft`, and `pins the latest published version and seeds occurrence steps` in `src/lib/restaurant/sop-templates.test.ts` and `src/lib/restaurant/sop-occurrence-generation.test.ts`.
- Occurrences are generated idempotently in each branch timezone, including DST handling. See `materialises the window once and is idempotent on re-run` and `resolves each branch timezone independently` in `src/lib/restaurant/sop-occurrence-generation.test.ts`.
- Execution transitions scheduled/rejected → in progress, records completed steps and hashed evidence, then submits on-time or late. See `src/lib/restaurant/sop-execution.test.ts` exact tests `transitions SCHEDULED → IN_PROGRESS`, `computes sha256 from contentBytes and creates evidence`, and `transitions IN_PROGRESS → LATE when window has closed`.
- Managers verify or reject; missed/late occurrences can be waived only with co-authorization. See `src/lib/restaurant/sop-verification.test.ts`.

## Data model

Template/version/step, assignment/schedule, occurrence/occurrence-step, evidence, verification, escalation, and immutable event records are defined in the M7 section of `prisma/schema.prisma`. Published template immutability is verified by `addStep is rejected on a PUBLISHED version` in `src/lib/restaurant/sop-templates.test.ts`.

## API surface

Restaurant-admin template/schedule operations are exposed by `src/server/routers/restaurant-sop.ts`; staff execution and verification by `src/server/routers/restaurant-sop-execution.ts`. Scheduler/job entry points are in `src/lib/restaurant/scheduler.ts` and `scripts/run-restaurant-jobs.ts`.

## Edge cases and failure modes

- An unpublished template schedules nothing; concurrent unique collisions converge to a skip; non-unique database errors propagate. See exact tests in `src/lib/restaurant/sop-occurrence-generation.test.ts`.
- Evidence remains append-only through rejection/resubmission, while invalid-state transitions fail. See `keeps evidence append-only through rejection, resubmission, and verification` in `tests/restaurant-m7-acceptance.test.ts` and `src/lib/restaurant/sop-execution.test.ts`.
- Late becomes missed only on scheduler sweep; escalation stops on acknowledgement/exhaustion and defers quiet hours. See exact tests `moves LATE to MISSED only when the scheduler sweep runs` and `terminates escalation on acknowledgement or exhaustion and defers quiet hours` in `tests/restaurant-m7-acceptance.test.ts`.

## Gaps

- Evidence malware scanning, external object-storage retention policy, and offline SOP execution: **NOT IMPLEMENTED**.
