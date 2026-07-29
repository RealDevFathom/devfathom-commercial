# DevFathom Deployment Runbook

Last reviewed: 2026-07-29

This is the operator entry point for deploying DevFathom Hub. The supported production topology
is a Next.js 16 application on Vercel Fluid Compute, a managed PostgreSQL database, shared
deployment by default, and dedicated Vercel projects only for contracted enterprise customers.

The application is not a static site. Auth, Server Components, route handlers, cron jobs, database
access, SCIM, SSO, and support sessions require the default Node.js runtime.

## 1. Before deploying

Required access:

- the production Vercel team and linked project;
- a managed PostgreSQL database with backups and point-in-time recovery;
- control of the production base domain and wildcard DNS;
- a secure secret manager;
- an approved release commit.

Install the current Vercel CLI. The workstation currently has `58.0.0`; upgrade before deploying:

```bash
npm i -g vercel@latest
vercel --version
vercel login
vercel whoami
```

From the repository root, link the correct team/project. `.vercel/` is intentionally ignored and
must not be committed:

```bash
vercel link
vercel env ls production
```

Confirm the generated `.vercel/project.json` points to the intended production project before
running any mutation. Run `vercel pull --environment=production` only in a dedicated release/CI
workspace; do not overwrite the `.env.local` used by normal development.

## 2. Configure environments

Use `.env.example` as the complete variable inventory. Add values through the Vercel dashboard or
`vercel env add`; never commit a production `.env` file.

Minimum production runtime:

| Variable                  | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `DATABASE_URL`            | PostgreSQL runtime connection                      |
| `AUTH_SECRET`             | Auth.js signing/encryption secret                  |
| `AUTH_URL`                | Canonical default-tenant URL                       |
| `NEXT_PUBLIC_APP_URL`     | Canonical default-tenant URL exposed to the client |
| `PLATFORM_BASE_DOMAIN`    | Base domain used for admin and organization hosts  |
| `PLATFORM_ENCRYPTION_KEY` | Encrypts SSO, email, MFA, and support secrets      |
| `CRON_SECRET`             | Authorizes the platform job processor              |
| `DEFAULT_ORGANIZATION_ID` | Default organization on the canonical tenant host  |

Example host layout for `example.com`:

```text
AUTH_URL=https://devfathom.example.com
NEXT_PUBLIC_APP_URL=https://devfathom.example.com
PLATFORM_BASE_DOMAIN=example.com

Tenant:   https://devfathom.example.com
Admin:    https://admin.example.com/platform
Agencies: https://<organization-slug>.example.com
```

Generate secrets with a cryptographically secure generator. Never prefix a secret with
`NEXT_PUBLIC_`.

Optional integrations—Blob, email, realtime, OAuth, AI, meetings, and dedicated Vercel
provisioning—remain disabled until their variables in `.env.example` are configured and accepted
in staging.

Environment rules:

- Production, Preview, and Development use separate values.
- Preview deployments must not use the production database.
- Keep bootstrap passwords only for initialization, then remove or rotate them.
- `vercel env pull` replaces the target file; do not keep hand-written secrets in that file.

## 3. Prepare PostgreSQL

Before the first production migration:

1. Enable backups and point-in-time recovery.
2. Record the approved RPO/RTO.
3. Test a restore into an isolated database.
4. Confirm the production connection requires TLS.
5. Take a release backup if the database already contains data.

Apply migrations from a secure operator or CI environment where `DATABASE_URL` is injected:

```bash
bun install --frozen-lockfile
bunx prisma validate
bunx prisma migrate deploy
bunx prisma migrate status
```

Never run `prisma db push`. Row-level security, forced policies, composite tenant constraints, and
deferrable foreign keys are migration-only database controls.

Run the RLS verifier only against a disposable or explicitly approved test database:

```bash
TEST_DATABASE_URL='postgresql://test-database' bun run test:rls
```

Do not point `test:rls` at production.

### Initial data

`bun run db:seed` creates the internal DevFathom organization, module catalog, platform operator
when bootstrap credentials are present, and a large demo dataset. It is suitable for local,
rehearsal, or explicitly approved internal environments—not a clean customer production database.

