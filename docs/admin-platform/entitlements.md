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

## Restaurant route and procedure map

`ROUTE_MODULES` / `moduleForPath` own the route → module contract for both verticals; navigation
must derive module ownership from this catalog rather than repeating module strings. The
restaurant surfaces map as follows (plan §3):

| Surface                         | Route                                                                   | Effective module                                                          |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Dashboard                       | `/dashboard`                                                            | `restaurant-core` for a `RESTAURANT` organization; `dashboard` for Agency |
| POS register                    | `/pos`                                                                  | `restaurant-pos`                                                          |
| KDS                             | `/kds`                                                                  | `restaurant-pos`                                                          |
| Floor / orders / money          | `/restaurant/floor`, `/restaurant/orders`, `/restaurant/money`          | `restaurant-pos`                                                          |
| Inventory                       | `/restaurant/inventory`                                                 | `restaurant-inventory`                                                    |
| Purchasing                      | `/restaurant/purchasing`                                                | `restaurant-purchasing`                                                   |
| SOP board and admin             | `/restaurant/sop`, `/restaurant/sop/admin`                              | `restaurant-sop` (admin adds an authorization check, not an entitlement)  |
| Customers & loyalty             | `/restaurant/loyalty`                                                   | `restaurant-loyalty`                                                      |
| Insights                        | `/restaurant/insights`                                                  | `restaurant-insights`                                                     |
| Catalog / menus                 | `/restaurant/catalog`, `/restaurant/menus`                              | `restaurant-menu`                                                         |
| Staff / devices / notifications | `/restaurant/staff`, `/restaurant/devices`, `/restaurant/notifications` | `restaurant-core`                                                         |
| Any other `/restaurant/*`       | —                                                                       | `restaurant-core` (the vertical catalog owns the `/restaurant` prefix)    |

`moduleForPath(pathname, vertical)` dispatches only the Dashboard entry by vertical; callers that
cannot supply a vertical keep the legacy Agency `dashboard` result.

tRPC procedure namespaces follow the same keys: `restaurantCustomers` and `restaurantLoyalty`
both gate on the combined `restaurant-loyalty` product module (there is no `restaurant-customers`
key in the catalog), and `restaurantInventory` / `restaurantPurchasing` gate on
`restaurant-inventory` / `restaurant-purchasing`, not on POS. The `dashboard` procedure namespace
stays an Agency module: a restaurant organization never licenses it, so agency dashboard data
procedures fail closed for restaurant tenants.

## Terminal entitlement boundary

`/pos` and `/kds` are device-authenticated surfaces outside the tenant AppShell, so navigation
hiding never protects them. `src/lib/restaurant/terminal-auth.ts` therefore enforces the
**effective** `restaurant-pos` entitlement (package → contract → override, via
`resolveOrganizationEntitlements`) on every `withDeviceAuth` and `withTerminalAuth` request,
inside the request's tenant transaction. A disabled module answers `403` before the handler runs
and before the device/session check-in is recorded; because the snapshot is resolved fresh per
request, disabling POS takes effect on a terminal's very next call, even mid-session.

## Package vertical metadata

Every package records one organization vertical. Production bootstrap creates `agency-suite` as
`AGENCY` and the three package definitions from `src/lib/vertical-catalog.ts` as `RESTAURANT`.
Package assignment must match the organization vertical.

Restaurant package rows, module links, and provisional D10 limits are catalog metadata only. They
do not seed restaurant tenant data or claim that linked restaurant features are implemented.

## Enforcement layers

- Sidebar items are hidden through `EntitlementsProvider`.
- `ModuleBoundary` prevents direct navigation to a disabled page.
- tRPC middleware maps procedures to modules and rejects disabled access.
- REST authentication maps API scopes to modules before handlers run.
- Terminal (POS/KDS) device and session authentication requires the effective `restaurant-pos` module and answers 403 when it is disabled.
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
