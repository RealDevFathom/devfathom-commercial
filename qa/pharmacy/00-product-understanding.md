# Pharmacy vertical — product understanding

QA branch: `qa/pharmacy-restaurants-agencies`  
Commit under test: `fa3658b715bf2e672f7e38f983b558d8d86b5a75` (`fa3658b7`)  
Cut from: `integration/consolidation-20261019`  
Written from repository evidence on 2026-10-21. This is a tester’s map of the product as it exists in this tree, not a commercial claim.

## What DevFathom is

DevFathom Commercial is a multi-tenant web workspace (Next.js 16 App Router, React 19, tRPC v11, Prisma 7, PostgreSQL, NextAuth v5, Bun 1.3.14). One database holds every tenant. Tenant tables use forced row-level security. A seller-operated **platform control desk** creates organizations, assigns packages, and activates them manually. Customers do not self-serve signup.

Three hosts matter locally (`PLATFORM_BASE_DOMAIN=localhost`):

| Host | Role |
| --- | --- |
| `http://admin.localhost:3000/platform` | Super-admin control desk |
| `http://<slug>.localhost:3000` | That organization’s tenant workspace |
| `http://devfathom.localhost:3000` | Seeded DevFathom agency (`slug=devfathom`), not a pharmacy |

Shared-host login (ADR-003) exists for production (`www` / `staging`). Local pharmacy QA uses the slug host, which classifies as `{ kind: 'tenant', slug }` in `src/lib/tenancy/host-routing.ts`.

## Pharmacy as a vertical

Organization vertical `PHARMACY` is defined in `src/lib/vertical-catalog.ts`. Description: “Counters, dispensing, inventory, procurement, safety, and reporting.”

It is a Pakistan-oriented retail pharmacy operating system:

- First branch is created at onboarding with a street, city, and a Pakistan province code (`PK-PB`, `PK-SD`, `PK-KP`, `PK-BA`, `PK-ICT`, `PK-GB`, `PK-AJK`). The stable branch code is `MAIN`.
- Regulatory readiness is licence + qualified person + published jurisdiction rules (`src/lib/pharmacy/regulatory.ts`). Punjab rules are treated as provisional in existing lifecycle tests (`RULE_SET_UNCONFIRMED`).
- Money in inventory UI is displayed as PKR minor units (`src/app/(app)/pharmacy/inventory/page.tsx`).
- Clinical surfaces cover prescriptions, pharmacist review, substitution, controlled-substance register, FEFO lot allocation, recalls, and cold chain.

The vertical cannot be changed after activation (copy on `/platform/organizations/new`).

## Commercial packages and modules

Packages (`PHARMACY_PACKAGES`):

| Package | Modules | Default limits (branches / counters / users) |
| --- | --- | --- |
| Pharmacy Essentials | core, counter, inventory, procurement, finance, reports | 1 / 2 / 10 |
| Pharmacy Professional | Essentials + dispensing, safety, CRM | 5 / 10 / 50 |
| Pharmacy Chain | all pharmacy modules | 100 / 500 / 2500 |

Module keys:

`pharmacy-core`, `pharmacy-counter`, `pharmacy-inventory`, `pharmacy-procurement`, `pharmacy-dispensing`, `pharmacy-safety`, `pharmacy-finance`, `pharmacy-reports`, `pharmacy-crm`.

`pharmacy-core` is mandatory and cannot be disabled. Entitlement order (`src/lib/entitlements.ts`, `docs/admin-platform/entitlements.md`): organization override > live contract > package default > disabled. Sidebar hiding is not an authorization boundary. tRPC `requireLicensedModule` and route `ModuleBoundary` are.

`prisma/seed.ts` calls `syncPlatformCatalog`, which creates pharmacy packages on a fresh database (`prisma/catalog-sync.ts`). If that sync did not run, the onboarding form shows “No commercial package available” and refuses to create a pharmacy.

## How a super admin onboards a pharmacy

