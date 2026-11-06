# Restaurant vertical — product understanding

Reviewed commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75` on `qa/pharmacy-restaurants-agencies`.

This note is the QA model of the restaurant product. It is derived from the README, local setup guide, administration handbook, restaurant administrator guide, POS/KDS/loyalty/tax/SOP/notification PRDs, the vertical catalog, Prisma restaurant models, and the platform onboarding command. It describes the product as specified and implemented in this tree. It is not a release claim.

## What DevFathom is

DevFathom Hub is a multi-tenant operating system sold to customer organizations. One Next.js 16 application serves two realms:

- **Tenant workspace** on the shared host `http://devfathom.localhost:3000` (and, when configured, `{slug}.{PLATFORM_BASE_DOMAIN}`). Sign-in is `src/app/login/page.tsx` and `src/app/api/login/route.ts`. On the shared host the user proves email and password first; the server then offers only the organizations that password can open. The organization id never travels in the page URL.
- **Seller control desk** only on `http://admin.localhost:3000/platform`. Sign-in is a separate platform session cookie (`df_platform_session`) via `src/app/api/platform/session/route.ts`. Platform operators are not restaurant users. A platform session cannot act as a restaurant administrator.

Customer data lives in one PostgreSQL database with forced row-level security. `prisma db push` is disabled. Schema changes are migration-only. Extension hardening (`btree_gist`, `pg_trgm` PUBLIC EXECUTE revoke) is a pre-migration step in `prisma/prepare-extensions.ts`. The local setup guide does not mention that step. See the setup record in the execution report.

The seed (`bun run db:seed`) creates the DevFathom **agency** workspace (`org_devfathom`), eight team users (`alex@company.com`, `jordan@company.com`, and first-name `@company.com` accounts), agency demo data, the commercial module/package catalog, and the platform super admin from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`. It does **not** create a restaurant customer. A restaurant exists only after a platform operator onboards one.

## Organization types

The catalog in `src/lib/vertical-catalog.ts` is the single source of vertical truth. Types are `AGENCY`, `RESTAURANT`, `PHARMACY`, and `HOSPITALITY`. Onboarding is type-first: `/platform/organizations/new` shows no preselected type. The server default of `AGENCY` is not used unless the operator submits that type. A package from another vertical is rejected even if the client is crafted. After activation the type is immutable.

## How a super admin onboards a restaurant

1. Super admin signs in at `/platform/login`. Roles `SUPER_ADMIN`, `OPERATIONS`, and `SUPPORT` require authenticator MFA unless `PLATFORM_MFA_ENFORCE=false`. A first login with MFA required opens an enrollment-only session until a TOTP secret is confirmed.
2. Platform → Organizations → New. Choose **Restaurant**.
3. Submit **Create onboarding record** (`organization.create`). Required restaurant fields beyond the shared organization form: first branch name, first branch address, and a 24-hour business-day cutoff. Timezone must be a valid IANA zone (the form defaults restaurants to `Asia/Karachi`). Currency, locale, seat limit, shared vs dedicated deployment, package, primary contact, and the first tenant administrator (name, email, password of at least 12 characters) are collected here. The operator sets the administrator password directly. That differs from the agency invite flow, where an admin never sets another person's password.
4. The command creates the organization in **ONBOARDING**, an `admin` organization role with capability `*`, the vertical department catalog, the tenant administrator (`User.role = ADMIN`), branch `MAIN` (default, active) plus a branch assignment, a `RestaurantStaffProfile` for that administrator, and every `RESTAURANT_ROLE_TEMPLATES` row except a duplicate of the bootstrap admin. Package module links become the entitlement baseline. A `PROVISION_SHARED` or `PROVISION_DEDICATED` job is queued. Dedicated mode is rejected when Vercel provisioning is not configured.
5. The organization page then requires **Restaurant readiness** (`organization.restaurant.setup`): confirm branch name, address, timezone, and cutoff, and acknowledge four policies — TAX, PAYMENT, DEVICE, OPERATOR — each with an operator-supplied policy reference. These acknowledgements are mandatory for non-demo restaurants.
6. Activation is manual (`organization.transition` to `ACTIVE`). Preflight requires a restaurant-compatible package, Restaurant Core, at least one additional restaurant module, exactly one active default branch with name, address, IANA timezone, and cutoff, the four policy acknowledgements, an active administrator, at least one enabled module, and a production deployment in `READY`. The lifecycle panel can record the shared deployment as ready (`organization.deployment.shared`) or an operator can run `bun run platform:jobs` so `sharedProvision` upserts a READY shared deployment. Local shared provisioning does not call Vercel; it writes a URL of `http://{slug}.localhost`.
7. Lifecycle after that follows `docs/admin-platform/lifecycle.md`: ACTIVE can move to GRACE, SUSPENDED, or TERMINATED. SUSPENDED and TERMINATED block tenant authentication. Restaurant POS device trust is also invalidated when the organization is suspended or `restaurant-pos` is disabled.

