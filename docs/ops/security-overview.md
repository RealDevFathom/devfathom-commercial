# Security overview

> Checked against `origin/main` 6e425380 (`src/lib/tenancy`, `src/lib/abac`, `src/lib/vertical-catalog.ts`, `src/lib/platform`, the health routes and `infra/aws`) plus CTO facts dated 2026-10-22.
> Items marked `TODO(confirm)` are not verified.

**Audience:** security reviewers, the CTO, ops and engineers.
**Related:** [AWS staging](aws-staging.md) · [Environment variables](environment-variables.md) · [Runbook](runbook.md) · [Identity and access](../admin-platform/identity-access.md)

> **⚠️ Azure is DEPRECATED. Never deploy to Azure.**
> `.github/workflows/deploy-staging.yml` is Azure-only and manual-dispatch. **Never start it.** `promote-production.yml`, `infra/*.bicep`, `docs/azure-deployment.md`, `infra/deploy-staging.sh` and `infra/configure-github-oidc.sh` are legacy Azure material. They are kept, not deleted, and must not be run. The only live environment is AWS staging in `ap-southeast-1`.

---

## 1. Tenant isolation

Tenant data is separated at three layers.

1. **Postgres row-level security (RLS).**
   - Policies allow a row only when `app.is_platform_admin = 'true'` or its `organizationId` equals `NULLIF(current_setting('app.current_organization_id', true), '')`.
   - RLS and composite constraints exist **only in migrations**, which is why `db:push` is disabled. Examples: `20260728092000_row_level_security`, `20260818160000_restaurant_brands_catalog_menus`.
   - **Where the tenant ID is set:** `withTenantDb` in `src/lib/tenancy/scoped-db.ts` opens a transaction and sets `app.current_organization_id`, `app.current_user_id` and `app.is_platform_admin = 'false'` transaction-locally (`set_config(..., true)`), so nothing leaks between requests on a pooled connection.
   - **Missing or bad tenant ID:** a malformed organization ID throws before any query. If the setting is empty or unset, `NULLIF` turns it into NULL, so **no tenant rows are visible and writes fail the policy check**. It fails closed.
   - **Platform access:** `withPlatformDb` clears the tenant ID and sets `app.is_platform_admin = 'true'` for authorized control-plane work.
