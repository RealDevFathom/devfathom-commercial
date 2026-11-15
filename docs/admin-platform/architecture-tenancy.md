# Architecture, Tenancy, and RLS

## Runtime architecture

DevFathom is a Next.js 16 App Router application on React 19. Server Components render the application and control plane; route handlers provide tRPC, REST, SCIM, SSO, support, and worker endpoints. Prisma 7 with the PostgreSQL adapter is the only database access layer.

The system has two security planes:

- **Control plane:** seller-operated platform routes, operator identities, commercial data, catalog, deployments, jobs, support sessions, settings, and platform audit.
- **Tenant plane:** one customer agency (`Organization`) and its users, work data, organization configuration, identity, domains, and tenant audit.

`ADMIN` in the tenant plane is not a platform operator. Platform identities use `PlatformRole` and a separate opaque session cookie.

## Host and actor resolution

`src/proxy.ts` normalizes the public host into `x-devfathom-host`, adds a request ID, keeps the admin host away from tenant pages, and keeps interactive platform APIs off tenant/dedicated hosts. It only performs optimistic cookie-presence routing. Server code revalidates every credential.

`classifyHost` in `src/lib/tenancy/host-routing.ts` sorts a host into one of four kinds:

- **platform** — `admin.<base domain>` (or `admin.localhost`);
- **shared** — the slug-free application host serving standard tenants: any of the
  reserved labels `www`, `app`, `api`, `staging` under the base domain, the base
  domain apex itself, or a host named in `SHARED_APP_HOSTS`;
- **tenant** — everything else that may carry an organization;
- **unknown** — an empty or unusable host.

The shared check runs BEFORE the base-domain suffix rule. Without that ordering
`www.devfathom.com` parses as `{ kind: 'tenant', slug: 'www' }`, and the
default-host fallback below then resolves it to `DEFAULT_ORGANIZATION_ID` — a
silent misrouting rather than an error. The reserved labels are also refused as
organization slugs at creation, so a customer slug can never shadow the control
plane or the shared application.

Tenant resolution in `src/lib/tenancy/host.ts` checks, in order:

1. organization slug on the configured base domain;
2. a verified `OrganizationDomain`;
3. a ready deployment URL, matched on the whole URL value;
4. the configured default organization on local/default hosts.

A shared host resolves to no organization at all, short-circuiting before step 4.
This matters because `AUTH_URL` and `NEXT_PUBLIC_APP_URL` must point at the shared
host for reset and invite links, and both feed `configuredDefaultHosts()`.

The host, credential organization, and requested organization must agree —
**except on the shared host, where there is no host organization to agree with**.
There, the organization comes from the authenticated session claim and the
lifecycle gate is applied explicitly, so a suspended workspace still returns 423.
Tenant, custom and dedicated hosts keep the 409 mismatch behaviour unchanged.
Body/query `organizationId` values still never establish tenant authority; the one
place a submitted id is accepted (shared-host workspace selection) validates it
against a server-side single-use intent.

The tenant actor resolver supports either:

- a valid Auth.js tenant session; or
- an active, audited platform support session.

Support identity takes precedence while its cookie is active so all actions remain
attributed to the platform operator — on tenant, custom and dedicated hosts. The
support cookie is domain-wide, so it is deliberately IGNORED on the shared host:
an operator with a live support session who opens the shared login would otherwise
be handed an impersonated actor for a workspace they never opened.

The resolver refuses to produce an actor at all for a session that is revoked,
deleted, deactivated or unverifiable, so every route handler built on it is closed
to such a session without having to remember the check.

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
8. support launch tickets;
9. lower-case user emails with a CHECK constraint;
10. pending login intents (control plane).

`scripts/verify-tenant-isolation.ts` introspects the database rather than relying on a hard-coded table list. It verifies forced RLS on every tenant table, same-natural-key coexistence, cross-tenant read/write denial, SSO state/ticket isolation, composite-reference rejection, control-table fail-closed behavior, and that a tenant scope can neither read nor write a pending login intent.

## Relational defense in depth

- Tenant natural keys use organization-scoped unique constraints. `users.email` is unique per organization and constrained to its lower-case form, so tenant-local identity is effectively case-insensitive without a second index.
- Cross-tenant relations use composite foreign keys where Prisma can model them.
- Additional composite SSO constraints are installed by SQL migration because the Prisma schema cannot express every required relationship cleanly.
- REST, tRPC, uploads, files, assistant tools, realtime token issuance, and jobs use scoped clients.
- UI filtering is presentation only; server entitlement and authorization checks are authoritative.

## Shared and dedicated topology

Both modes use the same application contract and PostgreSQL boundary.

- `SHARED`: a ready deployment record points to the shared base-domain application.
- `DEDICATED`: a contracted customer receives an isolated AWS environment. The current implementation remains **BLOCKED** pending topology and automation; no dedicated environment is verified.

A dedicated deployment resolves its organization through its recorded deployment URL. The code also injects `DEDICATED_ORGANIZATION_ID` as deployment metadata for future operational hardening, but host plus database resolution remains authoritative.

## Trust boundaries

```text
Browser
  ├─ admin host ── platform session ── control-plane transaction
  ├─ shared host (www / staging)
  │    ├─ credentials → discovery in platform scope (email predicate only)
  │    ├─ one-use, host-bound login intent (control plane, no session yet)
  │    └─ Auth.js tenant session carrying the SELECTED organization
  │         (support cookie ignored here; no host organization exists)
  └─ tenant/custom/dedicated host
       ├─ Auth.js tenant session (must match the host organization)
       ├─ one-use support launch → host-only support session
       ├─ enterprise SSO (OIDC/SAML; host-bound redirect URI and audience)
       ├─ SCIM bearer token
       └─ REST API bearer token
                         ↓
              tenant-scoped transaction
                         ↓
             PostgreSQL forced RLS
```

Two paths deliberately begin outside any tenant scope, and both are narrow by
construction: shared-host login discovery (one predicate — the normalized email —
and a hard field whitelist) and anonymous invite/reset token resolution (one
predicate — the token hash — returning only an organization id). Everything after
either of them runs in `withTenantDb`.

External boundaries include AWS, DNS, customer IdPs/directories, Blob storage, email providers, Ably, and optional AI providers. Their credentials are deployment configuration, never organization input.