Platform identity is separate from tenant users. Seed writes a `platformUser` with role `SUPER_ADMIN` from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD` (`prisma/platform-admin.ts`).

1. Sign in at `/platform/login` on `admin.localhost`.
2. Open `/platform/organizations/new`. Step 1 lists verticals with nothing preselected. “Continue as Pharmacy” sets `?vertical=PHARMACY`.
3. Step 2 submits `organization.create` through `PlatformCommandForm` to `/api/platform/control`. Required pharmacy fields include display name, legal name, slug, deployment mode (shared by default; dedicated only if Vercel provisioning is configured), package, seat limit, currency (default USD), timezone (default **UTC** for pharmacy; restaurant and hospitality default to `Asia/Karachi`), first branch name/address/city/province, locale, primary contact, tenant administrator name/email, and a temporary password of at least 12 characters.
4. `bootstrapOrganization` in `src/lib/platform/commands.ts` creates:
   - `Organization` with `vertical=PHARMACY`, `status=ONBOARDING`
   - bootstrap user `role=ADMIN` and organization role `admin` with capability `*`
   - `PHARMACY_ROLE_TEMPLATES` (below)
   - `pharmacyBranch` code `MAIN` with the premises entered (no regulatory profile yet)
   - package entitlements inherited from `platform_package_modules` (not copied onto the org)
   - a pending production deployment and a `PROVISION_SHARED` or `PROVISION_DEDICATED` job
5. The operator lands on `/platform/organizations/[id]`. Modules can be enabled, disabled, trialed, or expired (`organization.module`). Mandatory core cannot be turned off. A package from another vertical is rejected.
6. Activation to `ACTIVE` is manual via `organization.transition` (payload `id`, `status`, `reason`). `assertActivationReady` requires a package, an active administrator, and a READY production deployment. Pharmacy additionally requires an in-force `BranchRegulatoryProfile` that `assertStoredBranchMayOperate` accepts, and `evaluatePharmacyReadiness` with every P0 gate `PASSED`. `organization.update` is the profile edit. A QA call that sent `status: ACTIVE` on `organization.update` returned HTTP 200 and left the row `ONBOARDING` with `updatedAt` unchanged.

Lifecycle states that may sign in: `ONBOARDING`, `ACTIVE`, `GRACE`. `SUSPENDED` and `TERMINATED` block tenant authentication (`docs/admin-platform/lifecycle.md`). Revocation under test is: disable a non-mandatory module, and/or suspend or terminate the organization.

## The twelve onboarding gates (PLAT-03)

`/pharmacy` renders `PharmacyOnboardingConsole`. Readiness is recomputed; a seeded `PASSED` row is not enough (`src/lib/pharmacy/onboarding.ts`).

| Step | Gate | How it passes |
| --- | --- | --- |
| 1 | Organization type | Attested. Needs evidence reference + actor. No backing surface yet. |
| 2 | Legal business | Attested. |
| 3 | Launch jurisdiction | Attested. |
| 4 | Premises and licences | Evidence. In-force regulatory profile that may operate, including a qualified person. |
| 5 | Branches and locations | Attested. The MAIN branch already exists, but the gate is still attested. |
| 6 | Commercial package | Evidence. Package vertical is PHARMACY. True immediately after a valid create. |
| 7 | Owner and role templates | Evidence. All pharmacy role templates except optional `owner-operator` exist. True immediately after create. |
| 8 | Medicine catalog readiness | Evidence. A published publication batch with an accepted or corrected, reviewed, saleable medicine. |
| 9 | Opening stock readiness | Evidence. At least one inventory lot with `receivedAt` set. |
| 10 | Parties and balances | Evidence. At least one supplier that is `authorized` and `active`. |
| 11 | Devices and documents | Attested. |
| 12 | Readiness and parallel run | Attested. |

Six gates have no product surface yet and stay `NOT_STARTED` until an administrator attests them with an evidence reference. The product comment states this is intentional so activation stays fail-closed. A first-run dashboard checklist (`PHARMACY_FIRST_RUN_CHECKLIST`) is a shorter cousin: branch, staff/roles, optional counter device, catalog + opening stock, optional tax, first test sale.

## Tenant first login

The administrator signs in at `http://<slug>.localhost:3000/login` with the email and temporary password from the create form. Session is NextAuth. The `(app)` layout resolves entitlements. Until the org is `ACTIVE`, some operations stay limited by lifecycle and by the regulatory guard, but `ONBOARDING` is an allowed authentication state.

There is no separate “set a new password” step described in the create flow; the temporary password is the login password.

## Roles and who can do what

Templates in `PHARMACY_ROLE_TEMPLATES`:

| Key | Capabilities stored |
| --- | --- |
| owner | `pharmacy.*`, `pharmacy:orders` |
| owner-operator | `reports:operational`, `reports:financial`, `pharmacy:orders`, `pharmacy:dispense`, `pharmacy:catalogue-review`, `pharmacy:safety` |
| pharmacist | `pharmacy.dispense`, `pharmacy:catalogue-review` |
| manager | `pharmacy.manage`, `pharmacy:orders` |
| cashier | `pharmacy.counter`, `pharmacy:orders` |
| procurement | `pharmacy.procurement` |
| inventory | `pharmacy.inventory` |
| finance | `pharmacy.finance` |
| auditor | `pharmacy.audit` |

