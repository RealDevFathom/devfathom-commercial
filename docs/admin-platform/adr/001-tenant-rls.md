# ADR-001: Shared PostgreSQL with Forced Tenant RLS

Status: Accepted and implemented, 2026-07-28.

## Context

DevFathom sells to multiple customer agencies. The selected commercial topology is shared by default with optional dedicated compute for enterprise customers, while using one PostgreSQL database.

Application predicates alone do not provide a sufficient isolation backstop. Database-per-tenant would add provisioning, migration, backup, analytics, and connection complexity that is not justified for the default product.

## Decision

- `Organization` is the tenant boundary.
- Every tenant-owned table carries non-null `organizationId`.
- User requests set transaction-local organization context.
- PostgreSQL row-level security is enabled and forced on every tenant table.
- Missing context fails closed.
- Platform access sets a separate transaction-local platform flag.
- Cross-tenant natural keys and references are organization-scoped.
- All source code uses a scoped database facade.
- Fresh-database adversarial RLS verification is a release gate.

Dedicated enterprise deployments use isolated compute/projects but retain the same database contract.

## Consequences

Benefits:

- database-enforced defense in depth;
- one migration/backup/analytics plane;
- consistent shared/dedicated behavior;
- explicit, testable platform bypass.

Costs:

- every query must run inside a scoped transaction;
- catalog/contract and tenant state sometimes require separate transactions;
- migrations must maintain RLS and composite integrity;
- workers need explicit platform scope;
- transaction-bound statements must be serialized on one PostgreSQL client.

## Rejected alternatives

- Application predicates only: insufficient defense against an omitted filter.
- Database per customer by default: excessive operational cost for the current product.
- Global service-role connection for requests: destroys the RLS boundary.

## Evidence

`src/lib/tenancy/scoped-db.ts`, RLS migrations, composite-integrity migrations, and `scripts/verify-tenant-isolation.ts`.
