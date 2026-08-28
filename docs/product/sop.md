# Standard operating procedures PRD

## Problem

Restaurants need versioned procedures scheduled in branch-local time, execution proof, and manager decisions that remain auditable after rejection, resubmission, and escalation.

## Users and roles

- **Restaurant admin/SOP manager:** authors templates, publishes versions, creates branch schedules, previews recurrence, and manages escalation policy under tenant capabilities. Evidence: [`src/server/routers/restaurant-sop.ts`](../../src/server/routers/restaurant-sop.ts).
- **Restaurant operator:** starts an occurrence, completes steps, attaches evidence, submits, and acknowledges escalation when permitted. Evidence: [`src/server/routers/restaurant-sop-execution.ts`](../../src/server/routers/restaurant-sop-execution.ts).
- **Restaurant manager/verifier:** verifies/rejects and may waive with distinct co-authorization. This is not a platform-admin power. Evidence: [`src/lib/restaurant/sop-verification.ts`](../../src/lib/restaurant/sop-verification.ts), [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts) — `requires verify permission and distinct manager co-authorization for a waiver`.
- **Platform admin:** manages entitlements/lifecycle in the platform realm; it does not resolve restaurant SOP assignments. Evidence: [`src/lib/entitlements.ts`](../../src/lib/entitlements.ts), [`src/lib/platform/auth.ts`](../../src/lib/platform/auth.ts).

## Current behaviour

- A template family starts with a mutable DRAFT version. Publishing requires steps, freezes that version, retires the prior published version, and later drafts clone history forward. Evidence: [`src/lib/restaurant/sop-templates.ts`](../../src/lib/restaurant/sop-templates.ts), [`src/lib/restaurant/sop-templates.test.ts`](../../src/lib/restaurant/sop-templates.test.ts) — `addStep is rejected on a PUBLISHED version` and `retires the prior published version and publishes the draft`.
- A branch assignment stores daily/weekly/monthly recurrence, interval, local due time, window, grace, and date range. Generation is idempotent, resolves each branch timezone/DST, pins the latest published version, and seeds occurrence steps. Evidence: [`src/lib/restaurant/sop-occurrence-generation.ts`](../../src/lib/restaurant/sop-occurrence-generation.ts), [`src/lib/restaurant/sop-occurrence-generation.test.ts`](../../src/lib/restaurant/sop-occurrence-generation.test.ts) — `materialises the window once and is idempotent on re-run` and `computes the due instant in the branch timezone with DST spring-forward`.
- Execution supports SCHEDULED → IN_PROGRESS → SUBMITTED/LATE, REJECTED → rework, VERIFIED, MISSED, and WAIVED. Step completion is idempotent; proof stores content hash/metadata; verification decisions are appended. Evidence: [`src/lib/restaurant/sop-execution.ts`](../../src/lib/restaurant/sop-execution.ts), [`src/lib/restaurant/sop-verification.ts`](../../src/lib/restaurant/sop-verification.ts), [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts) — `keeps evidence append-only through rejection, resubmission, and verification`.
- **IN PROGRESS / NOT IMPLEMENTED at this union:** assignments do not have role-target or person-target rows/fields. Many-to-many operator roles and assignment resolution as `(all eligible role assignees) ∪ (direct people)` are required, but current occurrence listing is branch/status based rather than resolved through that union. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma) (`RestaurantSopAssignment`), [`src/server/routers/restaurant-sop-execution.ts`](../../src/server/routers/restaurant-sop-execution.ts).

## Data model

`RestaurantSopTemplate`, immutable versions/steps, branch `RestaurantSopAssignment`, dated occurrences/steps, append-only evidence and verification rows, escalation policies/events, jobs/outbox, and notifications are canonical. No SOP assignment-role or assignment-person join model exists. Evidence: [`prisma/schema.prisma`](../../prisma/schema.prisma), [`prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql`](../../prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql).

## API surface

Tenant tRPC `restaurantSop` exposes template/version/step/assignment/schedule-preview management; `restaurantSopExecution` exposes board/detail/start/complete-step/attach-evidence/submit/verify/reject/waive/acknowledge. Evidence: [`src/server/routers/restaurant-sop.ts`](../../src/server/routers/restaurant-sop.ts), [`src/server/routers/restaurant-sop-execution.ts`](../../src/server/routers/restaurant-sop-execution.ts).

## Edge cases and failure modes

- Empty publish, editing a published/retired version, invalid recurrence, missing published version, duplicate generation, DST gaps/folds, illegal execution state, missing required proof, same-person waiver approval, and cross-tenant references fail or skip deterministically. Evidence: [`src/server/routers/restaurant-sop.test.ts`](../../src/server/routers/restaurant-sop.test.ts) — `maps a step mutation on a PUBLISHED version to CONFLICT` and `returns the next-valid instant across a NY spring-forward gap`; [`src/lib/restaurant/sop-verification.test.ts`](../../src/lib/restaurant/sop-verification.test.ts) — `throws CO_AUTH_REQUIRED when actor and approver are the same`.
- LATE becomes MISSED only during the scheduler sweep; escalation stops on acknowledgment/exhaustion and defers quiet hours. Evidence: [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts) — `moves LATE to MISSED only when the scheduler sweep runs` and `terminates escalation on acknowledgement or exhaustion and defers quiet hours`.

## Gaps

- **IN PROGRESS / NOT IMPLEMENTED:** many-to-many staff roles, direct-person assignment, and union resolution described above.
- **NOT IMPLEMENTED:** rich SOP scoring, scorecards, consolidated compliance reports, and proof authenticity beyond stored hashes/metadata.
- **PARTIAL:** in-app notification state is implemented; external delivery channels remain stubbed where tests say so. Evidence: [`tests/restaurant-m7-acceptance.test.ts`](../../tests/restaurant-m7-acceptance.test.ts) — `persists in-app read state, stubs external channels, and omits matrix-off delivery`.
