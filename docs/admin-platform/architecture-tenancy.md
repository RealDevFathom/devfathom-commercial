# Architecture, Tenancy, and RLS

## Current

The baseline is a single workspace application backed by Prisma/PostgreSQL. Authentication and authorization are application-layer concerns (`src/lib/auth.ts`, `src/server/trpc.ts`, `src/lib/authz.ts`, `src/server/authz.ts`). Baseline schema roles are not tenant roles (`prisma/schema.prisma:19-23`). No row-level-security policy or tenant request context is claimed by this documentation.

## Planned contract

Introduce `Agency` as the control-plane owner and `Organization` as the tenant boundary. Every tenant-owned table must carry a non-null `organization_id`; cross-tenant references are prohibited. Agency-global catalog/audit records remain explicitly non-tenant tables.

Request flow: resolve host → resolve organization → authenticate principal → derive membership and effective capabilities → set transaction-local DB context → query/mutate. PostgreSQL RLS must default deny and compare `organization_id` to a transaction-local setting. The application predicate is defense in depth, never the sole isolation control.

Required invariants:

- No request may select an organization from an untrusted header or body.
- A service role is restricted to migrations/background jobs and is never used for user requests.
- Foreign keys and unique indexes are organization-scoped where appropriate.
- Support impersonation requires a time-boxed grant, reason, audit event, and prominent session state.

## Verification evidence required

Two organizations with identical natural keys; direct SQL, REST, tRPC, background-job and export tests must demonstrate no cross-tenant read or write. Include RLS-enabled/forced checks and a migration rollback test.
