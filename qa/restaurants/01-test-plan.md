# Restaurant vertical — test plan

Commit under test: `fa3658b715bf2e672f7e38f983b558d8d86b5a75` (`qa/pharmacy-restaurants-agencies`).
Product model: `qa/restaurants/00-product-understanding.md`.
Cases: `qa/restaurants/02-test-cases.md`.

## Objective

Prove or disprove that a platform super admin can create a restaurant customer, grant restaurant access, and that the tenant can run outlet setup through service, money, stock, guests, reports, notifications, settings, and revocation, without leaking another tenant's or another vertical's data, and without broken empty, error, permission, or security behavior.

QA does not fix product code.

## Environment

| Item | Value |
| --- | --- |
| Host | Cloud agent VM, Linux |
| App | Next.js 16.2.12 dev server, `bun run dev --hostname 0.0.0.0 --port 3000` |
| Database | PostgreSQL 16.15, database `devfathom`, migrations applied after `prisma/prepare-extensions.ts` |
| Seed | `bun run db:seed` (agency workspace + platform catalog + platform admin). No restaurant row. |
| Tenant URL | `http://devfathom.localhost:3000` |
| Platform URL | `http://admin.localhost:3000` |
| Browser | Playwright Chromium 151 |
| API | Same origin, cookie sessions, plus unauthenticated `curl` |
| Integrations | No Resend, Ably, Vercel, LiveKit, Azure storage, or WhatsApp provider. Empty states and explicit failures are in scope. Silent success is not. |
| Card and print | Mock tender and simulated print bridge only. A claim of live authorization or paper output is a defect. |

Setup notes, including the failed first migrate, are in the execution report.

## Method

1. Read the administrator guide and catalog, then drive the real UI. Do not seed restaurant rows by SQL.
2. Platform operator creates **QA Karahi House** on Restaurant Enterprise (all modules, room for a second branch) and a second organization **QA Karahi Essentials** on Restaurant Essentials where a limit must be proven.
3. Complete readiness acknowledgements, shared deployment, and manual activation.
4. Sign in as the tenant administrator on the shared host and walk every restaurant route at 1440×900. Repeat the shell, catalog, POS, and orders at 390×844.
5. Create catalog, modifiers, a recipe skeleton, a menu publication, a floor and table, staff, and a delivery zone through the UI where the controls exist. Use authenticated tRPC or restaurant REST only to confirm what the UI persisted, to probe authorization, and to reach terminal commands the browser enrollment flow exposes.
6. Enroll a POS browser and a KDS browser only after back-office evidence is captured, because enrollment ends the web session.
7. Run axe (WCAG 2 A/AA) on the primary screens. Record serious and critical violations. Record console errors and failed document requests.
8. Security probes: no cookie, platform cookie on tenant APIs, tenant cookie on platform APIs, cross-tenant ids, XSS strings stored and re-rendered, injection strings in search and create fields, suspended-organization login.
9. Search GitHub for an existing open issue, including Pharmacy QA issues, before filing. Comment on a duplicate. New issues use `[QA][Restaurants][SEV]` and labels `qa`, `restaurants`, and `sev1-critical` … `sev4-trivial`, plus `ux`, `security`, or `a11y` when they apply.

## Priorities

| Priority | Meaning |
| --- | --- |
| P0 | Onboarding, activation, tenant isolation, payment integrity, authz bypass |
| P1 | Core service path: menu, orders, kitchen, bill, refund, stock, roles |
| P2 | Reports, loyalty, SOP, notifications, tax, catering, delivery, settings |
| P3 | Copy, visual polish, non-blocking empty-state wording, performance smoke |

## Coverage matrix

| Area | Case prefix | Depth |
| --- | --- | --- |
| Environment and setup | SET | Fresh migrate, seed, both hosts, MFA |
| Super admin onboarding and entitlements | ONB | Type-first create, package mismatch, module grant |
| Activation, suspend, revoke | LCY | Readiness, gates, suspend, terminated login |
| Branches and outlet limits | BRN | Create, primary, deactivate, essentials cap |
| Users, org roles, job roles, PINs | STF | Least privilege, deny, branch scope |
| Catalog, modifiers, pricing, publish | CAT, MNU | Validation, XSS, two-decimal prices |
| Floor and tables | FLR | Floor, table, move/merge availability |
| Orders: dine-in, takeaway, delivery | ORD | Channels, customer and zone rules |
| Kitchen | KDS | Fire, queue, bump, recall, station |
| Billing, splits, tips, discounts, refunds | PAY | Caps, manager co-auth, mock card disclosure |
| Customers and loyalty | LOY | Attach, earn, redeem, tenant scope |
| Inventory, recipes, purchasing | INV | Units, wastage, PO lifecycle |
| Catering | CATR | Status order, cost, stock post |
| Reports and insights | RPT | Permission split, empty vs zero, CSV |
| Notifications and WhatsApp | NTF | Webhook contract, absent or honest WhatsApp |
| Settings, tax, devices, cameras | CFG | Tax profile, device enroll, camera gate |
| Access revocation | REV | Suspend, module off, device revoke |
| Permissions and role isolation | PERM | Cashier, kitchen, accountant, server |
| Multi-tenant leakage | TNT | Agency vs restaurant, two restaurants, pharmacy nav |
| Validation and edge cases | VAL | Required, length, money, idempotency |
| Empty, loading, error | STA | First-run screens, failed mutations |
| UI, copy, responsive, a11y | UX, A11Y | Shell, 390px, axe, focus |
| Security | SEC | Authn, IDOR, XSS, injection, platform/tenant realm |
| Performance smoke | PERF | Warmed route timing |

## Entry and exit

Entry: migrations applied, seed complete, both login pages return HTTP 200.

Exit: every case in `02-test-cases.md` has a status of pass, fail, or blocked with a reason. Every fail has a GitHub issue or a comment on an existing issue. The execution report states a release recommendation.

Blocked is allowed only when a dependency the product itself does not provide stops the case (for example live card capture, a physical printer, or an external WhatsApp provider that was never built). A missing control on a screen the guide says exists is a fail, not a block.

## Defect severity

| Label | Use |
| --- | --- |
| `sev1-critical` | Cross-tenant data exposure, unauthenticated money or order mutation, payment integrity that loses or invents money, activation that cannot be completed on the documented path |
| `sev2-major` | A primary journey step is wrong or unreachable, role bypass, misleading financial or tax success, setup guide that cannot boot the app |
| `sev3-minor` | Wrong empty/error copy, inconsistent layout, a secondary flow that fails with a clear recovery |
| `sev4-trivial` | Typos, spacing, non-blocking wording |

## Risks to the test itself

- Next.js dev compile makes the first hit of each route slow. Performance numbers are warmed second loads, not cold compiles.
- Enrollment destroys the admin browser session. POS and KDS run last, in separate contexts.
- Platform MFA enrollment changes the super-admin account for this database. That is local only.
- Pharmacy QA may file shared shell bugs during this run. Search immediately before each `gh issue create`.
- No email provider, so invite links and webhook delivery to the public internet are observed locally or recorded as blocked only after the UI is shown to require them.

## Evidence

Screenshots and the machine log live under `qa/restaurants/evidence/`. The log is the pass/fail source for the execution report. Screenshots are supporting evidence, not a substitute for exercising the control.