The bootstrap administrator is a separate `admin` role with `*` plus `User.role=ADMIN`. Several pharmacy pages are `adminOnly` in the sidebar (onboarding, medicines, finance, cameras, loyalty, marketing, regulatory).

ABAC procedures check colon actions (`pharmacy:dispense`, `pharmacy:safety`, `pharmacy:catalogue-review`, `pharmacy:orders`, `reports:operational`, `reports:financial`, `admin:access`). Wildcard matching in `src/lib/abac/index.ts` understands `*` and `prefix:*`. It does **not** treat `pharmacy.*` as a match for `pharmacy:dispense`. Dot capabilities (`pharmacy.dispense`, `pharmacy.counter`, `pharmacy.manage`, …) are therefore not the same strings the routers check. Only `admin` (`*`), `owner-operator` (explicit colon grants), and any role later edited to add colon capabilities line up with procedure checks. This is a primary permission-isolation risk.

Departments seeded for a pharmacy: Counter, Dispensary, Store, Procurement, Finance, Compliance.

## Tenant surfaces a tester must walk

Sidebar group **Pharmacy** (`src/components/layout/sidebar.tsx`). Module ownership comes from the item or from `moduleForPath`.

| Path | What the operator does |
| --- | --- |
| `/dashboard` | Pharmacy dashboard and first-run checklist |
| `/pharmacy` | Twelve-gate onboarding |
| `/pharmacy/regulatory` | Save licence, qualified person, premises, fiscal fields |
| `/pharmacy/medicines` | Medicine reference connectors (not a simple product form) |
| `/pharmacy/medicines/prices` | Price intelligence |
| `/pharmacy/medicines/staged` | Staged migration review |
| `/pharmacy/counter` | POS: search/scan, cart, FEFO, tender, drawer, prescriptions, returns, khata, loyalty, discounts |
| `/pharmacy/counter/close` | Day close |
| `/pharmacy/inventory` | Locations, lots, receive, counts, adjustments, recalls |
| `/pharmacy/inventory/expiry` | Expiry board |
| `/pharmacy/inventory/transfers` | Inter-branch transfers |
| `/pharmacy/inventory/imports` | Opening / imported stock |
| `/pharmacy/purchasing` | Purchasing overview |
| `/pharmacy/purchasing/suppliers` | Suppliers and licences |
| `/pharmacy/purchasing/orders` | Requisitions, quotes, purchase orders |
| `/pharmacy/purchasing/receiving` | Goods receipts |
| `/pharmacy/purchasing/returns` | Supplier returns and debit notes |
| `/pharmacy/finance` | Bookkeeping, periods, bank rec, tax profile |
| `/pharmacy/reports` | Command centre, anomalies, expiry advice, owner digest |
| `/pharmacy/reports/replenishment` | Replenishment scenarios |
| `/pharmacy/reports/repeat-purchasing` | Repeat-purchase cohorts |
| `/pharmacy/reports/supplier-credit-follow-up` | Supplier credit follow-up |
| `/pharmacy/orders` | Staff queue for customer / WhatsApp orders |
| `/pharmacy/prescriptions` | Patient and prescription capture |
| `/pharmacy/pharmacist-queue` | Pharmacist review |
| `/pharmacy/substitution` | Substitution records |
| `/pharmacy/controlled-register` | Controlled register and incidents |
| `/pharmacy/loyalty` | Points ledger |
| `/pharmacy/marketing` | Segments, templates, campaigns |
| `/pharmacy/cameras` | Simulated camera enrollment only |
| `/pharmacy/settings/cameras/privacy` | Camera privacy |
| `/organization` | Staff and roles (first-run checklist target) |
| `/team` | People |
| `/settings`, `/settings/modules`, `/settings/receipts` | Workspace settings |

Commercial module route prefixes include `/pharmacy/procurement`, `/pharmacy/dispensing`, `/pharmacy/safety`, and `/pharmacy/crm`. The real pages live under `/pharmacy/purchasing`, `/pharmacy/prescriptions`, `/pharmacy/controlled-register`, and `/pharmacy/marketing`. Those prefix paths are candidates for dead ends.

## Domain model (what data isolation must hold)

All pharmacy business rows are organization-scoped; branch-owned rows use a composite `(organizationId, branchId)` foreign key to `PharmacyBranch`. Representative models in `prisma/schema.prisma`:

- Onboarding and regulatory: `PharmacyOnboardingState`, gate states, `BranchRegulatoryProfile`, `JurisdictionRuleSet`
- Catalog: ingredients, medicines, packs, barcodes, publication batches, price notices
- Inventory: manufacturing batches (`batchNumber`, `expiresAt`), lots, locations, movements, balances, counts, transfers, recalls, temperature logs
- Purchasing: suppliers, licences, requisitions, quotes, purchase orders, goods receipts, receiving exceptions, purchase returns, supplier credits, tokenized supplier portal
- Sales: sales, lines, FEFO allocations, tenders, refunds, drawer sessions, daily close, receipt sequences
- Customers: `PharmacyCustomer`, patients, family/khata, loyalty, customer orders, message log
- Clinical: prescribers, pharmacist review, substitutions, controlled register, pharmacovigilance
- Finance: bookkeeping transactions, periods, settlement, tax profiles
- Offline devices and migration staging

RLS policies set `app.current_organization_id` via `withTenantDb`. Platform catalog reads use `withPlatformDb`. `tests/pharmacy-medicine-rls.test.ts` is the existing cross-org regression for medicine tables.

## POS, returns, discounts, customers, WhatsApp

Counter (`PharmacyCounterConsole`) is the billing surface:

- Search by brand, generic, ingredient, strength, form, barcode, alias
- Cart with FEFO allocation and a discount total (`discountKind`: `DISCOUNT`, `PROMOTION`, `COMPLIMENTARY`; `discountMinor` on `pharmacySales`)
- Tender panel and receipt
- Return and refund history (`CounterReturnPanel`, `pharmacySales.refundTender`)
- Customer attach, khata statement, loyalty redeem
- Prescription photo and controlled-medicine authorization; Rx/controlled paths also require `pharmacy:dispense`

Customer orders (`/pharmacy/orders`) are proposals until staff accept them. WhatsApp inbound is `POST /api/pharmacy/whatsapp/webhook` (Meta signature, tenant by host) plus refill reminders at `/api/pharmacy/whatsapp/reminders`. Owner digest on reports explicitly describes WhatsApp as a P0-lite stub that does not send (`src/app/(app)/pharmacy/reports/page.tsx`).

Supplier portal procedures on `pharmacySupplierLinks` include `publicProcedure` token routes (`get`, `submit`, `uploadDocument`). Those are an unauthenticated surface and must be tested for token scope.

Offline counter REST (`/api/pharmacy/counter/establish|lease|quota|replay|snapshot`) authenticates a registered device, not a browser session.

## Known product limits already written in code

These are expected behavior to confirm, and defects if the UI pretends otherwise:

- Six onboarding gates have no backing product surface.
- Cameras are diagnostic simulators (`sim-camera-1`), not live hardware.
- Prescription OCR can return “Prescription reading is not enabled for this workspace.”
- WhatsApp owner digest does not send messages.
- Controlled-register pharmacist lookup reads `restaurantStaffProfile` (cross-vertical seam).
- Dot capabilities vs colon ABAC actions (see roles).
- Pharmacy create form defaults timezone to UTC while premises are Pakistani provinces.
- Currency field defaults to USD while inventory copy formats PKR.
- Demo seed runner (`scripts/seed-pharmacy-demo.ts`) is a disposable evidence harness, not the customer onboarding path. Do not treat it as the product under test.

## Design contract the UI is judged against

`docs/design-system/DEVFATHOM-STUDIO.md` is the visual source of truth. Tenant and platform are one family: fog surround, paper workspace, ink type, scarce coral, hairline borders, semantic tokens in `src/app/globals.css`. Text tokens are claimed at WCAG AA 4.5:1. QA looks for a second visual language, unlabeled controls, contrast failures, and copy that leaks schema names (`PK-PB`, `NOT_STARTED`) to operators. Province names are supposed to be human labels (`provinceName`).

## Seed and local accounts

`bun run db:seed` creates the DevFathom agency, modules, pharmacy/restaurant/hospitality catalog packages, demo agency users (`alex@company.com`, `jordan@company.com`, password `SEED_PASSWORD`), and the platform super admin. It does not create a pharmacy tenant. Pharmacy customers under test are created through the control desk.

## Out of scope for this pass

Restaurant, hospitality, and agency workflows are out of scope except where they leak into a pharmacy session (wrong nav, wrong data, shared auth bugs). No product code will be changed by this QA pass.
