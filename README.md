<div align="center">

<img src="./public/favicon.svg" width="76" height="76" alt="DevFathom" />

# DevFathom

**Depth in everything we build.**

A multi-tenant point-of-sale and AI growth platform for businesses in Pakistan,
with dedicated verticals for **pharmacies**, **restaurants** and **hotels**, plus
a shared company workspace and a seller control plane.

</div>

---

## What DevFathom is

DevFathom runs many customer organizations (tenants) on one PostgreSQL database,
isolated with forced row-level security. Each organization enables the modules
and verticals it is licensed for. Around the vertical apps sits a general
workspace (projects, clients, finance, notes, meetings, chat, HR) and a
platform control desk used by DevFathom operators to onboard and run tenants.

## Verticals

### 💊 Pharmacy — `src/app/(app)/pharmacy`

- **Counter (POS)** — dispensing, drawer sessions, daily close, refunds, khata
  (customer credit) with limits, FEFO batch selection, fiscal documents and
  receipt numbering, offline command queue
- **Prescriptions & pharmacist queue** — patients, prescribers, Rx-gated sales,
  pharmacist review decisions, emergency-Rx follow-ups
- **Controlled register & regulatory** — controlled-drug register, custody
  records, recalls and quarantine, pharmacovigilance reports, DRAP data ingest
- **Medicines, substitution & pricing** — medicine catalog, pack prices, price
  change proposals, reference connectors
- **Inventory** — lots, counts, inter-branch transfers, receiving exceptions
- **Purchasing** — purchase orders with approvals, goods receipts, purchase
  returns, debit notes, central purchasing across branches
- **Finance** — bookkeeping, accounting periods, bank reconciliation
- **Customer orders, quotes, family accounts and loyalty**
- **Marketing** — segments, templates, campaigns with attribution, refill
  reminders, owner digests
- **Cameras** — branch camera gateways and evidence
- **Onboarding & migration** — opening stock/ledger, data migration batches,
  parallel-run comparison and cutover
- **Reports** and multi-branch assignment

### 🍽️ Restaurant — `src/app/(app)/restaurant`, `src/app/(terminal)`

- **POS and KDS terminals** — `/pos` and `/kds` terminal routes, registered
  devices, operator credentials, terminal sessions
- **Orders, bills & payments** — dine-in / takeaway orders, kitchen tickets,
  station routing, split bills, tenders, refunds, service charge policies
- **Floor** — floors, tables, server sections
- **Catalog & menus** — products, variants, modifiers, combos, allergens,
  price lists, branch menu publication and availability windows,
  **AI menu import**
- **Inventory & recipes** — ingredients, recipe versions, stock locations,
  batches, counts, transfers, low-stock rules
- **Purchasing** — suppliers, purchase orders, receipts, discrepancies
- **Money & tax** — drawer sessions, daily close, versioned tax profiles and
  rules with per-transaction snapshots
- **Delivery & catering** — delivery zones, customer addresses, catering quotes,
  approvals, capacity and deliveries
- **Promotions & loyalty** — versioned promotion rules with caps and audit
- **Staff & shifts** — job roles, capabilities, shifts, breaks, swaps
- **SOPs** — templates, assignments, evidence, verification and escalation
- **Notifications, integrations & webhooks**, printers and a local print bridge
- **Cameras**, **reports**, **insights** and **growth** recommendations

### 🏨 Hotel — `src/app/(app)/hotel` *(in progress)*

Currently setup/configuration only, under **Hotel settings**:

- **Property** profile and staff property assignments
- **Rooms** — room types, rooms, beds, room blocks and room status events
- **Meal plans**, **extras**
- **Function spaces** and space bookings
- **Guest journey** templates

Front-desk operations (reservations, check-in/out, folios) are not built yet.

## Platform features

- **Multi-tenant isolation** — one database, forced organization RLS; the app
  role must be `NOSUPERUSER NOBYPASSRLS` and production refuses a role that
  bypasses RLS. Verify with `bun run test:rls`. Branch/property scoping on top
  for multi-branch tenants.
- **Auth** — NextAuth v5, TOTP two-factor, SAML/OIDC SSO, SCIM provisioning,
  invitations and password policy.
- **Organization admin** — people, roles, modules, domains, identity, email
  and brand.
- **Platform control desk** (`/platform`) — organizations, CRM, commercial
  contracts and licenses, catalog, deployments, jobs, operators, support,
  health and audit, with its own MFA.
- **AI** — "Ask Fathom" assistant with tools, AI menu import, and growth
  recommendations. Provider is configurable (Groq, Google, Vertex, Azure).
