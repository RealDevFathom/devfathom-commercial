# Support and SLA outline

## Current support substrate

- **IMPLEMENTED** — Platform support access uses separate authorization, reason, expiry, tenant launch, banner/action identity, audit, and suspension revocation controls. Evidence: [`docs/admin-platform/identity-access.md`](../admin-platform/identity-access.md), [`src/app/api/platform/support/route.ts`](../../src/app/api/platform/support/route.ts).
- **IMPLEMENTED** — Operational runbooks cover lifecycle/jobs and evidence handling; this does not create a contractual SLA. Evidence: [`docs/admin-platform/runbooks.md`](../admin-platform/runbooks.md), [`docs/admin-platform/operations.md`](../admin-platform/operations.md).

## Proposed policy schedule

- **PLANNED OWNER APPROVAL** — Support hours, channels, authorized contacts, severity definitions, acknowledgement/update/restore targets, escalation chain, maintenance notice, service credits, exclusions, dependency treatment, data-request handling, and incident communications.
- **PLANNED OWNER APPROVAL** — Normal versus enterprise coverage, named technical contact, onboarding/hypercare, and optional dedicated-environment operations.

Avoid uptime, response-time, recovery-time, 24/7, or service-credit promises until monitoring evidence, staffing model, dependency assumptions, and signed contract schedule exist.
