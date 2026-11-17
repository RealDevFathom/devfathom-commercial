# Repository map

> Checked against `develop` at `1906b530`.

| Path | What's there |
|---|---|
| `src/app/(app)/` | Tenant pages: `pharmacy/`, `restaurant/`, `hotel/`, and agency/core areas (`dashboard`, `clients`, `projects`, `finance`, `team`, `hr`, `meetings`, `notes`, `chat`, `email`, `reviews`, `organization`, `settings`, `audit-logs`, `api-docs`). 140 pages in total. |
| `src/app/(terminal)/` | Restaurant POS and KDS terminals. |
| `src/app/platform/` | SuperAdmin console (`(console)/…`) and its login. |
| `src/app/api/` | 139 route handlers: `trpc`, `auth`, `login`, `sso`, `scim/v2`, `platform`, `pharmacy` (counter offline, cameras, print, prescription files, SOP evidence, WhatsApp), `restaurant`, `v1` (public REST), `cron`, `health`, `ready`, `live`, `assistant`, `upload`, `files`, `wallet`. |
| `src/app/supplier/po/[token]` | Tokenised supplier portal (no login). |
| `src/proxy.ts` | Host routing (platform host versus tenant hosts). |
| `src/server/trpc.ts` | Procedure builders, context, module and audit middleware. |
| `src/server/routers/` | 80 routers. Prefixes: `pharmacy-*` (22), `restaurant-*` (29), `hotel-*` (5), `platform-*` and `ai-settings`, and unprefixed core/agency routers. `_app.ts` mounts them. |
| `src/server/authz.ts`, `*-scope.ts` | Resource and branch scope helpers. |
| `src/lib/abac/` | Capability matching, policies, deny-wins `can()`, owner access. |
| `src/lib/vertical-catalog.ts` | Per-vertical modules, capabilities and **role templates**. |
| `src/lib/module-catalog.ts` | tRPC path → licensed module mapping. |
| `src/lib/tenancy/` | `scoped-db.ts` (`withTenantDb`, `withPlatformDb`), host parsing, support sessions, demo isolation. |
| `src/lib/pharmacy/` | Pharmacy domain logic (sales, controlled register, purchasing, receiving, SOP adapter, supplier compliance, pack-label OCR, finance …). |
| `src/lib/restaurant/` | Restaurant domain logic, including the shared SOP engine. |
| `src/lib/ai/` | AI provider routing, tiers, spend, tools. |
| `src/lib/platform/` | Console commands (`commands.ts`), read policy, platform auth. |
| `src/components/` | UI by area (`pharmacy/`, `restaurant/`, `platform/`, `layout/`, `camera/` …). |
| `prisma/schema.prisma` | 491 models, 271 enums. |
| `prisma/migrations/` | 211 migrations. RLS policies live **only** here. |
| `prisma/seed.ts`, `seed-demo.ts`, `seed-demo/`, `seeds/` | Seeds (see [migrations-and-seeds.md](migrations-and-seeds.md)). |
| `prisma/prepare-*.ts`, `fresh-database*.ts` | Database bootstrap: extensions, runtime role, fresh-database adapter. |
| `tests/` | Cross-cutting Vitest suites, DB suites, `tests/e2e` (Playwright, 40 specs). Most unit tests sit next to their source (`*.test.ts`). |
| `scripts/` | E2E runners, preflights, jobs, print bridge, demo data, RLS verifier. |
| `docker/` | `camera-snapshot-gateway/`, `livekit/`. |
| `infra/aws/` | AWS CloudFormation and CodeBuild files (owned by the CTO). Azure files elsewhere in `infra/` are **deprecated**. |
| `.github/workflows/` | `qa.yml`, `image-build.yml`, `deploy-develop.yml`, `deploy-staging.yml`, `promote-production.yml`. See [testing-and-ci.md](testing-and-ci.md). |
| `docs/` | Documentation. `docs/dev/` is this handbook; `docs/admin-platform/` is the platform handbook. |
| `industry-specific-docs/` | Vertical notes (cameras, restaurants). |
| `qa/`, `qa-evidence/` | QA reports and evidence. |
| Root `*.md` | `AGENTS.md` and `CLAUDE.md` (agent rules), `README.md`, `SECURITY.md`, plus working notes (`BUGS.md`, `FIXES.md`, `HANDOFF.md`, `status.md` …) that aren't maintained docs. |
