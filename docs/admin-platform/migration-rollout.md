# Migration and Rollout

## Planned approach

Inventory every baseline table and classify it as tenant-owned, agency-global, identity-global or retired. Add nullable organization foreign keys first; backfill deterministically; validate counts and orphan reports; enforce constraints; then enable and force RLS. Use reversible, expand/contract migrations and feature flags for route exposure.

Roll out in stages: internal seed tenant → single pilot tenant → limited cohort → general availability. Each stage has defined telemetry, support owner, rollback switch and data-correction process. Never bulk-purge or enable strict RLS before a successful dry run and restore rehearsal.
