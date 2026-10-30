# Staging runbook

> Day-to-day operations for **AWS staging** (`ap-southeast-1`). There is no production yet.
> Exact commands are in [`docs/deploy/aws.md`](../deploy/aws.md). Steps marked `TODO(confirm)` are unverified; ask the CTO or Inky before running them.

**Audience:** ops and engineers with staging access.
**Related:** [AWS staging](aws-staging.md) · [Environment variables](environment-variables.md) · [Security overview](security-overview.md)

**Never:**
- deploy to Azure, or start `.github/workflows/deploy-staging.yml` (Azure-only, DEPRECATED);
- put logins, passwords, hostnames, account IDs or ARNs in docs, PRs or chat;
- run `db:push` (it is deliberately disabled; see section 3).

---

## 1. Wake staging

Staging is **idle by default**: the web service runs zero tasks.

1. **Ask Inky before waking staging**, including for screenshots.
2. Update the environment stack with `DesiredCount=1`, keeping every other parameter. TODO(confirm): console or CLI, and who holds the AWS access.
3. RDS is not stopped while idle, so there is nothing to start.
4. Wait for the task to pass the load balancer check (`/api/live`), then run the [health checks](#5-health-checks).

## 2. Idle staging

1. Tell the people using staging (Inky first) that it is going idle.
2. Update the environment stack with `DesiredCount=0`, keeping every other parameter.
3. RDS keeps running; the template has no stop step. TODO(confirm): whether RDS should also be stopped by hand to save cost.

If staging goes down unexpectedly, check for a Spot interruption before treating it as an app fault.

## 3. Migrations

Migrations run in the **migration ECS task** during each staging deploy, not inside CodeBuild:

1. `bun prisma/prepare-extensions.ts`
2. `bunx prisma migrate deploy`
3. `bun prisma/prepare-runtime-role.ts`
4. `bun prisma/sync-catalog.ts`
5. then `MigrationMode` (staging: `seed`)

The web service is rolled only after this task exits 0. See [AWS staging § Deploy pipeline](aws-staging.md#deploy-pipeline).

- **Never use `db:push`.** It is disabled because RLS policies and composite constraints exist only in migrations.
- New migrations come in through a normal code PR (CTO review plus QA).
- RLS migrations to use as examples: `20260728092000_row_level_security`, `20260818160000_restaurant_brands_catalog_menus`.
- **If `prepare-runtime-role` fails**, check its failing step: URL validation, admin connectivity, role changes, grants or final role attributes. Check that `APP_DATABASE_URL` names the app login, is on the same server and database as `DATABASE_URL`, and that the login has no extra powers. The script does not test app-login authentication; verify that separately through the web task's health checks. Do not work around the failure by granting more privileges.
- **One-off queries:** there is no database access from the internet. Run a task from the migration task definition with a command override (see `docs/deploy/aws.md`). TODO(confirm): who may do this.

## 4. Seeds and admin scripts

| Script | What it does |
|---|---|
| `prisma/seed.ts` (`bun run db:seed`) | Local or staging organization, platform operator, modules, users and demo data |
| `scripts/seed-staging-demo.ts` | Staging `seed` mode: refuses unless it is really pointed at staging, then runs `prisma/seed.ts` and seeds the `pharmacy-counter-e2e` pharmacy tenant and a restaurant demo seat |
| `prisma/seed-demo/restaurant.ts` (`bun run demo:seed`) | Restaurant demo data |
| `scripts/seed-pharmacy-demo.ts` | Pharmacy demo data |
| `scripts/seed-pharmacy-e2e.ts` / `scripts/seed-agency-e2e.ts` | E2E fixtures |
| `prisma/platform-admin.ts`, `prisma/staging-admin.ts`, `prisma/create-admin.ts`, `prisma/reset-admin-password.ts` | Admin account tooling. TODO(confirm): arguments and when to use each |

Fresh-database bootstrap: `prisma/FRESH_DATABASE_ADAPTER.md` and the root `FRESH_DB_HANDOFF.md`.

Rules:
- Run seeds and admin scripts only against local or staging databases. On staging, seeds run through the migration task in `seed` mode.
- Admin and seed scripts handle credentials. **Never copy their output into docs, PRs, tickets or chat.** The staging login sheet is kept in a restricted file outside the repo, never in chat. TODO(confirm): the approved hand-over channel.
- For screenshots, use the `pharmacy-counter-e2e` org and the demo admin. Never show a login in the image.

## 5. Health checks

| Endpoint | What it checks | Healthy | Unhealthy |
|---|---|---|---|
| `GET /api/live` | Process is up. Reads nothing. **Used by the load balancer**, so ECS replaces tasks that fail it. | 200 `{"status":"ok"}` | no answer |
| `GET /api/health` | A database connection opens (`SELECT 1`) | 200 `{"status":"ok"}` | 503 `{"status":"unhealthy","reason":"database_unavailable"}` |
| `GET /api/ready` | Deploy-time readiness: checks the current role's `SUPERUSER`/`BYPASSRLS` flags, unfinished migration records, and one generated-client query selecting `organizations.vertical`. Probe timeout is 2 s. | 200 `{"status":"ok","schema":"current"}` | 503 `{"status":"unavailable","reason":…}` with `runtime_role_privileged`, `migrations_pending`, `schema_drift`, `timeout` or `database_unavailable` |

- Run `/api/health` and `/api/ready` after every wake and every deploy.
- A 200 from `/api/ready` does not prove all migrations were applied or that the whole schema matches. A migration that never started has no unfinished record, and drift outside the sampled query can go undetected. Verify the migration task exited 0 before rolling the web service.
- Platform staff also see platform health in `/platform` (the `platform-health` router).

## 6. Quick triage

| Symptom | First checks |
|---|---|
| Tasks keep restarting | `/api/live` failing: was there a Spot interruption? Is the image digest the expected one? |
| `/api/health` 503 | Is RDS available? Is the app's database secret correct? |
| `/api/ready` 503 `migrations_pending` / `schema_drift` | Did the migration task run and exit 0 before the roll? |
| `/api/ready` 503 `runtime_role_privileged` | The app is connecting as a privileged role. Stop and fix `DATABASE_URL` for the web service. |
| Deploy fails at prepare-runtime-role | Check `APP_DATABASE_URL` and the role's privileges (section 3). |
| A tenant sees another tenant's data | **Stop and escalate to the CTO immediately.** Treat it as a security incident (see the [Security overview](security-overview.md)). |

- **Logs:** CloudWatch log groups `/devfathom/<env>/web` and `/devfathom/<env>/migrate` (kept 7 days on staging), plus the jobs Lambda's log group.
- TODO(confirm): on-call and escalation contacts.
