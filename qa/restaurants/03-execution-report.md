# Restaurant QA execution report

Branch `qa/pharmacy-restaurants-agencies`, commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. Executed 2026-10-21 on a local VM (Bun 1.4.3, Next.js 16.2.12, PostgreSQL 16, Playwright Chromium). Tenant hosts `qa-karahi-house.localhost` and `qa-karahi-essentials.localhost`. Platform host `admin.localhost`. Agency host `devfathom.localhost` (a tenant host for slug `devfathom`, not a shared login host).

Product source was not modified. GitHub issue creation returned HTTP 403 for this token, so each defect is a markdown file under `qa/restaurants/issues/`. The title is the first line and the labels are the second line. Nothing in those files is a product fix.

## Recommendation

**Do not ship the restaurant vertical.** Four defects block a release:

1. A restaurant tenant can read another restaurant's catalog on the documented superuser database connection (`issues/001-catalog-cross-tenant.md`).
2. The register summary hides tax, then shows nothing due while the bill is still open, so a cashier who collects the displayed total undercharges (`issues/002-register-hides-tax.md`).
3. Restaurant page reads die inside an audit transaction and can wedge Postgres and the dev server (`issues/003-audit-transaction-timeout.md`).
4. Refunds and comps cannot be approved, because co-authorization ignores job roles and the restaurant administrator cannot invite a second web user (`issues/004-refund-coauth-unreachable.md` and `issues/005-invite-blocked-by-hr-module.md`).

## Counts

109 cases in `qa/restaurants/02-test-cases.md`.

| Verdict | Count |
| --- | ---: |
| Pass | 62 |
| Fail | 14 |
| Blocked | 7 |
| Not run | 26 |

76 cases reached a pass or fail (70%). 62 of those 76 passed.

New issue files: 14. Severity of those files: 4 critical, 5 major, 5 minor, 0 trivial. One fail (SET-01) is an existing pharmacy issue and was not refiled. One fail (STF-03) includes an instance of existing issue #15, which was not refiled; the restaurant-specific half of STF-03 is in the invite issue.

## Issues filed as markdown

GitHub filing was not possible (HTTP 403 on issue create, labels, and comments). Paths below are what to file. Labels on the second line of each file include `ux`, `security`, or `a11y` where they apply, including labels that do not exist yet.

| Sev | File | Case |
| --- | --- | --- |
| SEV1 | `qa/restaurants/issues/001-catalog-cross-tenant.md` | TNT-03 |
| SEV1 | `qa/restaurants/issues/002-register-hides-tax.md` | PAY-01, PAY-03 |
| SEV1 | `qa/restaurants/issues/003-audit-transaction-timeout.md` | workspace reads |
| SEV1 | `qa/restaurants/issues/004-refund-coauth-unreachable.md` | PAY-06 |
| SEV2 | `qa/restaurants/issues/005-invite-blocked-by-hr-module.md` | STF-02, STF-03 |
| SEV2 | `qa/restaurants/issues/006-duplicate-slug-500.md` | ONB-05 |
| SEV2 | `qa/restaurants/issues/007-tender-without-tax-profile-500.md` | PAY-03 first attempt |
| SEV2 | `qa/restaurants/issues/008-pos-module-disable-ignored.md` | REV-01 |
| SEV2 | `qa/restaurants/issues/009-wrong-host-session.md` | extra finding |
| SEV3 | `qa/restaurants/issues/010-webhook-http-500.md` | NTF-01 |
| SEV3 | `qa/restaurants/issues/011-menu-import-not-in-navigation.md` | MNU-04 |
| SEV3 | `qa/restaurants/issues/012-mfa-setup-undocumented.md` | SET-03 |
| SEV3 | `qa/restaurants/issues/013-notifications-contrast.md` | A11Y-01 |
| SEV3 | `qa/restaurants/issues/014-trpc-error-stacks.md` | UX-03 |

## Pass