Restaurant staff cannot grant themselves commercial modules. Entitlement changes are platform-only (package, contract, or module override).

## Commercial modules, packages, and limits

Ten restaurant modules. Only **Restaurant Core** (`restaurant-core`, route prefix `/restaurant`) is mandatory.

| Key | Name | Licensed surface (prefix) |
| --- | --- | --- |
| `restaurant-core` | Restaurant Core | `/restaurant` plus staff, branches, devices, shifts, notifications, delivery, catering, reports, growth, dashboard |
| `restaurant-pos` | POS and Fulfilment | `/pos`, `/kds`, `/restaurant/floor`, orders, bills, cash, payments, tax |
| `restaurant-menu` | Menu and Costing | `/restaurant/catalog`, `/restaurant/menus`, promotions, menu import |
| `restaurant-inventory` | Inventory | `/restaurant/inventory` |
| `restaurant-purchasing` | Purchasing | `/restaurant/purchasing` |
| `restaurant-workforce` | Restaurant Workforce | workforce routes |
| `restaurant-sop` | SOP and Compliance | `/restaurant/sop` |
| `restaurant-loyalty` | Customers and Loyalty | `/restaurant/loyalty` and customer APIs |
| `restaurant-insights` | Restaurant Insights | `/restaurant/insights` and reconciled dashboard rollups |
| `restaurant-integrations` | Integrations and Devices | `/restaurant/integrations` (cameras) |

Packages widen: **Essentials** ⊂ **Operations** ⊂ **Enterprise**.

- Essentials: core, POS, menu, inventory, workforce, SOP. One location, one brand, 2 POS terminals, 4 registered devices, 10 operators, 5,000 orders/month.
- Operations adds purchasing, loyalty, insights, integrations. Five locations, 3 brands, 25 devices, 100 operators, loyalty cap 25,000.
- Enterprise includes every restaurant module, with contracted ceilings (100 locations, 25 brands, 1,000 devices, 2,500 operators).

A disabled module must deny its routes even if the user has the capability. Navigation is supposed to hide surfaces the tenant is not entitled to, including other verticals.

## Two role surfaces

These are different subjects and must not be confused.

**Organization roles** (`RESTAURANT_ROLE_TEMPLATES`) attach to a web `User`. A user has one organization role. Templates:

| Key | Intent |
| --- | --- |
| `owner` | Owner / Administrator, capability `*` |
| `general-manager` | Broad operations including configure, refunds, voids, discounts, comps, menu authoring, purchasing approval, financial reports. The template does **not** include `staff:manage`, `devices:manage`, `menu:import`, or `workforce:rates`. |
| `branch-manager` | Branch operations, publish and price, no `menu:write`, no financial reports, no refunds in the org template (refunds exist on the job-role supervisor set). |
| `cashier` | POS, take orders, collect payments, open/close cash, read menu and customers. No discounts, refunds, or voids. |
| `server` | POS, take orders, read menu and customers. No payments. |
| `kitchen` | Read orders, operate KDS, read menu, complete SOP. |
| `bar-barista` | Take orders and operate the bar KDS. |
| `inventory-controller` | Count, adjust, waste, operational reports. |
| `purchasing-officer` | Create and approve purchasing. |
| `accountant` | Read money, financial and operational reports, refunds. |
| `sop-compliance-auditor` | Complete, verify, and manage SOP; operational reports. |

The bootstrap `admin` role is separate and holds `*`. Explicit user denies override role grants. Branch assignment further limits which locations a person can see.

