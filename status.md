# DevFathom delivery status

Last reconciled: 2026-08-31 (PKT)

Repository evidence is not release evidence. This checkpoint records source truth at exact code SHA
`3a49b696d2bb6000da6d084247274012f4fad90c`; no deployment or production availability is claimed.
Exact-candidate browser and release evidence remains pending.

## Restaurant checkpoint

- Implemented source remains present across onboarding, catalog/menu/OCR, POS/KDS, orders and
  settlement, tax, inventory/purchasing, workforce, SOP, loyalty, reports, devices, and cameras.
- Printing now has a durable job/routing/idempotency bridge and ESC/POS rendering, but its only
  adapter is simulation-only. It performs no physical printer, network, or operating-system I/O.
- Direct, connected Delivery is operational: Delivery publications, saved customer addresses,
  branch zones, frozen snapshots, PREPAID/COD kitchen handoff, settlement, daily close, Reports,
  and Insights are implemented. Offline, missing-customer, and capability-denied attempts are
  rejected before mutation. Marketplace providers and full driver logistics remain deferred.
- Offline order capture is under active correction. It is not claimed until the corrected work is
  composed and exact-head disconnect/reconnect acceptance passes.
- Card acquiring is provider-dependent. OPay New 9220 is a candidate device, not an integrated or
  accepted provider; simulation/local tender records do not prove authorization or settlement.
- Pakistan tax calculation/configuration source exists. Fiscal filing, fiscal-device certification,
  authority e-invoicing, and legal/accounting approval remain external.

## Pending release gates

- Exact-head Restaurant browser and build gates remain pending.
- Exact-head SuperAdmin/control-plane browser and build gates remain pending after Restaurant freezes.
- Exact-head Agency browser and build gates remain pending after SuperAdmin acceptance.
- Provider/hardware acceptance for card acquiring, printing, drawers, KDS devices, and cameras.
- Restricted-role PostgreSQL, migration, RLS, extension, deployment, and operating evidence required
  by release governance.

## Optional or deferred scope

- Marketplace APIs, live rider tracking, route optimization, physical hardware integrations, native
  mobile, reservations/waitlist, stored value, payroll execution, tip payout, production batches,
  and full driver logistics remain optional or deferred unless explicitly approved.
- Saad alone authorizes push, shared-ref merge, deployment, or production smoke.

Detailed decisions and implemented-module evidence remain in the
[Restaurant management system plan](industry-specific-docs/restaurants/restaurant-management-system-plan.md).
