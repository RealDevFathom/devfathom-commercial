# ADR-002: Separate Seller Control Plane

Status: Accepted and implemented, 2026-07-28.

## Context

Tenant `ADMIN` represents a customer-agency administrator. Selling, activation, contracts, modules, deployments, operator access, retention, and support require a higher-trust seller identity and must not be conflated with that tenant role.

## Decision

- Platform identities, roles, MFA, sessions, routes, APIs, audit, and navigation are separate.
- The control desk is served only from the admin host.
- Interactive platform APIs are rejected on tenant/dedicated hosts.
- Platform commands check role capability and write audit records.
- Customer administrators receive a bounded `/organization` surface.
- Tenant support uses time-boxed, reasoned, one-use audited support sessions rather than issuing tenant JWTs.
- Organization activation remains manual.

## Consequences

Benefits:

- clear seller/customer trust boundary;
- least-privilege sales/finance/ops/support roles;
- complete operational history;
- safer customer support and destructive lifecycle handling.

Costs:

- separate login/MFA/session lifecycle;
- admin host and public-origin configuration;
- duplicated but intentional platform/tenant concepts;
- operator training and policy required.

## Rejected alternatives

- Reusing tenant `ADMIN`: permits customer identities to reach seller operations and makes audit ambiguous.
- Permanent impersonation tokens: excessive replay and attribution risk.
- Self-service activation/billing: explicitly outside the current commercial model.

## Evidence

`src/app/platform/`, `src/lib/platform/`, `src/app/api/platform/`, `src/components/platform/`, tenant organization administration, and support-session routes/models.
