# Architecture overview

> Checked against `develop` at `1906b530` (7 Nov 2026). Related: [repo map](repo-map.md) · [auth and permissions](auth-and-permissions.md) · [data model](data-model.md)

DevFathom is **one multi-tenant Next.js application**. It serves four business verticals and one platform control plane from a single codebase, a single tRPC API and a single PostgreSQL database:

| Vertical (`Organization.vertical`) | Status |
|---|---|
| `PHARMACY` | Main product. Punjab first. One live customer on production since 23 Oct 2026. |
| `RESTAURANT` | Built; demo tenants. |
| `AGENCY` | Built (the original "agency core": clients, projects, finance, team). |
| `HOSPITALITY` (hotel) | Foundations only (properties, rooms, rates, function spaces). Hotel building is paused. |
| Platform / SuperAdmin | A separate console at `src/app/platform/(console)` with its own login. |

## Stack

| Layer | Technology (from `package.json`) |
|---|---|
| Runtime / package manager | Bun 1.4.2 (`packageManager`); Node ≥ 22.20 for tooling |
| Web | Next.js 16.4.2 (App Router), React 19.2.7, Tailwind 4 |
| API | tRPC 11, Zod 4 |
| Database | PostgreSQL with Prisma 7 (`prisma-client` generator) |
| Auth | next-auth 5 (beta) for tenants; a separate session for the platform console |
| AI | Vercel AI SDK with Anthropic, OpenAI and Amazon Bedrock adapters (Azure adapter present as a legacy, explicit-only path) |
| Realtime / meetings | Ably (optional), LiveKit (optional) |
| Tests | Vitest 5, Playwright 1.64 |

## Request flow

```
Browser / pharmacy counter / restaurant POS and KDS
        │
        ▼
src/proxy.ts  ── host routing: admin host = platform console, {slug}.<base domain> = tenant
        │
        ▼
Next.js App Router (src/app)
  ├─ (app)/…           tenant workspace (pharmacy, restaurant, hotel, agency core)
  ├─ (terminal)/…      restaurant POS and KDS
  ├─ platform/…        SuperAdmin console
  └─ api/*             route handlers (trpc, auth, platform, pharmacy, restaurant, v1, cron, health …)
        │
        ▼
tRPC (src/server/trpc.ts)
  procedure builders: publicProcedure, protectedProcedure, auditedProtectedProcedure,
  adminProcedure, capabilityProcedure(action), denyByDefaultProcedure (capabilities in meta)
  + module entitlement check (src/lib/module-catalog.ts) + audit
        │
        ▼
80 routers in src/server/routers (mounted in _app.ts)
        │
        ▼
Tenant-scoped Prisma: withTenantDb / createTenantDb (src/lib/tenancy/scoped-db.ts)
  sets app.current_organization_id per transaction; platform work uses withPlatformDb
        │
        ▼
PostgreSQL with FORCE ROW LEVEL SECURITY (policies live in migrations only)
```

## Tenancy

1. **Every tenant is an `Organization`.** Tenant tables carry `organizationId`.
2. **Row-level security in the database.** Policies filter on `current_setting('app.current_organization_id')`, set transaction-locally by `withTenantDb`. Tables use `FORCE ROW LEVEL SECURITY`, so even the table owner is filtered. The baseline is migration `20260728092000_row_level_security`, plus follow-ons.
3. **A non-owner runtime role.** The app connects as a restricted role (`prisma/prepare-runtime-role.ts`). Migrations run with a separate migration URL. A production process refuses to start as a superuser or with `BYPASSRLS`.
4. **Branch scope inside a tenant.** Pharmacy uses `PharmacyBranchAssignment` (helpers in `src/lib/pharmacy/branch-scope.ts`, `src/server/pharmacy-procurement-scope.ts`, and the inventory router's `admittedScopeFor`). Restaurant uses `src/server/restaurant-branch-scope.ts`. Hotel uses `src/server/hotel-property-scope.ts`.
5. **Modules (entitlements).** Each tRPC path maps to a module in `src/lib/module-catalog.ts`. A tenant without that module gets refused before the procedure runs.

**Caution:** cross-tenant isolation has never been tested end to end with two real tenants. `bun run test:rls` checks the policies on a migrated database; see [testing-and-ci.md](testing-and-ci.md).

## Background work

- **Platform jobs** (`PlatformJob`, `scripts/process-platform-jobs.ts`, `/api/platform/jobs/process`): provisioning, domains, exports, camera snapshots and retention, and pharmacy procedure auto-scheduling (an hourly parent job that fans out per-branch child jobs).
- **Outbound effects** (`OutboundEffect`, `/api/cron/outbound-effects`): a per-tenant outbox drain. TODO(confirm): what schedules it outside `vercel.json`.
- **Restaurant jobs** (`scripts/run-restaurant-jobs.ts`) and the restaurant print bridge (`scripts/print-bridge.ts`).

## AI (Ask Fathom and AI features)

`src/lib/ai/`. **AI is off unless `AI_PROVIDER` is set**, and production defaults to disabled. With `AI_PROVIDER=auto`, `router.ts` tries Anthropic, then OpenAI, then Bedrock, failing over on availability errors only, with a circuit breaker. The model tier for each call (cheap, standard or deep) comes from `tiers.ts` and `workload.ts`. Per-provider monthly caps and prices are in `model-defaults.ts` and `spend.ts`, and SuperAdmins can change them through the `ai-settings` router. AI writes are recorded as `AIAssistantAction` and run once, after the user confirms. Every figure in an answer must come from a tool. **Do not add Azure to the routed chain.** Saad ordered Azure removed from all code on 10 Nov 2026. The removal is planned for the next Codex batch and tracked as Linear [DEV-755](https://linear.app/devfathom/issue/DEV-755/remove-azure-from-the-codebase-entirely) and GitHub [#1437](https://github.com/RealDevFathom/devfathom-commercial/issues/1437).

## Cameras

The shared camera code is in `src/lib/cameras/`. Restaurant and pharmacy both use an owner-run MediaMTX gateway. Live view goes through `/api/<vertical>/cameras/[cameraId]/stream`, which re-checks every request. Evidence stills come from `docker/camera-snapshot-gateway`. **No camera hardware has passed acceptance yet.** See `docs/pharmacy/hardware-acceptance-matrix.md`.