Current limitation: the repository does not yet provide a zero-demo, end-to-end production
bootstrap command. `prisma/bootstrap.ts` only creates a tenant administrator after its
organization exists and does not create a platform operator. A fresh clean production launch is
blocked until the internal organization and first platform operator are created through an
approved bootstrap procedure. Do not improvise direct production SQL during deployment.

## 4. Run the release gates

From the exact commit being deployed:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bunx prisma validate
bun run build
git diff --check
```

For a release rehearsal, also apply every migration to a fresh database and run `test:rls`.

## 5. Deploy

The repository is already configured in `vercel.json` for the Singapore region and the
five-minute platform job cron.

Create a protected production-target deployment without moving the production domains:

```bash
DEPLOYMENT_URL=$(vercel deploy --prod --skip-domain)
vercel inspect "$DEPLOYMENT_URL" --wait
```

Verify the deployment through Vercel protection:

```bash
vercel curl /platform/login --deployment "$DEPLOYMENT_URL"
vercel curl /login --deployment "$DEPLOYMENT_URL"
```

After the database migration and release checks pass, promote the same artifact:

```bash
vercel promote "$DEPLOYMENT_URL"
```

For CI-controlled prebuilt deployment:

```bash
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```

Always use `--prebuilt` after `vercel build`; otherwise Vercel ignores the local build output.

## 6. Domains and cron

Attach these domains to the shared project:

- `admin.<PLATFORM_BASE_DOMAIN>`;
- the default tenant host, normally `devfathom.<PLATFORM_BASE_DOMAIN>`;
- `*.<PLATFORM_BASE_DOMAIN>` for manually activated shared organizations.

Follow the exact DNS records Vercel reports for the project. Do not mark an organization domain
verified until public DNS proves the expected verification record.

`vercel.json` invokes `/api/platform/jobs/process` every five minutes. With `CRON_SECRET`
configured, Vercel sends the required bearer credential. Confirm cron invocations in Vercel logs
and confirm jobs move from `QUEUED` to `SUCCEEDED` in `/platform/jobs`.

## 7. Post-deployment acceptance

Complete these checks before announcing production:

1. `https://admin.<base-domain>/platform` redirects an unauthenticated user to platform login.
2. Platform login succeeds; the first `SUPER_ADMIN` enrolls MFA.
3. The default tenant host resolves the intended organization and tenant login succeeds.
4. Platform dashboard, organizations, CRM, commercial, catalog, deployments, jobs, operators,
   audit, and settings render without client/server errors.
5. A shared provisioning job reaches `READY`.
6. Module disablement hides navigation and blocks direct route access.
7. Audit records show platform login and administrative mutations.
8. Enabled email, Blob, DNS, SSO, SCIM, realtime, and dedicated-provisioning integrations pass
   their staging acceptance checks.
9. Backups, restore evidence, retention policy, and incident contacts are current.

Inspect the release and recent runtime errors:

```bash
vercel inspect <production-url>
vercel logs <production-url> --level error --since 1h
```

## 8. Rollback

If a release fails:

1. Pause job processing if queued work could create external side effects.
2. Preserve job, audit, deployment, and provider identifiers.
3. Roll back the application:

   ```bash
   vercel rollback
   ```

4. Keep additive migrations in place and deploy code compatible with that schema.
5. Diagnose against a database clone.
6. Retry or cancel durable jobs only after external side effects are understood.

Never reverse a completed purge. Restore from an approved backup if policy permits.

## 9. Shared and dedicated customers

Deploy the shared application first. New agencies are created, provisioned, and manually
activated from the platform control plane.

Dedicated enterprise projects are created by the durable provisioning worker using the
`VERCEL_*` variables in `.env.example`. Test that automation in a restricted Vercel team before
selling it. Do not manually mark a dedicated deployment `READY` while Vercel reports it pending or
failed.

## Related documents

- [Administration platform status](admin-platform/STATUS.md)
- [Migration and rollout](admin-platform/migration-rollout.md)
- [Hybrid deployment and operations](admin-platform/operations.md)
- [Testing and release gates](admin-platform/testing-release.md)
- [Operator runbooks](admin-platform/runbooks.md)
- [Security threat model](admin-platform/security-threat-model.md)
