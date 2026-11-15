# DevFathom Administration Platform

This handbook is the source of truth for the implemented DevFathom control plane and customer-agency administration. The product remains manually sold and activated: it does not expose self-service signup, checkout, or automatic organization activation.

Current platform note: AWS is the deployment platform. Any Vercel package/reference describes disabled legacy repository code, not current deployment guidance. Use [`docs/deploy/aws.md`](../deploy/aws.md) for staging and production operations.

## What shipped

- A separate platform control desk at `admin.<PLATFORM_BASE_DOMAIN>/platform`.
- Manual organization onboarding and lifecycle gates.
- Shared-by-default and dedicated-enterprise deployment records and workers.
- One PostgreSQL database with forced row-level security on every tenant table.
- Module catalog, packages, contracts, overrides, seats, limits, expiry, and grace.
- Full sales CRM, proposal follow-up, opportunity conversion, contract, renewal, invoice, payment, and payment-status ledgers.
- Tenant organization administration for profile, people, roles, domains, brand, email, SCIM, and licensed capabilities.
- Platform MFA, role-scoped operator sessions, one-use audited support access, OIDC, SAML, JIT, SCIM 2.0, API scope enforcement, and an audit ledger.
- Durable jobs for provisioning, domain verification, identity testing, branding, export, suspension, resumption, and retention-controlled purge.

## Handbook map

| Need                                                | Document                                                 |
| --------------------------------------------------- | -------------------------------------------------------- |
| Local development                                   | [Local setup](../LOCAL_SETUP.md)                         |
| Delivery state and evidence                         | [STATUS](STATUS.md)                                      |
| Architecture and request flow                       | [Architecture and tenancy](architecture-tenancy.md)      |
| Platform and agency UI                              | [Control plane](control-plane.md)                        |
| Tables and invariants                               | [Data model](data-model.md)                              |
| Modules, seats, limits, contracts                   | [Entitlements](entitlements.md)                          |
| CRM and commercial operations                       | [Commercial ledger](commercial-ledger.md)                |
| Password, MFA, ABAC, SSO, SCIM, support             | [Identity and access](identity-access.md)                |
| HTTP and tRPC inventory                             | [API](api.md)                                            |
| Brand, domains, and email                           | [White-label](white-label.md)                            |
| Workers, shared/dedicated deployment, configuration | [Operations](operations.md)                              |
| Organization states, export, retention, purge       | [Lifecycle](lifecycle.md)                                |
| Setup and production rollout                        | [Migration and rollout](migration-rollout.md)            |
| Operator procedures                                 | [Runbooks](runbooks.md)                                  |
| Threats and implemented controls                    | [Security threat model](security-threat-model.md)        |
| Test matrix and release gates                       | [Testing and release](testing-release.md)                |
| Canonical product UI/UX contract                    | [DevFathom Studio](../design-system/DEVFATHOM-STUDIO.md) |
| Accepted architecture decisions                     | [ADRs](adr/README.md)                                    |
| Change history                                      | [CHANGELOG](CHANGELOG.md)                                |

## Core source anchors

- `prisma/schema.prisma` and `prisma/migrations/`
- `src/lib/tenancy/scoped-db.ts`, `src/lib/tenancy/host.ts`
- `src/lib/entitlements.ts`, `src/lib/module-catalog.ts`
- `src/lib/platform/auth.ts`, `src/lib/platform/commands.ts`, `src/lib/platform/jobs.ts`
- `src/app/platform/`, `src/app/(app)/organization/`
- `src/server/routers/organization-admin.ts`
- `src/app/api/platform/`, `src/app/api/scim/`, `src/app/api/sso/`

## Status language

- **IMPLEMENTED** means source and migrations exist.
- **PARTIAL** means source exists but an integration or release gate remains.
- **PLANNED** means an accepted design exists without complete implementation.
- **BLOCKED** means a named external dependency prevents progress.
- **FUTURE** means outside the current web scope.
- **Verified locally** means a reproducible check is recorded in [STATUS](STATUS.md).
- **Production configured** requires real deployment secrets, DNS, provider accounts, and an operator-run rollout; local verification is not a claim that those external resources exist.
