# Setup, Migration, and Rollout

## Local setup

1. Install Bun/Node and PostgreSQL.
2. Copy `.env.example` to an ignored local environment file.
3. Create application and shadow databases.
4. Set strong local values for `AUTH_SECRET`, `PLATFORM_ENCRYPTION_KEY`, bootstrap passwords, and `CRON_SECRET`.
5. Install dependencies.
6. Apply migrations and seed.
7. Start the application.

```bash
bun install
bunx prisma migrate deploy
bun run db:seed
bun run dev
```

Open:

- tenant: `http://devfathom.localhost:3000`;
- platform: `http://admin.localhost:3000/platform`.

## Migration history

| Migration                                   | Purpose                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `20260728000000_baseline`                   | complete current schema baseline                    |
| `20260728090000_admin_platform_tenancy`     | organization/control/CRM/commercial/operations data |
| `20260728091000_tenant_composite_integrity` | organization-aware tenant references                |
| `20260728092000_row_level_security`         | enable/force RLS and policies                       |
| `20260728100000_platform_sessions`          | hashed platform/support sessions                    |
| `20260728101000_platform_settings`          | seller settings                                     |
| `20260728102000_tenant_user_email`          | organization-scoped user email uniqueness           |
| `20260728103000_enterprise_sso`             | OIDC/SAML state and tickets                         |
| `20260728104000_platform_mfa`               | operator TOTP/recovery                              |
| `20260728105000_sso_composite_integrity`    | cross-organization SSO FK protection                |
| `20260728106000_support_launch_tickets`     | encrypted one-use cross-domain support launch       |

Use `prisma migrate deploy` in staging/production. `prisma db push` is deliberately disabled because it can remove migration-only tenant hardening.

## Intentional migration-only hardening

RLS policies, `FORCE ROW LEVEL SECURITY`, deferrable organization-aware foreign keys, and their composite guard indexes are authored in SQL migrations. Prisma cannot model the complete policy/deferrability behavior, so the schema file is not the sole database specification.

Consequences:

- a naive migration-to-Prisma-schema diff proposes removing some composite constraints and normalizing `current_setting` defaults;
- that output is expected and must not be applied;
- `prisma db push` must never be used, including on disposable databases intended to validate production behavior;
- release agreement is proven by applying the full migration chain to an empty database, checking `prisma migrate status`, and running the adversarial RLS verifier.

When changing a tenant relation, update the Prisma relation for application ergonomics, add the organization-aware database constraint in a migration, and extend `test:rls`. Review the generated SQL for any attempted removal of `tenant_*` constraints or RLS policy statements.

## Existing database adoption

The baseline migration represents the current full schema. If adopting an already-running database:

1. take and verify a backup;
2. compare live schema with the baseline;
3. mark the baseline resolved only after exact review;
4. apply later migrations in staging;
5. backfill every legacy row to the intended organization;
6. validate counts, nulls, duplicate natural keys, and foreign keys;
7. enable forced RLS only after scoped application code is deployed;
8. run `test:rls` against a clone;
9. repeat in production during the approved change window.

Do not point the raw baseline at production without drift review.

## Fresh-database release rehearsal

For every release:

1. create a new empty database and shadow database;
2. run `prisma migrate deploy`;
3. run seed/bootstrap with temporary secrets;
4. run `bun run test:rls`;
5. run unit/lint/type/build;
6. execute a shared provisioning job;
7. exercise platform and tenant browser smoke;
8. destroy the disposable databases.

## Production rollout

### Stage 1: internal

- provision production-like PostgreSQL and wildcard domain;
- bootstrap SUPER_ADMIN and enroll MFA;
- create the internal agency manually;
- verify shared deployment, entitlements, files, email, jobs, support, and audit.

### Stage 2: first customer agency

- enter CRM and signed contract data;
- create organization in ONBOARDING;
- create customer administrator;
- choose shared/dedicated;
- configure identity/domain only if contracted;
- verify package/contract/override state;
- activate manually;
- monitor for one full operating cycle.

### Stage 3: enterprise dedicated pilot

- provision an approved isolated AWS environment;
- validate generated environment values, IAM role, and deployment URL;
- connect dedicated/custom domain;
- run customer IdP and SCIM acceptance;
- test audited support on the dedicated URL;
- rehearse suspend/resume and rollback.

### Stage 4: general selling

- require onboarding checklist evidence;
- establish renewal/collection owners;
- enforce MFA and least privilege for operators;
- schedule RLS, restore, and incident drills;
- maintain release notes and this handbook.

## Rollback

Application rollback is preferred over destructive schema rollback. The migrations are additive until lifecycle data deletion occurs.

If a release fails:

1. stop worker/cron if it could mutate external state;
2. roll application code back to a version compatible with the additive schema;
3. preserve jobs/audit/provider IDs;
4. cancel or retry jobs deliberately;
5. diagnose on a database clone;
6. never reverse a completed purge—restore from approved backup if policy allows.
