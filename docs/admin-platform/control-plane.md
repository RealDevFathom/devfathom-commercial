# Platform and Agency Control Surfaces

## Platform control desk

The platform lives at `admin.<base-domain>/platform`. It is intentionally unavailable on tenant and dedicated hosts.

| Route                          | Purpose                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `/platform`                    | health, active organizations, contract value, pipeline, overdue invoices, jobs, activation queue, renewals                 |
| `/platform/organizations`      | filter/search organizations and enter an organization record                                                               |
| `/platform/organizations/new`  | manually create a prospect/onboarding customer agency                                                                      |
| `/platform/organizations/[id]` | lifecycle, profile, modules, limits, members, brand, email, domains, identity, SCIM, deployment, contracts, audit, support |
| `/platform/crm`                | accounts, leads, opportunities, proposals, follow-ups                                                                      |
| `/platform/commercial`         | contracts, invoices, payments, renewals                                                                                    |
| `/platform/catalog`            | module and package catalog                                                                                                 |
| `/platform/deployments`        | deployment inventory and manual registration                                                                               |
| `/platform/jobs`               | create, observe, retry, and cancel jobs                                                                                    |
| `/platform/operators`          | platform users, roles, activation, MFA reset                                                                               |
| `/platform/audit`              | immutable control-plane action ledger                                                                                      |
| `/platform/settings`           | runtime/integration status and seller settings                                                                             |

The visual system reuses the product’s editorial black, paper, moss, and coral language while keeping a distinct fixed control-desk sidebar.

## Operator roles

- `SUPER_ADMIN`: all platform capabilities.
- `OPERATIONS`: organizations, deployments, jobs, support, catalog as configured by `canPlatform`.
- `SALES`: CRM and commercial workflows.
- `SUPPORT`: read access and audited tenant support.
- `FINANCE`: commercial ledger and collection status.
- `AUDITOR`: read-only evidence access.

`src/lib/platform/auth.ts` is authoritative for the role-to-capability matrix. Every API mutation checks the database-backed operator session and required capability.

## Command bus

The UI sends typed command envelopes to `/api/platform/control`. `executePlatformCommand` validates input, checks capability, performs the transaction, and records platform audit.

Command families:

- organization create/update/transition;
- module set/reset, limit set/remove, usage update;
- brand, email, domain add/status/retry/remove;
- identity create/test/remove;
- SCIM token create/revoke;
- custom role and permission create/update/remove;
- member update and password reset;
- CRM account/lead/contact/opportunity/proposal/follow-up;
- opportunity conversion to organization;
- contract/invoice/payment/renewal;
- catalog module/package/package-module;
- deployment create/update;
- job create/retry/cancel;
- operator create/update/MFA reset;
- platform setting upsert.

Sensitive transitions require a reason. System roles cannot be edited or deleted. Production provisioning is automated; non-production deployments are manually registered to avoid pretending a production provider action occurred.

## Organization activation

Creation is not activation. An operator moves an organization through lifecycle gates. Activation validation checks the package, administrator, deployment choice, and configured capability state. The transition records a lifecycle event and can enqueue provisioning.

The organization page surfaces current state before actions:

- lifecycle and allowed next states;
- seat consumption and package;
- effective and overridden modules;
- limits/usage;
- recent contracts/invoices;
- deployment and health metadata;
- identity/domain verification errors;
- audit/support history.

## Customer-agency administration

Tenant administrators use `/organization`. They can:

- view license/package/module/seat state;
- edit workspace profile;
- apply allowed brand settings;
- update members, tenant roles, status, department, and custom role;
- reset a member password;
- create/edit/remove non-system roles;
- add domains and retry verification;
- create/revoke SCIM tokens;
- update email delivery settings.

They cannot activate, suspend, purge, change commercial contracts, change deployment topology, or grant modules. Those remain platform-operated.

## Audited support

An authorized operator supplies a 10–500 character reason and 15/30/60 minute duration. The platform:

1. ends any previous active support session by the operator for that organization;
2. chooses an active tenant administrator;
3. stores a hashed access token, encrypted token ciphertext, and hashed one-use launch ticket;
4. records `support.session.started`;
5. opens the correct shared or dedicated tenant deployment;
6. consumes the launch ticket once and sets a host-only support cookie;
7. shows a persistent banner with actor and reason;
8. attributes tenant actions to support identity;
9. records termination and clears the cookie.

Suspension revokes active support sessions. A launch ticket cannot be replayed.

## UX safety

- Platform and tenant login forms use POST fallback.
- Destructive platform actions expose state and require explicit intent/reason.
- Long ledgers and CRM columns scroll within their region instead of overflowing the viewport.
- Module-disabled routes render a clear “This module is not enabled” boundary.
- Secrets and SCIM tokens are displayed only at creation; stored views show only prefixes/configured state.
