# DevFathom delivery status

Last reconciled: 2026-09-02 (PKT)

This is the single current delivery ledger. It records the locally assembled Restaurant source at
exact candidate `6cd73e4b5eb747b1d017d28ce6858d6606a7c6f9`. Source presence is not automated,
browser, release, deployment, or production proof. Those gates remain pending unless separately
accepted against this exact candidate; this ledger records no such acceptance.

## Restaurant source checkpoint

- Local source is assembled for onboarding, catalog/menu/OCR, POS/KDS, orders, settlement, direct
  Delivery, tax calculation/configuration, inventory/purchasing, workforce, SOP, loyalty, reports,
  devices, and cameras.
- Direct Delivery is limited to the connected first-party workflow. Marketplace providers, live
  rider tracking, route optimization, and full driver logistics are not integrated.
- Card tender remains an operator-confirmed mock/local record. OPay New 9220 is a candidate device,
  not an integrated or accepted acquiring provider. The source does not prove authorization,
  capture, settlement, tokenization, refunds, certification, or chargebacks with OPay or any live
  provider.
- Receipt and kitchen printing use durable routing, queued simulation jobs, idempotency, and ESC/POS
  rendering. The adapter is simulation-only: it does not communicate with physical or network
  printers, drawers, operating-system print services, or a managed printer fleet.
- In-app notification delivery has local source support. Email, SMS, push, and WhatsApp require an
  accepted external notification provider and operating evidence; no such provider integration is
  claimed here.
- Pakistan tax calculation and configuration source exists. Fiscal filing, fiscal-device
  certification, authority e-invoicing, and current legal/accounting approval remain external
  responsibilities.
- Physical hardware and provider acceptance remain outside source assembly, including card
  terminals, printers, drawers, KDS devices, cameras, OCR services, and notification transports.

## Evidence state and pending gates

| Gate                                                        | Current statement                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Local source assembly                                       | Exact candidate exists locally; this is repository evidence only.                                        |
| Automated verification                                      | Pending against the exact candidate. No pass count or acceptance is claimed.                             |
| Browser verification                                        | Pending against the exact candidate. Page load or source-file existence does not count as browser proof. |
| Fresh database, migration, RLS, and tenant/branch isolation | Pending exact-candidate acceptance evidence.                                                             |
| Build and release verification                              | Pending exact-candidate acceptance evidence.                                                             |
| SuperAdmin/control-plane and Agency regression              | Pending exact-candidate automated and browser evidence.                                                  |
| Provider, hardware, fiscal, and legal approval              | External acceptance and owner/provider/adviser evidence required.                                        |
| Deployment or production availability                       | Not claimed. No push, merge, deployment, production smoke, or release is evidenced here.                 |

Workflow labels such as accepted, browser-verified, released, or live may be added only when the
corresponding evidence is accepted for this exact candidate. Repository paths, source existence,
page loads, screenshots without assertions, and prior-SHA results are not substitutes.

## Deferred boundaries and authority

Marketplace APIs, live rider logistics, physical hardware integrations, native mobile,
reservations/waitlist, stored value, payroll execution, tip payout, and production/preparation
batches remain deferred unless separately approved.

Only Saad may authorize a push, shared-ref merge, deployment, production smoke, or release.

Operational instructions: [Restaurant administrator guide](docs/product/restaurant-administrator-guide.md).
Detailed design history: [Restaurant build assumptions](industry-specific-docs/restaurants/BUILD-ASSUMPTIONS.md).
