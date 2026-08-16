# Architecture, Tenancy, and RLS

## Runtime architecture

DevFathom is a Next.js 16 App Router application on React 19. Server Components render the application and control plane; route handlers provide tRPC, REST, SCIM, SSO, support, and worker endpoints. Prisma 7 with the PostgreSQL adapter is the only database access layer.

The system has two security planes:

- **Control plane:** seller-operated platform routes, operator identities, commercial data, catalog, deployments, jobs, support sessions, settings, and platform audit.
- **Tenant plane:** one customer agency (`Organization`) and its users, work data, organization configuration, identity, domains, and tenant audit.

`ADMIN` in the tenant plane is not a platform operator. Platform identities use `PlatformRole` and a separate opaque session cookie.

## Host and actor resolution

`src/proxy.ts` normalizes the public host into `x-devfathom-host`, adds a request ID, keeps the admin host away from tenant pages, and keeps interactive platform APIs off tenant/dedicated hosts. It only performs optimistic cookie-presence routing. Server code revalidates every credential.

Tenant resolution in `src/lib/tenancy/host.ts` checks, in order:

1. organization slug on the configured base domain;
2. a verified `OrganizationDomain`;
3. a ready deployment URL;
4. the configured default organization on local/default hosts.

The host, credential organization, and requested organization must agree. Body/query `organizationId` values never establish tenant authority.

The tenant actor resolver supports either:

- a valid Auth.js tenant session; or
- an active, audited platform support session.

Support identity takes precedence while its cookie is active so all actions remain attributed to the platform operator.

## Database boundary

All application code reaches Prisma through:

- `withTenantDb(organizationId, callback)`;
- `createTenantDb(organizationId)` for request-safe operation-level transactions; or
- `withPlatformDb(callback)` for explicit control-plane access.

Each wrapper starts an interactive transaction and sets:

```sql
SELECT
  set_config('app.current_organization_id', '<organization>', true),
  set_config('app.is_platform_admin', 'false|true', true);
```

The settings are transaction-local. A pooled connection cannot retain a tenant or platform identity. Statements are serialized on each transaction-bound PostgreSQL client because one `pg.Client` cannot safely execute concurrent queries.

Only `src/lib/tenancy/scoped-db.ts` imports the raw Prisma singleton. This makes unscoped access easy to audit.

## RLS policy

Every table containing `organizationId` has row-level security enabled and forced. Tenant policies compare the row organization to `current_setting('app.current_organization_id', true)`. Control-plane-only tables require `app.is_platform_admin = 'true'`. Missing settings fail closed.

The migration sequence includes:

1. baseline schema;
2. platform tenancy;
3. tenant composite integrity;
4. forced RLS;
5. platform sessions/settings;
6. user email uniqueness;
7. SSO, MFA, and composite SSO integrity;
8. support launch tickets.

`scripts/verify-tenant-isolation.ts` introspects the database rather than relying on a hard-coded table list. It verifies forced RLS on every tenant table, same-natural-key coexistence, cross-tenant read/write denial, SSO state/ticket isolation, composite-reference rejection, and control-table fail-closed behavior.

## Relational defense in depth

- Tenant natural keys use organization-scoped unique constraints.
- Cross-tenant relations use composite foreign keys where Prisma can model them.
- Additional composite SSO constraints are installed by SQL migration because the Prisma schema cannot express every required relationship cleanly.
- REST, tRPC, uploads, files, assistant tools, realtime token issuance, and jobs use scoped clients.
- UI filtering is presentation only; server entitlement and authorization checks are authoritative.

## Shared and dedicated topology

Both modes use the same application contract and PostgreSQL boundary.

- `SHARED`: a ready deployment record points to the shared base-domain application.
- `DEDICATED`: a contracted customer receives an isolated Azure environment. The current implementation remains **BLOCKED** pending topology and automation; no dedicated environment is verified.

A dedicated deployment resolves its organization through its recorded deployment URL. The code also injects `DEDICATED_ORGANIZATION_ID` as deployment metadata for future operational hardening, but host plus database resolution remains authoritative.

## Trust boundaries

```text
Browser
  ├─ admin host ── platform session ── control-plane transaction
  └─ tenant/custom/dedicated host
       ├─ Auth.js tenant session
       ├─ one-use support launch → host-only support session
       ├─ SCIM bearer token
       └─ REST API bearer token
                         ↓
              tenant-scoped transaction
                         ↓
             PostgreSQL forced RLS
```

External boundaries include Azure, DNS, customer IdPs/directories, Blob storage, email providers, Ably, and optional AI providers. Their credentials are deployment configuration, never organization input.
