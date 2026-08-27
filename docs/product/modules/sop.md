# Standard operating procedures

## Implemented today

- **IMPLEMENTED** — Admins author/version SOP templates and steps, schedule occurrences, assign work by role and directly, and operators execute branch-board work. Multi-role access uses unioned permissions. Evidence: [`src/server/routers/restaurant-sop.ts`](../../../src/server/routers/restaurant-sop.ts), [`src/server/routers/restaurant-sop-execution.ts`](../../../src/server/routers/restaurant-sop-execution.ts), [`tests/restaurant-m7-acceptance.test.ts`](../../../tests/restaurant-m7-acceptance.test.ts).
- **IMPLEMENTED** — Execution supports append-only proof/evidence capture, submit/reject/resubmit, manager verification/waiver with permission and co-authorization controls, escalation policies/events, and acknowledgement. Evidence: [`prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql`](../../../prisma/migrations/20260820000000_restaurant_scheduler_sop_notifications/migration.sql), [`tests/restaurant-m7-acceptance.test.ts`](../../../tests/restaurant-m7-acceptance.test.ts), [`tests/restaurant-m7-governance.test.ts`](../../../tests/restaurant-m7-governance.test.ts).

## Acceptance and planned depth

- Due/late/missed/awaiting-verification work is filterable; evidence survives rejection/resubmission; verification is permission-gated; escalation stops on acknowledgement/exhaustion and respects quiet hours. Evidence: [`src/server/routers/restaurant-sop-execution.ts`](../../../src/server/routers/restaurant-sop-execution.ts), [`tests/restaurant-m7-acceptance.test.ts`](../../../tests/restaurant-m7-acceptance.test.ts).
- **PLANNED** — Rich scoring, scorecards, and consolidated SOP reports. Current records can support future reporting but do not prove those product surfaces.