- **Cameras** — gateway-based cameras with encrypted credentials and
  short-lived stream grants (pharmacy and restaurant).
- **Workspace** — dashboard, projects/Kanban (Trello import), clients, finance,
  notes, meetings, real-time chat (Ably), HR, reviews, REST API + API docs.

## Tech stack

| Area          | Choice                                          |
| ------------- | ----------------------------------------------- |
| Framework     | Next.js 16 (App Router) · React 19              |
| API           | tRPC v11 · TanStack Query                       |
| Data          | Prisma 7 · PostgreSQL (RLS)                     |
| Auth          | NextAuth v5 · TOTP · SAML/OIDC · SCIM           |
| Styling       | Tailwind CSS v4 · shadcn/ui on `@base-ui/react` |
| AI            | Vercel AI SDK                                   |
| Realtime      | Ably (optional)                                 |
| Runtime / PM  | Bun **1.4.2**                                   |
| Tests         | Vitest · Playwright                             |

## Local setup

Requires Bun 1.4.2 and PostgreSQL. Full details: [docs/LOCAL_SETUP.md](./docs/LOCAL_SETUP.md).

1. Copy `.env.example` to `.env` and fill in values. Minimum:
   `DATABASE_URL` (RLS-bound app role), `MIGRATION_DATABASE_URL`,
   `EXTENSION_ADMIN_DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`,
   `NEXT_PUBLIC_APP_URL`, `PLATFORM_BASE_DOMAIN`, `PLATFORM_ENCRYPTION_KEY`,
   `CAMERA_CREDENTIAL_KEY`. AI, email, storage and realtime keys are optional.
   Set `EXTENSION_ADMIN_DATABASE_URL` to the extension-owner/admin connection used
   by `prisma/prepare-extensions.ts`: an extension object owner, a superuser, or
   a role with explicit SET privilege on every extension object owner.
   Never commit `.env`.

   Before seeding, set `SEED_PASSWORD` (or `ADMIN_PASSWORD` as its fallback) for
   seeded tenant users. If `ADMIN_EMAIL` is set, as in the template,
   `ADMIN_PASSWORD` is also required for the separate workspace administrator.
   For control-desk access, set both `PLATFORM_ADMIN_EMAIL` and
   `PLATFORM_ADMIN_PASSWORD` before seeding; this creates or updates the platform
   administrator, including its password on each seed run. Leaving both unset
   skips that bootstrap; setting only one fails.
2. Install and prepare the database:

```bash
bun install
bun run db:generate
bun prisma/prepare-extensions.ts   # required before migrations
bunx prisma migrate deploy
bun run db:seed
bun run dev
```

`db:push` is intentionally disabled — use migrations.

Open `http://devfathom.localhost:3000` for the tenant workspace and
`http://admin.localhost:3000/platform` for the control desk.

## Testing

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test          # Vitest unit + DB tests
bun run test:rls      # tenant isolation (test DB only)
bun run test:e2e      # Playwright
bun run test:e2e:pharmacy-counter
bun run test:e2e:restaurant-integrated
```

Database tests need dedicated, migrated, disposable test databases; do not use
an application database. `test:rls` requires `TEST_DATABASE_URL` and never falls
back to `DATABASE_URL`. Use a local database with a role able to create and grant
roles for that verifier. Vitest DB suites have their own URL and role
requirements; some skip when these are missing, so a unit-test pass alone does
not establish database coverage.

**Zero-skip rule:** a PR must not add or leave skipped tests (`.skip`, `.todo`,
conditional skips). Fix or delete the test instead.

## Branch flow

```
feature branch → develop → staging → main
```

- All work branches from `develop` and opens PRs into `develop`.
- `staging` and `main` are promoted only with the owner's approval.

## Contributing

- Open PRs into `develop` only, one concern per PR, linked to its issue.
- Every PR needs a **QA PASS and a Security PASS on its latest commit**, plus
  green CI, before merge.
- CI on GitHub Actions runs once the **`ci-ready`** label is added.
- **No force-push.** No secrets in code, PRs, issues or chat.

## Security

Report vulnerabilities **privately** through
[GitHub private vulnerability reporting](https://github.com/RealDevFathom/devfathom-commercial/security/advisories/new)
— see [SECURITY.md](./SECURITY.md) for reporting guidance.
Do not open public issues for security problems.

## More docs

[Brand](./BRAND.md) · [Admin platform](./docs/admin-platform/README.md) ·
[Pharmacy](./docs/pharmacy) · [Restaurant](./docs/restaurant) ·
[Technical overview](./docs/technical-overview.md)
