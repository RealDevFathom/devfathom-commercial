# Domain and Data Model

`prisma/schema.prisma` is authoritative. This guide groups the platform additions by responsibility.

## Tenant root

`Organization` represents a customer agency and owns:

- slug/legal/display identity;
- lifecycle status and timestamps;
- deployment mode;
- locale, timezone, currency, contacts;
- package and seat limit;
- retention/purge schedule;
- all tenant work data and configuration.

Existing application tables—including users, clients, projects, tasks, boards, meetings, notes, chat, finance, HR, files, API tokens, audit, and email—carry `organizationId`.

## Catalog and entitlement records

| Model                      | Responsibility                                                        |
| -------------------------- | --------------------------------------------------------------------- |
| `PlatformModule`           | sellable module key, name, category, sort order, active state         |
| `PlatformPackage`          | named package and default seat/limit policy                           |
| `PlatformPackageModule`    | package-to-module default plus module limits                          |
| `OrganizationModule`       | final organization enable/disable override, dates, seats, JSON limits |
| `OrganizationLimit`        | key/value override with optional expiry                               |
| `OrganizationUsageCounter` | durable current usage by metric key                                   |

## CRM

| Model                           | Responsibility                                   |
| ------------------------------- | ------------------------------------------------ |
| `PlatformAccount`               | prospective/customer company record              |
| `PlatformLead`                  | source, owner, status, qualification             |
| `PlatformContact`               | people related to accounts/opportunities         |
| `PlatformOpportunity`           | pipeline stage, probability, value, target close |
| `PlatformOpportunityStageEvent` | immutable stage history                          |
| `PlatformProposal`              | proposal version/value/status/expiry             |
| `PlatformFollowUp`              | due date, owner, status, notes                   |

A won opportunity can be converted into an `Organization` without deleting CRM history.

## Commercial ledger

| Model                    | Responsibility                                                       |
| ------------------------ | -------------------------------------------------------------------- |
| `PlatformContract`       | contract number, term, value, billing interval, seats, grace, status |
| `PlatformContractModule` | contracted modules, seats, limits                                    |
| `PlatformInvoice`        | invoice number, dates, subtotal/tax/discount/total/balance, status   |
| `PlatformPayment`        | payment reference, amount, method/provider, status, received date    |
| `PlatformRenewal`        | renewal owner, due date, proposed value/term, status                 |

Payments reduce invoice balance and update collection status. This is an operational ledger, not double-entry accounting.

## Identity and access

| Model                            | Responsibility                                           |
| -------------------------------- | -------------------------------------------------------- |
| `PlatformUser`                   | seller operator                                          |
| `PlatformSession`                | hashed, expiring/revocable operator session              |
| `PlatformRecoveryCode`           | hashed single-use platform MFA recovery code             |
| `TwoFactorRecoveryCode`          | tenant MFA recovery code                                 |
| `OrganizationRole`               | custom tenant role                                       |
| `OrganizationRolePermission`     | allow/deny capability rule                               |
| `UserPermissionOverride`         | per-user final rule                                      |
| `OrganizationIdentityConnection` | OIDC/SAML metadata, encrypted secret, role/domain policy |
| `OrganizationSsoState`           | expiring one-use OIDC/SAML request state                 |
| `TenantSsoTicket`                | expiring one-use bridge into Auth.js                     |
| `OrganizationScimToken`          | hashed SCIM bearer token and lifecycle                   |
| `OrganizationScimEvent`          | directory operation audit                                |

Organization SSO states and tickets have composite organization-aware foreign keys installed by migration.

## Configuration and operations

| Model                        | Responsibility                                                             |
| ---------------------------- | -------------------------------------------------------------------------- |
| `OrganizationBrand`          | logos, colors, support/sender presentation                                 |
| `OrganizationEmailSettings`  | provider, encrypted API key, sender/config JSON                            |
| `OrganizationDomain`         | host, purpose, TXT token, verification status                              |
| `OrganizationDeployment`     | environment, mode, provider, URL/project/region/version/health             |
| `PlatformJob`                | durable typed job, scheduling, attempts, idempotency, payload/result/error |
| `OrganizationLifecycleEvent` | organization state-transition history                                      |
| `PlatformSupportSession`     | audited support identity, access/launch secrets, expiry/end                |
| `PlatformAuditLog`           | platform actor/action/target/before/after/reason/outcome/request metadata  |
| `PlatformSetting`            | seller-scoped configuration record                                         |

## Integrity rules

- Organization slugs, domains, contract numbers, invoice numbers, and job idempotency keys are unique in their intended scope.
- Tenant user email is unique within an organization, not globally.
- Tenant references cannot cross organizations.
- System roles are immutable through product commands.
- Tokens are stored as strong hashes; provider and launch secrets are encrypted with AES-256-GCM.
- Commercial and audit history is retained; correction is represented by status/payment/renewal records rather than silent deletion.
- Purge excludes control-plane records needed to prove the lifecycle action.

## Migrations

The repository contains one complete baseline followed by additive migrations. Deploy with `prisma migrate deploy`; `db push` is disabled because migration-only RLS and deferrable composite constraints are part of the authoritative database contract. See [Migration and rollout](migration-rollout.md).
