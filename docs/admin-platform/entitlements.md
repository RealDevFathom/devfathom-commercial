# Modules, Packages, Contracts, and Limits

## Effective entitlement precedence

`resolveOrganizationEntitlements` computes a tenant snapshot from separate tenant and control-plane transactions:

1. active catalog defines known modules;
2. active package links establish defaults;
3. active/grace/renewal-due contracts add modules, seats, limits, and expiry;
4. organization module overrides are final, including explicit disable;
5. organization limit records override matching numeric limits;
6. the organization seat limit bounds the result.

In short: **organization override > live contract > package default > disabled**.

Control catalog/contract reads remain in `withPlatformDb`; tenant reads remain in tenant scope. The resolver never weakens RLS to join both halves.

## Module catalog

The seeded catalog maps product surfaces and API scopes to keys such as:

- `dashboard`, `projects`, `clients`, `finance`;
- `chat`, `meetings`, `notes`, `email`;
- `hr`, `reviews`;
- `api`, `webhooks`, `audit`;
- `branding`, `domains`, `identity`, `scim`, `data`.

`src/lib/module-catalog.ts` is authoritative for navigation, tRPC procedure, and REST scope mappings.

## Enforcement layers

- Sidebar items are hidden through `EntitlementsProvider`.
- `ModuleBoundary` prevents direct navigation to a disabled page.
- tRPC middleware maps procedures to modules and rejects disabled access.
- REST authentication maps API scopes to modules before handlers run.
- Organization admin actions require the relevant module and tenant admin capability.
- Jobs are created only from authorized platform commands and validate required state again during execution.

Client visibility is not an authorization boundary.

## Seats

Active seat usage counts tenant users in `ACTIVE`, `ON_LEAVE`, or `INVITED`. JIT and administrator member changes call `assertSeatAvailable`. Effective seat limit is the highest valid commercial/organization constraint, capped by the organization’s configured ceiling.

When the ceiling is reached:

- new JIT users are rejected;
- tenant/member workflows cannot consume another licensed seat;
- existing users remain visible so an administrator can deactivate or resolve the contract.

## Dates and grace

Package defaults have no contract date. A contract contributes only when:

- status is `ACTIVE`, `GRACE`, or `RENEWAL_DUE`;
- `startDate <= now`; and
- `endDate >= now` or `graceUntil >= now`.

The entitlement snapshot exposes module and contract expiry. Organization lifecycle `GRACE` remains accessible; `SUSPENDED`, `TERMINATED`, `PURGING`, and `PURGED` block tenant access.

## Limits and usage

Numeric limits can come from package JSON, contract-module JSON, organization-module JSON, or `OrganizationLimit`. Values are normalized to non-negative integers.

`OrganizationUsageCounter` stores operator-visible usage. Limit removal restores inherited state. Expired organization limits are ignored automatically.

The platform can record custom usage/limit keys without a schema migration, but enforcement code must explicitly consume a key before it becomes a hard product limit.

## Operator workflow

1. Define catalog modules and packages.
2. Attach package modules and defaults.
3. Create the organization with a package and seat ceiling.
4. Record the signed contract, modules, dates, grace, and value.
5. Use organization overrides only for exceptions.
6. Review the effective module list in both control plane and tenant administration.
7. Reset an override to return to contract/package inheritance.

Every platform change records the operator, organization, target, and result.
