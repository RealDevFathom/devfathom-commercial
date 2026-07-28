# Platform Status Ledger

Last reviewed: 2026-07-28. Owner: implementation team.

| Phase                    | State       | Evidence / exit criterion                                           |
| ------------------------ | ----------- | ------------------------------------------------------------------- |
| Baseline application     | Current     | Existing app, schema, REST spec, tRPC and session auth are present. |
| Documentation foundation | Implemented | This directory; no product behavior implied.                        |
| Tenant boundary          | Planned     | Organization model, request context, DB policy and isolation tests. |
| Agency control plane     | Planned     | Agency/admin routes, immutable audit, support guardrails.           |
| Plans and entitlements   | Planned     | Catalog, grants, usage metering and enforcement.                    |
| Commercial ledger        | Planned     | Quotes, subscriptions, invoices/payments and reconciliation.        |
| Enterprise identity      | Planned     | OIDC, SAML JIT and SCIM endpoints with tests.                       |
| White-label deployment   | Planned     | Domain verification, branding and email sender flow.                |
| Hybrid operations        | Planned     | Deployment topology, health, backup/restore and incident drills.    |
| Migration and rollout    | Planned     | Backfill, shadow validation, tenant pilot and rollback.             |

## Current-state evidence

- `prisma/schema.prisma` defines application entities and `Role` values `ADMIN`, `EMPLOYEE`, and `HR`; it does not define an organization/tenant entity in the baseline inspected here.
- `src/server/trpc.ts` creates session-backed procedures and capability checks; `src/lib/authz.ts` includes resource access helpers.
- `src/lib/api-auth.ts` authenticates scoped API tokens, and `src/app/api/v1/spec/route.ts` exposes an in-product API specification.
- `DEPLOY-NOTES.md` records historically deployment-gated Blob and observability work; treat it as project history, not proof of current deployment configuration.

## Verification log

No end-to-end platform verification has been recorded in this document yet. Add entries as `date | environment | command/scenario | result | owner`.