**Job roles** (`RESTAURANT_JOB_ROLE_TEMPLATES`) attach to a `RestaurantStaffProfile`, who may have no web login and may hold many duties per branch. Keys include barista, cashier, server, kitchen, host, shift-supervisor, manager, owner, accountant, and delivery-rider. Job-role capabilities are enumerated, never `*`, so a per-person DENY can subtract a named grant. Floor credentials are PIN or badge on a registered device. They are not web passwords. A shared POS or KDS is a device, not a shared user.

Sensitive actions (post-preparation void, comp, refund, device revocation, some closes) require a **distinct** manager credential (`coauth:approve`), not the operator approving themselves.

## Operator journey the product claims

Canonical operator guide: `docs/product/restaurant-administrator-guide.md`.

1. **Outlet.** `/restaurant/settings/branches`. Create, edit, make primary, activate, deactivate. The active primary cannot be deactivated until another branch is primary. Readable codes, not internal ids. Essentials stops at one active location.
2. **People.** `/restaurant/staff` for profiles, roles, credentials, status, link to an organization user, and branch assignment. `/restaurant/staff/roster` for shifts. `/restaurant/devices` enrolls the current browser as POS or KDS (station required for KDS). Enrollment ends the administrator web session and opens `/pos` or `/kds`. The operator then unlocks with their own PIN.
3. **Menu.** `/restaurant/catalog` is the canonical catalog: categories, products, variants, modifier groups and options, allergens, units, conversions, ingredients, recipe versions and substitutes. `/restaurant/menus` publishes sections, items, price versions, branch and channel publications, windows, exceptions, and overrides. Capabilities split `menu:read`, `menu:write`, `menu:price`, `menu:publish`, and `menu:import`.
4. **OCR import.** `/restaurant/menu-import` produces candidates only. Commit creates a DRAFT menu and DRAFT price version. It never publishes. The page exists; the primary sidebar list in `src/components/layout/sidebar.tsx` does not link it.
5. **Tax.** `/restaurant/tax`. Pakistan preset or a custom profile per branch (inclusive or exclusive, cash/card/other rates, approval reference). Settlement keeps historical snapshots. The product is not tax advice and does not file returns.
6. **Service.** `/pos` opens dine-in, takeaway, or connected-only delivery. Dine-in picks a table on a named floor. Items and modifiers come from the effective menu. Hold, fire, serve, move table, merge tables. Fired items route to a station KDS (`/kds`) by most-specific product, then category, then course. KDS can start, mark ready, recall, and hand off delivery (dispatch, then delivered). PREPAID delivery must be paid before dispatch; COD stays collect-on-delivery.
7. **Money.** Close for payment. Split none, by item, by seat, or fractionally. Tenders: cash, card, or other. Tips, change, and remaining due are part of the contract. Card is an operator-confirmed **mock**. There is no live processor, tokenization, or settlement. Receipts are display data plus a simulated print bridge (ESC/POS bytes and durable jobs). Physical printers are not connected. Voids, comps, and refunds of protected actions need a manager reason. `/restaurant/money` is the read-only reconciliation of bills, tenders, drawers, daily close, and card-terminal events, and it must fail closed without finance access. Drawer open, paid-in, paid-out, drop, and counted close live on the POS.
8. **Guests.** `/restaurant/loyalty` for programs and accounts. Checkout can search, attach, earn, and redeem. Ledger entries are append-only.
9. **Stock and recipes.** Inventory holds on-hand, movements, counts, transfers, low stock, adjustments, and wastage. Purchasing is draft PO, submit, approve, receipt. Recipe costing uses an exact unit conversion, then a weighted-average stock cost, then a reference cost. Activating a recipe version supersedes the previous one and freezes it.
10. **Catering.** `/restaurant/catering` on Restaurant Core. Draft through quoted, confirmed, in production, ready, delivered, closed. READY posts recipe consumption; cancel after that reverses it once.
11. **SOP.** Execute on `/restaurant/sop`, administer on `/restaurant/sop/admin`, oversee on `/restaurant/sop/oversight`, report on `/restaurant/sop/reports`. Evidence is append-only. Waivers need a second authorizer.
12. **Reports and insights.** `/restaurant/reports` splits financial, operational, inventory, purchasing, workforce, and SOP, with CSV under the same authorization. All-branch reporting needs `restaurant:configure`. Food cost, dish profitability (star/plowhorse/puzzle/dog), and catering margin are specified. `/restaurant/insights` is the reconciled closed-day view and needs `restaurant-insights`. Dashboard widget layout can be saved.
13. **Notifications.** `/restaurant/notifications` configures one organization HTTPS webhook. The body is signed `v1=` HMAC-SHA256 over `timestamp.body`, with an idempotency key. Failures retry and then dead-letter. Admins can send a test. Restaurant product docs do **not** ship a WhatsApp channel. WhatsApp in this repository is a pharmacy consent and ordering seam. A restaurant build assumption lists WhatsApp as a future provider choice, not a current feature.
14. **Cameras.** `/restaurant/integrations/cameras` requires `restaurant-integrations`. Gateways are chosen by name.
15. **Revocation.** Platform suspension or termination must stop tenant sign-in. Disabling POS must reject a trusted device with 403. Device revoke requires a second approver. Lost PINs are reset, not disclosed.

