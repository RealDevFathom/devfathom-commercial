# Testing and Release Gates

## Automated suites

| Command                            | Coverage                                                              |
| ---------------------------------- | --------------------------------------------------------------------- |
| `bun run typecheck`                | TypeScript across app, platform, routes, scripts                      |
| `bun run lint -- --max-warnings=0` | Next/React/TypeScript lint                                            |
| `bun run test`                     | Vitest unit/security/component tests                                  |
| changed-file Prettier check        | formatting of every file changed by this implementation               |
| `bunx prisma validate`             | Prisma schema/config                                                  |
| `bunx prisma migrate status`       | migration/database agreement                                          |
| `bun run test:rls`                 | forced policy and cross-tenant adversarial checks                     |
| `bun run build`                    | production route compilation/static generation                        |
| `bun run test:e2e`                 | repository Playwright suite when its target environment is configured |
| `git diff --check`                 | whitespace/conflict markers                                           |

Current unit coverage includes:

- module-to-page/procedure/API mapping;
- RFC TOTP vector, recovery-code hashing, and invalid input;
- ABAC wildcard, explicit deny, override, inactive/fail-closed behavior;
- host routing/normalization;
- platform password and exact-origin controls;
- public proxy origin reconstruction;
- platform-vs-tenant proxy boundaries and framework assets;
- platform command-form null handling.

## RLS matrix

The verifier:

1. confirms PostgreSQL and refuses unsafe remote execution unless explicitly allowed;
2. discovers all `organizationId` tables;
3. asserts RLS enabled and forced;
4. creates two isolated organizations/users;
5. validates same natural keys can coexist;
6. validates tenant A cannot read/write tenant B;
7. validates missing session settings fail closed;
8. validates control tables require platform scope;
9. validates SSO state/ticket isolation and composite FK rejection;
10. rolls back fixture data.

Run it only against a disposable or approved test database:

```bash
TEST_DATABASE_URL='postgresql://...' bun run test:rls
```

## Browser QA matrix

Platform:

- login/hydration;
- all navigation routes;
- responsive horizontal containment;
- organization module/limit/role/domain/deployment forms;
- settings/MFA state;
- no framework-asset redirects.

Tenant:

- credential login and dashboard;
- organization administration sections;
- profile mutation;
- effective modules and seats;
- module disable hides navigation and blocks direct route;
- inherited state restores;
- SCIM token issue/request/revoke;
- support launch/banner/end;
- console and server error review.

## Worker smoke

Create a disposable shared-provisioning job, then:

```bash
bun run platform:jobs -- --max-jobs=1
```

Expected result contains one claimed/succeeded job and a READY shared deployment. Dedicated Azure automation is not provider-verified and remains blocked until a controlled isolated environment reaches READY and passes acceptance.

## Fresh database gate

Do not rely only on a developer database:

1. create empty app/shadow databases;
2. apply all migrations;
3. seed temporary data;
4. run RLS, unit, lint, type, build;
5. inspect migration status;
6. delete the databases after evidence is captured.

The full-repository `bun run format:check` is not currently a clean baseline: it reports 49 legacy source files that predate this work. The release gate therefore checks every changed file and records the legacy debt in [STATUS](STATUS.md); do not silently mass-format unrelated modules in a feature release.

## Final release checklist

- [x] Type, lint, unit tests, changed-file formatting, and Prisma validation pass.
- [x] Fresh migrations and RLS pass.
- [x] Production build has no error/deprecation requiring action.
- [x] Browser smoke passes on admin and tenant hosts.
- [x] Shared worker smoke passes.
- [ ] Dedicated/IdP/DNS/email/Blob provider acceptance passes for enabled features.
- [ ] Required secrets are present and rotated from bootstrap values.
- [ ] SUPER_ADMIN MFA is enrolled.
- [ ] Backup/restore drill is current.
- [ ] Retention, support, and incident policies are approved.
- [x] Documentation status/changelog match the release.
- [x] No test credentials, tokens, exports, or environment files are committed.

## Evidence policy

Record command, date, environment, result, and any intentionally skipped external integration in [STATUS](STATUS.md). Never convert a local build into a claim that DNS, Azure resources, Blob, email, IdP, or production backup is configured.
