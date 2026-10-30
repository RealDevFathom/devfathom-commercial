# Architecture

> **Audience:** engineers and coding agents.
> **Based on:** `origin/main` @ `16a2a370` (2026-10-22).
> Related: [onboarding.md](./onboarding.md) · [auth-and-roles.md](./auth-and-roles.md) · [testing.md](./testing.md)

DevFathom is a single multi-tenant Next.js application. It serves three business verticals (**pharmacy**, the main MVP target, plus **restaurant** and **agency**) and a **platform / SuperAdmin** control plane. All of them share one codebase, one tRPC API and one PostgreSQL database. Tenants are kept apart by Row-Level Security.

---

## Stack

| Layer | Technology (version from `package.json`) |
|---|---|
| Runtime and package manager | Bun 1.4.2 |
| Web framework | Next.js 16.4.2 (App Router), React 19.2.7 |
| API | tRPC server ^11.16, Zod ^4.3.6 for input validation |
| ORM and database | Prisma ^7.9.1 (`prisma-client` generator) on PostgreSQL |
| Auth | next-auth 5.0.0-beta.32 |
| Styling | Tailwind ^4 |
| Language | TypeScript ^5 |
| Realtime | Ably (token endpoint at `api/ably-token`) |
| Tests | Vitest 4.1.10, Playwright 1.62.0 |
| Lint | ESLint 9 |

## Request flow

```
Browser / POS / KDS terminal
        │
        ▼
Next.js App Router (src/app)
  ├─ (app)/…           tenant UI pages
  ├─ (terminal)/…      restaurant POS and KDS
  ├─ (public)/wallet   wallet passes
  └─ api/*             route handlers (auth, sso, scim, platform, cron, health, ready, trpc, v1, …)
        │
        ▼
tRPC (src/server/trpc.ts) ── capabilityProcedure → ABAC can() (src/lib/abac/*)
        │                        └─ resource helpers (src/server/authz.ts), audit, branch scoping
        ▼
~70 routers (src/server/routers, root _app.ts)
        │
        ▼
Tenant-scoped Prisma (src/lib/tenancy/scoped-db.ts)
        │   connects as the app role; set_config('app.current_organization_id', …, true) per transaction
        ▼
PostgreSQL ── RLS policies (defined in migrations only)
```

`app.current_organization_id` is set transaction-locally in `src/lib/tenancy/scoped-db.ts`. TODO(confirm): how branch scoping composes with it.

## Repository map

