# Platform Status Ledger

Last reviewed: 2026-08-08. This file preserves local control-plane verification; [`docs/status-ledger.md`](../status-ledger.md) is the current cross-product release ledger.

Production evidence update: the reported audited `main` baseline is `89f75459` (#24). An empty tagged production resource-group shell exists, but it has no billable resources. A separate secretless production-only OIDC identity, least-privilege production-RG/shared-ACR roles, seven required GitHub Azure variables, and a `main`-only deployment branch policy are configured. No production app, database, Key Vault, storage, AI, secret, deployment, DNS, or certificate exists. Draft PR #33 is open and unmerged; the current production template and promotion path remain **BLOCKED**.

| Phase                             | Implementation | Verification                                                                       | Production dependency                                      |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Tenant schema and boundary        | Complete       | Fresh migration and adversarial RLS suite passed                                   | Managed PostgreSQL and backup policy                       |
| Platform operator authentication  | Complete       | Login and authorization browser smoke passed                                       | Strong bootstrap credential and secret rotation            |
| Organization onboarding/lifecycle | Complete       | Platform organization detail and mutation smoke passed                             | Approval, retention, and legal-hold policy                 |
| Catalog, packages, entitlements   | Complete       | Unit tests plus disable/direct-route/restore browser test passed                   | Product catalog and signed contract data                   |
| CRM and commercial ledger         | Complete       | All control surfaces rendered; build/type checks passed                            | Finance operating process; no automatic payment processor  |
| Agency administration             | Complete       | `/organization` rendered, profile mutation passed                                  | Customer administrator training                            |
| OIDC/SAML/JIT                     | Complete       | Static/build checks; protocol requires real IdP staging test                       | IdP metadata, certificates, client credentials             |
| SCIM 2.0                          | Complete       | Token issue, paginated Users request, unauthorized request, revoke/replay passed   | Customer directory integration                             |
| Shared provisioning               | Complete       | Real local worker job succeeded and deployment became READY                        | Base domain and production deployment                      |
| Dedicated provisioning            | Partial        | Legacy SDK path/build verified; no Azure dedicated environment exists              | Azure topology, isolation, customer contract, and rollout approval |
| Domains/brand/email               | Complete       | UI, worker path, encryption, and build verified                                    | DNS records and selected email provider credentials        |
| Export/purge/suspend/resume       | Complete       | Worker and lifecycle guards build/test clean                                       | Private Blob store and approved retention schedule         |
| Audited support access            | Complete       | Start, one-use cross-domain launch, banner, action context, and end passed         | Platform operator policy                                   |
| Documentation                     | Complete       | Cross-checked against routes, schema, migrations, final QA, and Studio UI contract | Keep synchronized with releases                            |

## Product decisions

- Customer agencies are represented by `Organization`.
- Activation is manual. Creating an organization does not activate it.
- Shared deployment is the default; `DEDICATED` is reserved for enterprise contracts.
- PostgreSQL is shared, but every tenant table has `organizationId`, forced RLS, and scoped composite references.
- The control plane is seller-operated; it is not a customer-facing SaaS signup/billing portal.
- Commercial records are a contract and collection ledger. Payment status is recorded manually; no payment provider was provisioned.

## Local verification evidence

The checks below used disposable PostgreSQL databases on 2026-07-28. No credentials or tokens are stored in this repository.

| Check                                            | Result                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`                              | Passed                                                                                                      |
| `bun run lint -- --max-warnings=0`               | Passed                                                                                                      |
| `bun run test`                                   | Passed; 9 files and 37 tests                                                                                |
| `bunx prisma validate`                           | Passed                                                                                                      |
| `bunx prisma migrate deploy` on a fresh database | Passed; all migrations applied                                                                              |
| `bun run test:rls` against the fresh database    | Passed; policy, cross-tenant, SSO, and fail-closed checks                                                   |
| Changed-file Prettier check                      | Passed for every changed TypeScript, TSX, JSON, Markdown, YAML, and CSS file                                |
| `bun run build`                                  | Passed on Next.js 16.2.12/Prisma 7.9.1 with deprecation tracing and no warning requiring action             |
| `bun audit`                                      | Direct/runtime advisories cleared; two accepted toolchain-only advisories remain, described below           |
| `bun run platform:jobs -- --max-jobs=1`          | Passed; shared provisioning job succeeded                                                                   |
| Platform browser smoke                           | Passed on dashboard, organizations, CRM, commercial, catalog, deployments, jobs, operators, audit, settings |
| Platform visual parity                           | Passed at desktop/mobile widths, light/dark themes, and reduced motion against the tenant Studio language   |
| Tenant browser smoke                             | Passed on dashboard and organization administration                                                         |
| Entitlement browser smoke                        | Reviews disabled, navigation hidden, direct route blocked, inherited package state restored                 |
| SCIM browser/API smoke                           | Token created, authorized config/users succeeded, unauthenticated and revoked token returned 401            |
| Support browser smoke                            | Audited session created, one-use ticket consumed on tenant host, banner shown, session ended                |

The repository-wide `bun run format:check` still reports pre-existing formatting drift in 49 legacy source files. They were not mass-reformatted because that would create unrelated product changes; every file touched by this implementation passes a targeted Prettier check.

`bun audit` reports two residual advisories in non-application execution paths:

- `@hono/node-server` is pulled by the shadcn CLI/MCP toolchain; the affected static-file server is not imported by the deployed application.
- `brace-expansion` is pulled by lint/build/file-management toolchains. The application does not accept user-supplied glob patterns. Forcing the only non-advisory major release breaks the current ESLint/minimatch contract, so the latest compatible dependency line is retained until upstream consumers migrate.

The earlier direct/runtime findings in Next.js, Auth.js, Sharp, and PostCSS were removed through patch upgrades and compatible resolutions. See [Testing and release](testing-release.md).

## External readiness conditions

Production release is conditional on:

1. Provisioning PostgreSQL and testing backup/restore.
2. Setting every required secret in [Operations](operations.md).
3. Connecting wildcard/base domains and adding verified customer DNS.
4. Completing safe first-tenant/platform-admin bootstrap and post-deploy health smoke.
5. Provisioning private Blob storage before enabling export jobs.
6. Running OIDC/SAML/SCIM acceptance tests with each customer IdP/directory.
7. Choosing and configuring the production email provider before enabling send mode.
8. Revalidating the configured production-only OIDC identity, least-privilege RBAC, seven GitHub Azure variables, and `main`-only deployment policy.
9. Approving retention, purge, support-access, and incident-response policies.