2. **A restricted runtime role.**
   - The running app's `DATABASE_URL` is the app login set up by `prisma/prepare-runtime-role.ts`: no create-database or create-role rights; grants cover connect, schema usage, read/write on tables and sequences (including future ones), and execution of the medicine-search similarity function.
   - The script validates the app URL's username and target and checks the provisioned role attributes. It connects as the admin, so success does not prove app-login authentication; verify that through the web task's health checks (see the [runbook](runbook.md#3-migrations)).
   - A production process refuses to start if the app role is `SUPERUSER`, `BYPASSRLS`, or a member of either kind of role. `/api/ready` checks the current role's two flags and reports `runtime_role_privileged`; it does not repeat the membership check.
3. **Branch scoping** inside each organization, in the server layer (for example `src/server/restaurant-branch-scope.ts` and pharmacy branch assignments).

**Tests:** RLS tests exist per milestone; `bun run test:rls` runs the tenant-isolation check on a disposable database; `qa.yml` runs RLS regressions against Postgres 16.

**Tables outside RLS:** `rate_limit_buckets` (migration `20261021120000_rate_limit_buckets`) deliberately has no RLS and is used without tenant context by `src/lib/rate-limit.ts`. Prisma's `_prisma_migrations` metadata table also has no tenant RLS. TODO(confirm): inventory all exceptions with a `pg_class` check (`relrowsecurity`) on a migrated database before claiming exhaustive RLS coverage.

## 2. Roles

### Tenant users
- `Role` enum: `ADMIN`, `EMPLOYEE`, `HR`. It feeds only the static policies in `src/lib/abac/policies.ts`.
- Finer control through ABAC: `OrganizationRole`, `RolePermission` and `UserPermissionOverride`. Engine: `can()` in `src/lib/abac/index.ts`.
- **Evaluation order today** (`src/lib/abac/index.ts:49-57`): per-user DENY → per-user ALLOW → role DENY → role ALLOW → static policies → deny. A per-user ALLOW beats a role DENY. This may change when `fix/abac-deny-precedence` lands. TODO(confirm) after that branch merges.
- Two-step sign-in (TOTP plus recovery codes) is available to tenant users and is off until each user enables it.

### Platform staff
- Separate `PlatformUser`, `PlatformSession` and `PlatformRole`. The first platform sign-in always enrols an authenticator.
- Capabilities per role (`src/lib/platform/capabilities.ts`):

| PlatformRole | Can |
|---|---|
| `SUPER_ADMIN` | Everything (`*`), plus organization security changes |
| `OPERATIONS` | Read and write organizations, deployments and jobs; open support sessions; read the catalog |
| `SALES` | Read organizations; read and write CRM and commercial; read the catalog |
| `FINANCE` | Read organizations; read and write commercial; read CRM and the catalog |
| `SUPPORT` | Read organizations, deployments and jobs; open support sessions; read the catalog |
| `AUDITOR` | Read-only across organizations, CRM, commercial, deployments, jobs and the catalog, plus the platform audit log |

### Support sessions (`src/lib/tenancy/support-session.ts`)
- Need the `support:write` platform capability (`SUPER_ADMIN`, `OPERATIONS`, `SUPPORT`).
- Need a written **reason of 10–500 characters**.
- Last **5–60 minutes** (default 30), then expire.
- Act as an active tenant **ADMIN** of that organization; refused if the organization has none.
- Start through a one-use launch token.
- Are written to `PlatformAuditLog`, and **every active tenant admin gets an in-app notification** with the staff member's name, the reason and the end time. The notification is created in the same transaction, so if it fails the session is not created.
- **No tenant consent** is needed before a session starts. TODO(confirm), policy question for Inky: should consent be required?

### Restaurant staff
`RestaurantJobRole` and capabilities, audited `StaffCapabilityGrant`, operator credentials, registered devices and co-authorization for sensitive actions.

### Audit
`AuditLog` covers tenant actions; `PlatformAuditLog` covers platform actions, including support sessions.

## 3. Pharmacy separation of duties

Three capabilities are **exact-grant-only** (`EXACT_GRANT_ONLY_ACTIONS`, `src/lib/abac/capabilities.ts`):

| Capability | Covers | Enforced in |
|---|---|---|
| `pharmacy:dispense` | Pharmacist decisions, substitution evidence, dispensing | `pharmacy-dispensing`, `pharmacy-prescriptions` |
| `pharmacy:safety` | Controlled-drugs register: view, corrections, register incidents, inspection packs, retention and legal holds | `pharmacy-safety` |
| `pharmacy:catalogue-review` | Confirm or reject regulated catalogue proposals | `pharmacy-medicine`, `pharmacy-staged-review` |

- **No default policy grants them.** Their static policies are `[]`, so no `Role`, including `ADMIN`, gets them.
- **Wildcards never grant them.** Neither `*` nor `pharmacy:*` ALLOWs any of the three. A wildcard **DENY** does revoke them.
- **Role templates grant them by exact name** (`PHARMACY_ROLE_TEMPLATES` in `src/lib/vertical-catalog.ts`, provisional): **Pharmacist** gets `dispense` and `catalogue-review`; **Owner / Operator** (optional, explicitly assigned) gets all three; **Owner** (`pharmacy:*`) and every other template get none.
- **One person may hold all three**, for example in a single-pharmacist shop.
- DENY handling follows the evaluation order in section 2 and is not final until `fix/abac-deny-precedence` lands.

## 4. Platform and infrastructure (AWS staging)

- `ap-southeast-1`; no production. See [AWS staging](aws-staging.md).
- **Network:** load balancer and Fargate tasks in public subnets; the tasks admit only the load balancer and have no NAT. The database is in private subnets with no internet route, reachable only from the tasks' security group.
- **Database:** RDS PostgreSQL 16, encrypted at rest, not public, `rds.force_ssl=1`. The app and `bun prisma/*.ts` scripts verify the server certificate against the bundled RDS CA. `prisma migrate deploy` encrypts but does not verify.
- **HTTP:** plain HTTP is never served; with a certificate, port 80 redirects to HTTPS (TLS 1.2 minimum).
- **Uploads:** private, versioned, TLS-only S3 bucket; the web task may only get, put, delete and list it.
- **Health:** the load balancer checks `/api/live`; `/api/ready` is the deploy-time check. Failure bodies carry a short reason code only, never error text.
- TODO(confirm): a review of the IAM roles for CodeBuild, ECS tasks and the jobs Lambda.

## 5. Secrets handling

**There is no CI secrets scan. Run gitleaks locally before every push**, for example `gitleaks detect --source .` from the repo root. TODO(confirm): an agreed gitleaks config file.

- **Staging secrets** live in AWS Secrets Manager under `devfathom/<env>/…`. They are generated by Secrets Manager at stack creation and never appear in a template, parameter or stack event. ECS injects them into the task definitions. The database passwords and the two encryption keys are kept if the stack is deleted. TODO(confirm): who has IAM read access to them.
- Docs-only PRs **still require a gitleaks run**. `image-build.yml` runs on every pull request, including docs-only changes; it builds without pushing or deploying. The separate `qa.yml` gate currently triggers on pushes to `restaurantv2`, pull requests targeting `integration/**`, or manual dispatch, rather than a docs-path exclusion.
- If gitleaks finds a secret: don't push; remove it from history, not just the latest file; tell the CTO so it is rotated. Assume any secret that reached a remote is compromised.
- Never commit `.env` or `.env.local`. Only `.env.example`, with placeholders.
- No secrets, connection strings, hostnames, AWS account IDs, ARNs or logins in docs, PRs, issues, chat or screenshots.
- Admin and seed script output can contain credentials. Never paste it anywhere.

## 6. Change review

- Policy (not branch protection): one CTO review on every PR, plus QA for code changes.
- Docs PRs go to `main` through a PR with CTO approval. They still need gitleaks and any CI checks triggered for that PR (see section 5).
- Branch prefixes in use: `fix/`, `improve/`, `release/`, `docs/`, `qa/`, `codex/`.
- Regulatory content (DRAP, controlled register) is labelled **"DRAFT – pending legal review"** until pharmacist or legal review, which is part of the lawyer sign-off before production.

## 7. Open items

- `fix/abac-deny-precedence` is unmerged. Update sections 2 and 3 when it lands.
- Inventory tables outside RLS with a `pg_class` check on a migrated database, distinguishing application tables from migration metadata (section 1).
- Policy question for Inky: should support sessions require tenant consent? Today they don't; admins are notified in the same transaction (section 2).
- IAM review and access to secrets (sections 4 and 5).
- `vercel.json` and the Vercel variables can probably be removed.