SET-02. ONB-01, ONB-02, ONB-03, ONB-04, ONB-06, ONB-07. LCY-01, LCY-02, LCY-03, LCY-04, LCY-05, LCY-06. BRN-01, BRN-02, BRN-03, BRN-04, BRN-05. STF-01. CAT-02, CAT-03, CAT-04, CAT-05, CAT-06, CAT-07. MNU-02, MNU-03. FLR-02, FLR-03. ORD-02, ORD-03, ORD-04, ORD-05, ORD-06. KDS-02. PAY-02. LOY-01, LOY-02, LOY-03, LOY-04. INV-01, INV-02, INV-04, INV-05. CATR-01. RPT-02, RPT-03, RPT-04. NTF-02, NTF-03. CFG-01, CFG-02, CFG-03, CFG-05. SEC-01, SEC-02. TNT-01, TNT-02, TNT-04. VAL-01. UX-02. PERF-01.

Notes on passes that are narrower than the written case:

- ORD-05: moving a party succeeded. Merging tables was not attempted.
- PAY-02: split by item and by seat both returned two bills. A fractional split was not executed.
- LOY-03: configure, enroll, and adjust succeeded on Enterprise. Redemption was not executed.
- CFG-03: `/restaurant/cameras` returned 200. Entitlement behavior past the page load was not proven.
- UX-02: the dashboard at 390×844 did not overflow (`documentElement.scrollWidth`). Navigation, catalog, orders, and onboarding were not checked at that width.
- LCY-06: suspending QA Karahi Essentials kept the owner on `/login`. The organization was resumed and left ACTIVE.
- REV-01's module was re-enabled and left ENABLED. The disable result is the fail below, not a leftover disabled module.
- NTF-03 is a pass. The notifications page states that WhatsApp is unavailable. That is the shipped behavior, not a defect.
- TNT-02 is a pass. Restaurant navigation did not include pharmacy Onboarding, Counter, or Regulatory. Closed issue #59 was not reproduced on this commit.
- BRN-01 was rechecked after the audit outage. `/restaurant/settings/branches` showed QA Karahi House, Ayesha Khan, and Clifton. Screenshots taken during the outage that look like missing buttons are the audit failure, not missing controls.
- ONB-02 is a pass. An early runner marked it fail because a dedicated-deployment control was hidden. That control is correctly hidden for the shared path.

## Fail