| Path | Contents |
|---|---|
| `src/app/(app)/` | Tenant UI: `pharmacy`, `restaurant`, `hotel` (out of scope), and the agency/core areas `dashboard`, `clients`, `projects`, `finance`, `team`, `hr`, `meetings`, `notes`, `chat`, `email`, `reviews`, `organization`, `settings`, `audit-logs`, `api-docs` |
| `src/app/(terminal)/` | Restaurant terminals: `pos`, `kds` |
| `src/app/(public)/wallet` | Public wallet passes |
| `src/app/api/` | Route handlers, including `auth`, `login`, `sso`, `scim`, `platform`, `pharmacy`, `restaurant`, `cron`, `health`, `ready`, `trpc`, `v1`, `assistant`, `files`, `upload`, `live`, `ably-token`, `support-session`, `wallet` |
| `src/server/` | `trpc.ts`, `authz.ts`, `audit.ts`, restaurant branch scoping, `routers/` |
| `src/lib/` | Domain logic, e.g. `abac/`, `tenancy/scoped-db.ts`, `vertical-catalog.ts`, `pharmacy/` |
| `src/generated/prisma/` | Generated Prisma client. Do not edit. |
| `prisma/` | `schema.prisma` (478 models), 164 migrations, `seed.ts`, `seed-demo/`, `seeds/`, DB bootstrap and RLS role scripts, admin scripts |
| `tests/` | Vitest tests, Python `aws-*_test.py` checks, and `tests/e2e` for Playwright |
| `qa/` | QA artefacts |
| `scripts/` | Seeds, E2E runners, jobs, print bridge, tenant-isolation check |
| `infra/aws/` | AWS staging infrastructure: CloudFormation (`shared`, `environment`, `certificate`, `dns`) plus CodeBuild `buildspec.yml`. Matches `infra/aws` as of 2026-10-22; see PR 5 docs. |
| `infra/*.bicep`, `infra/*.bicepparam`, Azure shell scripts in `infra/` | **DEPRECATED – never deploy to Azure** |
| `.github/workflows/` | CI. See [contributing.md](./contributing.md#ci). |
| `Dockerfile`, `Dockerfile.aws`, `docker/` | Container builds |
| `docs/`, `industry-specific-docs/restaurants` | Documentation (being reorganised) |
| Root `*.md` | `AGENTS.md`, `CLAUDE.md` (kept), plus working notes. BUGS, FIXES, TICKETS, RESUME and status are proposed to move to `docs/archive/`. |

`vercel.json` also exists. Its status is unverified (TODO(confirm)), so do not rely on it.

## Verticals and modules

| Vertical | Modules |
|---|---|
| **Pharmacy** (MVP focus) | Counter/POS and daily close, inventory, purchasing, medicines catalogue and staged review, prescriptions, pharmacist queue, controlled register, regulatory/recalls (DRAP ingest), reports, finance, marketing/growth, offline, onboarding/migration, supplier links, cameras, ordering |
| **Restaurant** | Floor, orders, POS/KDS terminals, menus/catalog, bills/payments/cash, tax, staff/shifts/SOP, inventory/purchasing, customers/loyalty/wallet/promotions, catering/delivery, insights/growth, notifications/webhooks, print bridge, menu import (OCR) |
| **Agency** | Dashboard, clients, projects/boards (Trello import), finance/invoices, team/HR/leave/reviews/resignations, meetings, notes, chat, email |
| **Platform / SuperAdmin** | `/platform`: organizations, operators, catalog, commercial, audit, health |
| Hotel | In schema and routers but **out of scope**. Not documented. |

## tRPC router map

All routers live in `src/server/routers` and are mounted in `_app.ts`.

**Pharmacy:** branch-assignments, cameras, dispensing, finance, inventory, marketing, medicine, offline, onboarding, ordering, prescriptions, purchasing, reports, safety, sales, staged-review, supplier-links.

**Restaurant:** bills, branches, cameras, cash, catalog, catering, customers, dashboard, delivery, devices, floor, growth, insights, inventory, jobs, loyalty, menu-import, menus, notifications, orders, payments, promotions, purchasing, reports, shifts, sop, sop-execution, staff, tax.

**Core / agency:** api-tokens, audit, chat, clients, dashboard, email, finance, invitations, meetings, notes, organization-admin, password-reset, platform-health, projects, resignations, reviews, search, team, team-stats, trello-import, two-factor, webhooks.

*(Hotel routers exist but are out of scope.)*

Files are named `<vertical>-<name>.ts`, e.g. `pharmacy-dispensing.ts`, `restaurant-orders.ts`. Core routers have no prefix.

## Data model (Prisma, 478 models)

- **Platform and tenancy:** `Organization*`, `PlatformUser` / `PlatformSession` / `PlatformRole`, `PlatformModule` / `PlatformPackage`, `OrganizationModule` / `Limit` / `Role` / `RolePermission`, `UserPermissionOverride`, SSO/SCIM, commercial CRM (`PlatformAccount`, `Lead`, `Opportunity`, `Contract`, `Invoice`), `PlatformJob`, `PlatformAuditLog`, `OutboundEffect`, `RateLimitBucket`.
- **Agency core:** `User`, `Client`, `Project`, `Board`, `Task`, `TimeEntry`, `Invoice`, `Payment`, `Channel`, `Message`, `Meeting*`, `Note*`, `LeaveRequest`, `Review`, `Webhook`, `ApiToken`, `AuditLog`.
- **Pharmacy (~200 models):** branches; medicine catalogue (Ingredient, Presentation, PackLevel, MRP, Barcode, ReviewDecision, PublicationBatch); sales/tenders/refunds/drawer/close; khata/family/loyalty; prescriptions/patients/prescribers; pharmacist review; controlled register; recalls/DRAP; lots/stock/counts/transfers; purchasing (requisition → quote → PO → GRN → returns/supplier credit); migration/cutover; offline devices; fiscal docs; bookkeeping/settlement/reconciliation; tax; and more.
- **Restaurant (~200 models):** branches, staff/devices/terminal sessions, catalog/modifiers/combos/recipes/allergens, menus, floor/tables, orders/KDS/print routing, bills/payments/close, stock/purchasing, SOP, job roles/capabilities, loyalty/wallet, catering, delivery, promotions, shifts, insights, menu import, tax, cameras, growth.

## Multi-tenancy and RLS

Each tenant is an **Organization**. Isolation is enforced **in the database**, not only in application code:

1. **Postgres Row-Level Security.** Policies filter rows by `current_setting('app.current_organization_id')`.
2. **A dedicated runtime role.** The app connects as a non-owner role (set up by the prepare-runtime-role script), so RLS applies to it. Migrations and seeds run as a separate migration role (`MIGRATION_DATABASE_URL`). A production process refuses to start if the app role is `SUPERUSER` or `BYPASSRLS`.
3. **Branch scoping** inside an organization (pharmacy and restaurant branches), applied in the server layer (e.g. `src/server/restaurant-branch-scope.ts`, `pharmacy-branch-assignments`).

**Consequences for developers:**

- RLS policies and composite constraints exist **only in migrations**. This is why `db:push` is disabled (see [onboarding.md](./onboarding.md#3-database-migrations-not-dbpush)).
- Every new tenant-scoped table needs an RLS policy in its migration, plus RLS test coverage.
- `bun run test:rls` (`scripts/verify-tenant-isolation.ts`) checks a disposable, migrated and seeded database. Its `TEST_DATABASE_URL` needs setup privileges to create and grant roles and `SET ROLE`; the script creates its own restricted role for the probes. See [testing.md](./testing.md).

## Cross-cutting concerns

- **Authorization:** `src/server/authz.ts` plus ABAC in `src/lib/abac/`. See [auth-and-roles.md](./auth-and-roles.md).
- **Audit:** tenant `AuditLog` and `PlatformAuditLog`. Restaurant capability grants are audited.
- **Background work:** `PlatformJob`, `OutboundEffect`, and the `platform:jobs` / `restaurant:jobs` scripts, plus `api/cron`. TODO(confirm): how jobs run in staging. Ops docs come in PR 5.
- **Health:** `api/health` and `api/ready`.
- **Live updates:** Ably.

## Deployment (summary only)

- **Staging** runs on AWS in `ap-southeast-1` (`infra/aws/`, `Dockerfile.aws`). Details will be documented in PR 5, **only after CTO verification**.
- There is **no production environment yet**.
- **Azure is DEPRECATED – never deploy to Azure.** The Azure material is kept but not used.