## Data the restaurant owns

Prisma models (not exhaustive) cover branches and assignments, staff profiles, operator credentials, devices, terminal sessions, co-authorization, brands, categories, products, variants, modifiers, combos, units, allergens, ingredients, recipes and substitutes, price lists, menus and publications, floors, tables, server sections, kitchen stations, print routes and jobs, orders and items, kitchen tickets, bills, payments, tenders, refunds, service charge, drawers, daily close, tax profiles and snapshots, customers and loyalty, inventory movements, purchasing, SOP templates and occurrences, notification webhooks, delivery zones, catering orders, cameras, and wallet passes.

Orders are branch-scoped. Fired item names and prices are snapshotted so a later catalog edit does not rewrite an open ticket. Terminal mutations require an idempotency key. Unknown JSON fields are rejected. Cross-tenant identifiers are specified to behave as not found.

## Security boundaries QA must hold

- Unauthenticated calls to `/api/restaurant/*` and `/api/trpc/restaurant*` fail.
- A platform cookie is not a tenant session, and a tenant cookie is not a platform session.
- An agency user cannot read or write restaurant rows. A restaurant user cannot read pharmacy clinical or another restaurant's rows.
- RLS is forced. Tests that connect as superuser do not prove isolation.
- Job-role PINs cannot create a web session.
- Receipts must not echo PAN, CVV, or track data. Card tender must not be described as an authorization.
- XSS payloads in names (products, customers, notes) must render as text.
- Internal database ids are not an operator step. A screen that demands one is specified as **NOT OPERATOR READY**.

## Known product limits (not defects unless the UI claims otherwise)

- Card acquiring, fiscal devices, physical printers, marketplace delivery, and rider logistics are out of this release.
- Offline POS may queue a new non-delivery order and added items only. Checkout, tenders, refunds, drawers, customers, loyalty, and delivery stay connected-only.
- KDS is connected-only. A disconnect keeps the last confirmed state and offers retry.
- Billing-provider proration and cross-realm SSO from the platform desk into a restaurant are not implemented.
- The sales demo at `/demo/restaurants` is a separate seeded seat with seven personas. It is disabled unless `DEMO_ACCESS_CODE` is set. This QA pass uses a real onboarded tenant, not the demo.

## Workspace map exercised by QA

Sidebar restaurant entries in `src/components/layout/sidebar.tsx`: Point of sale, Kitchen display, Floor, Orders, Catering, Finance & reconciliation, Inventory, Purchasing, SOP board, SOP reports, SOP admin, SOP oversight, Restaurant staff, Roster, Tax, Branches, Delivery, Restaurant devices, Cameras, Catalog, Menus, Offers, Notifications, Customers & Loyalty, Reports, Advanced Insights.

Pages that exist without a sidebar entry include `/restaurant/menu-import`, `/restaurant/growth`, and `/restaurant` (the restaurant home) plus `/restaurant/settings/cameras/privacy`.

Shared workspace entries (dashboard, projects, clients, notes, meetings, chat, finance, team, settings) still exist for a restaurant organization because the shell is one product family. Whether pharmacy and hotel links leak into a restaurant shell is an explicit isolation case. An older issue (`#59`) already reports pharmacy links on a restaurant administrator's navigation.