| Case | Why | Issue |
| --- | --- | --- |
| SET-01 | `prisma migrate deploy` on an empty database stops at `20260830120000_btree_gist_public_execute_acl` until `prisma/prepare-extensions.ts` runs. `docs/LOCAL_SETUP.md` does not mention that step. `docs/demo-restaurants.md` does. | Existing #126. Not refiled. Comment draft below. |
| SET-03 | MFA enrollment works and is not described in `docs/LOCAL_SETUP.md`. | `issues/012-mfa-setup-undocumented.md` |
| ONB-05 | Duplicate slug returns HTTP 500 `The platform command could not be completed.` One row remains. An early runner marked this pass; the note is the failure. | `issues/006-duplicate-slug-500.md` (related to #14, distinct) |
| STF-02 | `team.inviteMember` returns 403 `The HR module is not enabled for this organization.` | `issues/005-invite-blocked-by-hr-module.md` |
| STF-03 | Same invite 403, so kitchen and server web users were never created. A create call that sent `userId: ""` also returned the raw Prisma foreign-key text. | Invite half: `issues/005-invite-blocked-by-hr-module.md`. Prisma text: existing #15, comment draft below. |
| PAY-01 | Checkout summary does not disclose the 15% exclusive tax before collection. | `issues/002-register-hides-tax.md` |
| PAY-03 | Tendering the displayed 970.00 left 145.50 due. The following summary said remaining due 0.00 while the bill stayed OPEN. Tendering that 0.00 was rejected. An explicit 145.50 settled it (receipt 1). Card 120.00 left 18.00 due. The first attempt, before any tax profile existed, was HTTP 500. | `issues/002-register-hides-tax.md` and `issues/007-tender-without-tax-profile-500.md` |
| PAY-06 | Refund and comp with a distinct PIN manager who holds the Owner job role returned 403 `The approving manager lacks the "coauth:approve" capability.` | `issues/004-refund-coauth-unreachable.md` |
| MNU-04 | `/restaurant/menu-import` renders an upload console and is absent from the sidebar. | `issues/011-menu-import-not-in-navigation.md` |
| NTF-01 | `http://example.com/hook` returned HTTP 500 `Webhook endpoint must use HTTPS.` Blank URL was 400. HTTPS save and test were 200 (NTF-02). | `issues/010-webhook-http-500.md` |
| REV-01 | Disabling `restaurant-pos` left `GET /pos` at HTTP 200 with the register shell. The module was re-enabled immediately. Terminal commands were not called while it was disabled. | `issues/008-pos-module-disable-ignored.md` |
| TNT-03 | The Essentials session listed and fetched House products (Chicken Karahi, Garlic Naan) owned by organization `cmvhhcld5000g1yjsl1lp4a8v`. | `issues/001-catalog-cross-tenant.md` |
| UX-03 | A correct 403 (`Your plan supports 1 active branch.`) included `data.stack` with a `/workspace/.next/dev/server/chunks/` frame. | `issues/014-trpc-error-stacks.md` |
| A11Y-01 | axe `wcag2a`/`wcag2aa` on `/restaurant/notifications` reported one serious color-contrast node. The other pages named in the case were not scanned. | `issues/013-notifications-contrast.md` |

Extra finding, no case id: a restaurant administrator rendered inside the agency host dashboard (`issues/009-wrong-host-session.md`). A later retry stayed on the agency login page. The report claims the first screenshot, not the retry.

## Blocked

REV-02, REV-03, PERM-01, PERM-02, PERM-03, PERM-04, and VAL-02. All of them need a second web user or a linked approver. Invite is rejected because the HR module is not enabled (STF-02), and a PIN-only Owner job role cannot co-approve (PAY-06). Device revoke uses the same co-authorization check, so REV-02 was not forced through SQL.

## Not run

STF-04, STF-05, STF-06. CAT-01. MNU-01, MNU-05 (the offers page returned 200; the 150% discount rule was not executed). FLR-01. ORD-01. KDS-01, KDS-03, KDS-04. PAY-04 (the card API tender works and is labeled mock in product docs; the register UI copy was not read). PAY-05. PAY-07 (the money page loads; figures were not reconciled to tenders). PAY-08 (day-close preview returned 200 and close returned 409 while bills were open; counted cash and drawer close were not completed, and the business day was left open). INV-03. CATR-02. RPT-01. CFG-04. REV-04 (terminate was not sent; the enterprise tenant must stay). TNT-05 (order id probing was not run as its own case; the catalog leak is TNT-03). STA-01, STA-02. UX-01. A11Y-02. SEC-03 (a platform cookie against tenant tRPC returned 401 and is recorded as TNT-04; the tenant cookie against `/api/platform/control` was not retested).

Empty-state cases (CAT-01, MNU-01, FLR-01, ORD-01) were not valid: the tenant already had data.

STF-06's empty staff id was a test-client mistake (the procedure correctly returned 400 for an empty id). It is not a product defect and is not filed.

## False results that are not defects

- POS HTTP 401 `Missing or malformed terminal session token` from `APIRequestContext` after enroll, or from a harness that redacted the session token before parsing it. The product call requires the device cookie and `x-terminal-session`. Those 401s are not filed.
- NTF-03 WhatsApp. The page says the channel is unavailable.
- Catalog and branches screenshots taken while the audit transactions had wedged the server. After restart, both pages rendered.
- Cash tenders reject `tipAmount` (`CASH_TIP_UNSUPPORTED`). The UI was not observed offering a cash tip, so that rejection is not filed.

## UX assessment

The restaurant shell is one product with the rest of the workspace: numbered sidebar, one page heading, and the same sign-in form (`input[name=email]`, password, "Sign in"). On the slug host, catalog, menus, floor, orders, loyalty, inventory, purchasing, catering, money, cameras, notifications, devices, tax, branches, reports, insights, and growth all rendered for the Enterprise administrator once the server was healthy. Essentials correctly refuses a second branch and the loyalty module.

The breaks a cashier or administrator actually hits:

- The amount on the check is not the amount that settles the check. After a partial tender the summary says nothing is due while the bill is open. That is a money-handling failure, not a copy nit.
- Menu import exists only as a URL. The sidebar never names it.
- Webhook configuration turns "use HTTPS" into an internal error.
- Platform onboarding turns a duplicate slug into a generic 500, so the operator cannot tell a mistake from an outage.
- tRPC client errors carry server stack frames, including workspace chunk paths.
- Notifications has one serious contrast failure. The axe sample is a single page, so this is a floor, not a survey.
- The dashboard at 390px did not scroll sideways. Mobile coverage beyond that one surface is a gap, not a pass of the whole shell.
- Warmed `/restaurant/orders` was 584 ms wall, 571 ms navigation. That smoke passed. It is not a performance budget.

POS and KDS are device sessions. Enrolling the browser ends the admin web session. Card tender is mock. The print bridge is simulated. Those match the product notes and were not filed.

## Top risks

1. Cross-tenant catalog read on the connection `docs/LOCAL_SETUP.md` tells operators to use. `listProducts` and `getProduct` do not filter by organization and rely on row-level security. The superuser bypasses `FORCE ROW LEVEL SECURITY`, and the app does not set `row_security`. This was observed, not inferred: the Essentials session received House products.
2. Tax is computed at tender and omitted from the summary. A dine-in bill of 970.00 needed another 145.50 to settle. A card sale of 120.00 left 18.00 open. The post-tender summary then showed 0.00 due.
3. Audit recording inside the page transaction (P2028) took `/restaurant/reports` 17.7 minutes and grew `next-server` to about 13.4 GB until the process was killed. Catalog and branch checks during that window were invalid.
4. Refunds, comps, and device revoke need a second linked user with `coauth:approve`. Job-role capabilities are ignored, and invite is gated on the agency HR module. The service cannot correct a check.
5. Disabling `restaurant-pos` does not hide `/pos`. Only the page was checked.
6. A restaurant administrator was rendered on the agency host. The retry did not repeat the paint; the first screenshot still stands.
7. Several money and permission cases never ran (discount, recipe consumption, cashier/kitchen/server web permissions, order IDOR, counted day close, keyboard dialog, full axe matrix). The release call does not depend on those gaps. The four blockers above are enough.

## Comment drafts for existing issues

These are notes to paste. This pass did not comment on GitHub.

Pharmacy QA on this branch already drafted the shared setup and catalog findings. Do not file a second GitHub issue for those:

- `qa/pharmacy/issues/001-documented-migrate-needs-extension-prep.md` is SET-01 / GitHub #126.
- `qa/pharmacy/issues/003-pharmacy-packages-one-default-seat.md` is the seat default / GitHub #128. Restaurant rows are in the comment draft below.
- `qa/pharmacy/issues/010-no-tenant-staff-invite.md` is the pharmacy sibling of the restaurant invite failure (GitHub #135). The restaurant file is `issues/005-invite-blocked-by-hr-module.md`.
- `qa/pharmacy/issues/005-role-templates-miss-colon-actions.md` is the pharmacy sibling of restaurant co-authorization (GitHub #130). The restaurant file is `issues/004-refund-coauth-unreachable.md`.

### #126 — documented migrate fails until extension prep

Restaurant reproduction of the same failure, on commit `fa3658b715bf2e672f7e38f983b558d8d86b5a75`. A fresh `bunx prisma migrate deploy` against an empty database stopped at `20260830120000_btree_gist_public_execute_acl`. Running `prisma/prepare-extensions.ts` (extensions `btree_gist`, `pg_trgm`, `pgcrypto`) let the remaining migrations apply. All 148 migrations are applied on the database used for this pass. `docs/LOCAL_SETUP.md` never names the prep step. `docs/demo-restaurants.md` does. Case SET-01. Not a second issue.

### #128 — packages offered as 1 default seat

Same catalog path, restaurant rows included. Queried 2026-10-21 on the local database:

| key | defaultSeats |
| --- | ---: |
| restaurant-enterprise | 1 |
| restaurant-operations | 1 |
| restaurant-essentials | 1 |
| pharmacy-chain, pharmacy-essentials, pharmacy-professional | 1 |
| hotel-chain, hotel-essentials, hotel-pro, hotel-venue | 1 |
| agency-suite | 25 |

The onboarding form showed "1 default seats" for Restaurant Enterprise. QA Karahi House was created with `seatLimit` 25 only because the runner overrode that field. Suspected source: `syncPlatformCatalog` does not set `defaultSeats`, so the column stays at the database default of 1. Not a second issue.

### #15 — raw Prisma error text

Restaurant instance, case STF-03. `restaurantStaff.create` with `userId: ""` returned HTTP 500 and the body included `Invalid prisma.restaurantStaffProfile.create() invocation` and `Foreign key constraint violated on the constraint: restaurant_staff_profiles_userId_fkey`. Omitting `userId` created the profile. The empty-string case should be a client error; the leak itself is #15. Not a second issue.

### #14 — platform command errors

ONB-05 is related and distinct. A duplicate restaurant slug returned HTTP 500 `{"error":"The platform command could not be completed."}` with no second row. It did not return a Zod issues array. Filed as `issues/006-duplicate-slug-500.md`.

### #130 and #135

#130 (pharmacy role templates versus capability checks) is the same pattern as restaurant co-authorization and a different code path (`operatorHasCapability` in `src/lib/restaurant/checkout-routes.ts`). Filed as `issues/004-refund-coauth-unreachable.md`. #135 (pharmacy owner cannot add a cashier) is the sibling of the restaurant HR invite gate. Filed as `issues/005-invite-blocked-by-hr-module.md`.

### #59 — pharmacy navigation on a restaurant

Not reproduced on this commit. The restaurant sidebar did not include pharmacy Onboarding, Counter, or Regulatory. TNT-02 passed. No comment required unless someone wants the negative result.

### #71 — contrast

Closed, and broader than this pass. One serious color-contrast node remains on `/restaurant/notifications`. Filed as `issues/013-notifications-contrast.md` so it is not lost inside the closed issue.

## Environment left behind

QA Karahi House is ACTIVE on Restaurant Enterprise. QA Karahi Essentials is ACTIVE (resumed after LCY-06). `restaurant-pos` on the House organization is ENABLED. The dine-in bill `cmvhkt5ds0027chjsijqnsxuk` is settled with receipt 1. The card bill `cmvhkzgrp004hchjs0bg2q17v` is still open for the 18.00 tax remainder. Several cash drawers are open. The business day 2026-10-21 was not closed. No organization was terminated. The database was not dropped.

## Evidence

Screenshots and JSON are under `qa/restaurants/evidence/`. The first runner `qa/restaurants/evidence/results.json` used `devfathom.localhost` for restaurant pages, so its page-level passes are not trusted. API notes in that file for onboarding and lifecycle are used where the HTTP body is quoted. Later runs (`api-results.json`, `pos-pay.json`, `pos-settle.json`, `pos-finish.json`, `pos-coauth.json`, `kds.json`, `pos-rest.json`) were executed on the slug hosts or the platform host. Session tokens in those JSON files are redacted. PIN values and the platform authenticator secret are not in the issue files.
