# DevFathom delivery status

Last reconciled: 2026-09-02 (PKT)

Repository evidence is not release evidence. The canonical private base `c7f15f65` is clean, and
local tenant and admin health endpoints return 200. Restaurant is not yet complete, pushed, merged,
deployed, or production-proven.

## Restaurant checkpoint

- Implemented source remains present across onboarding, catalog/menu/OCR, POS/KDS, orders and
  settlement, tax, inventory/purchasing, workforce, SOP, loyalty, reports, devices, and cameras.
- Printing now has a durable job/routing/idempotency bridge and ESC/POS rendering, but its only
  adapter is simulation-only. It performs no physical printer, network, or operating-system I/O.
- Direct, connected Delivery source is implemented: Delivery publications, saved customer addresses,
  branch zones, frozen snapshots, PREPAID/COD kitchen handoff, settlement, daily close, Reports,
  and Insights are implemented. Offline, missing-customer, and capability-denied attempts are
  rejected before mutation. Marketplace providers and full driver logistics remain deferred.
- Accepted private artifacts exist for the KDS harness at `92b36ab6`, selector correction through
  `b6015622`, controls product lineage through `958575ba`, and corrected OCR/offline POS through the
  independently approved `b1a99d2b`. Final controls E2E is still running.
- The deterministic cross-date seed correction at `652145d2` remains pending under exact focused
  verification; it is not yet accepted.
- A restricted fresh PostgreSQL 16 final-gate database is ready on private port 55586 with 56/56
  migrations applied and restricted flags verified.
- Card acquiring is provider-dependent. OPay New 9220 is a candidate device, not an integrated or
  accepted provider; simulation/local tender records do not prove authorization or settlement.
- Pakistan tax calculation/configuration source exists. Fiscal filing, fiscal-device certification,
  authority e-invoicing, and legal/accounting approval remain external.

## Pending release gates

- Final documentation, integration, and full Restaurant, SuperAdmin, and Agency browser, build, and
  release gates remain pending.
- Provider/hardware acceptance for card acquiring, printing, drawers, KDS devices, and cameras.
- Final restricted-role PostgreSQL, RLS, extension, deployment, and operating evidence required by
  release governance remains pending beyond the prepared private final-gate database.

## Optional or deferred scope

- Marketplace APIs, live rider tracking, route optimization, physical hardware integrations, native
  mobile, reservations/waitlist, stored value, payroll execution, tip payout, production batches,
  and full driver logistics remain optional or deferred unless explicitly approved.
- Saad alone authorizes push, shared-ref merge, deployment, or production smoke.

Detailed decisions and implemented-module evidence remain in the
[Restaurant management system plan](industry-specific-docs/restaurants/restaurant-management-system-plan.md).
