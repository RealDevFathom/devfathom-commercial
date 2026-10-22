# Issue #436 archive recovery

## Recovery basis

The requested source is `archive/improve/ai-growth-g2`, compared with
`origin/main`. The archive named the G1 settings model and nightly customer
metrics collector that were absent from the follow-up branch. This recovery
ports those responsibilities onto the current tenant transaction, cron bearer,
Studio settings, audit, and forced-RLS conventions rather than reviving a
parallel application shell.

Recovered:

- tenant-owned `GrowthSettings`, disabled by default;
- daily, replaceable customer metric facts for Restaurant and Pharmacy;
- a nightly authenticated job which enumerates active tenants at platform scope
  but reads settings and writes facts only after narrowing into each tenant;
- an admin-only settings API and Studio settings card;
- focused fail-closed cron and tenant-narrowing tests.

## Skipped archive content

| Content | Why it was skipped |
| --- | --- |
| G1/G2 blocker and validation notes | Historical work-state documents do not change the running product; this file records the current recovery instead. |
| Archived growth insight/recommendation schema | Current `GrowthInsight`, Pharmacy review, and Restaurant review/draft models are richer and already migrated. Restoring the old copies would create conflicting sources of truth. |
| Archived gated tick skeleton | The current provider-backed insight flows already own recommendation generation and review. The recovered nightly route collects metrics only and cannot send or approve a campaign. |
| Demo settings/templates | Production settings must start disabled, and seeded opt-in could enable unattended processing without a tenant administrator's decision. |
| Fixture timestamp-only patch | It targeted archive fixtures that are not restored. New metric timestamps use `TIMESTAMPTZ` and the metric key uses PostgreSQL `DATE`. |
| Restaurant loyalty wallet receipt commits and merge ancestry | They are unrelated ancestry on the archive branch, not part of growth recovery. |

## Security decisions

Both restored tables use forced RLS with no platform bypass. The scheduler may
discover active organization identifiers through the platform connection, but
it cannot read growth settings there. Each settings read and aggregation runs
inside `withTenantDb`. The admin mutation repeats the explicit `ADMIN` check so
a future capability ALLOW cannot override the role DENY. Enabling collection
does not enable outbound messages, campaign approval, or recommendation
generation.
