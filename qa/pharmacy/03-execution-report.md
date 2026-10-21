# Pharmacy vertical — execution report

| Item | Value |
| --- | --- |
| Branch | `qa/pharmacy-restaurants-agencies` |
| Commit under test | `fa3658b715bf2e672f7e38f983b558d8d86b5a75` |
| Date | 2026-10-21 |
| Runner | Playwright Chromium against `bun run dev --port 3000 --hostname 127.0.0.1` (Next.js 16.2.12, Bun 1.3.14, PostgreSQL 16) |
| Product code | Unchanged. This pass writes only `qa/pharmacy/`. |
| Issue filing | The cloud GitHub token returns HTTP 403 for issues, labels, and comments. Each defect is a file under `qa/pharmacy/issues/`. |

## Release recommendation

**Do not release the pharmacy vertical to a first customer.**

A super admin can create a Pharmacy Professional tenant and a Pharmacy Essentials tenant, the owner can sign in, and the main pharmacy screens render. The owner cannot reach a first legal sale:

- The Karachi / Sindh branch is offered only provisional Punjab rules, and the regulatory page says the branch cannot operate (issue 004).
- Onboarding step 8 links to a catalogue that establishes no saleable medicine (issue 007).
- The installed Pharmacist, Cashier, Finance, and Owner templates do not grant the colon actions those jobs are checked against (issue 005).
- The owner cannot add a second person from the workspace (issue 010).

Activation stays BLOCKED at 2/12 gates (commercial package, owner and role templates). Those two pass from provisioning. The rest cannot be finished on the surfaces this pass could use.

## Counts

| | |
| --- | ---: |
| Cases in `02-test-cases.md` | 88 |
| Pass | 25 |
| Fail | 13 |
| Blocked | 50 |
| Defect files | 12 |
| sev1-critical | 3 |
| sev2-major | 5 |
| sev3-minor | 3 |
| sev4-trivial | 1 |

Blocked cases are not passes. Most of the sale, stock, refund, role-isolation, revoke, and accessibility cases are blocked because the catalogue and staff paths stop first, and because the browser run stalled on `/pharmacy/orders` while Postgres stopped accepting new connections.

## Environment and setup

Documented path (`bunx prisma migrate deploy` on an empty database) **fails**. Migration `20260830120000_btree_gist_public_execute_acl` raises `P0001` (`188 btree_gist functions retain PUBLIC EXECUTE`) until `prisma/prepare-extensions.ts` is run with a superuser `EXTENSION_ADMIN_DATABASE_URL`. That step is not in README or `docs/LOCAL_SETUP.md`. Issue 001.

After that undocumented prep:

1. `bunx prisma migrate deploy` applied 148 migrations.
2. `bun run db:seed` completed and synced the platform catalog, including pharmacy packages.
3. Role `devfathom_app` was created `LOGIN NOSUPERUSER NOBYPASSRLS` and is not the table owner. With the platform GUC set it sees the package catalog; without a tenant GUC it does not see tenant rows. PH-SET-02 pass.
4. Next dev listens on `127.0.0.1:3000`. `/etc/hosts` maps `admin.localhost`, `qa-clifton.localhost`, `qa-rival.localhost`, `devfathom.localhost`, and `www.localhost` to `127.0.0.1`.
5. Platform MFA stayed enforced. The super admin enrolled TOTP. The secret is in `/tmp/qa-pharmacy-mfa-secret` and is not in git.
6. `next.config.ts` `allowedDevOrigins` is only `127.0.0.1`. Tenant hosts still rendered login and the workspace. A hydration warning was logged (`qa/pharmacy/evidence/console.json`) without a component name. It is not filed.

Tenants created through the control-desk UI:

| Slug | Id | Package | Branch | Admin |
| --- | --- | --- | --- | --- |
| `qa-clifton` | `cmvhhkj1v000ggtjsplibyd6k` | Pharmacy Professional, seat limit 10, PKR, `Asia/Karachi` | Clifton Chemist, MAIN, Karachi, Sindh | `owner@qa-clifton.test` |
| `qa-rival` | `cmvhhlh4w001wgtjst4gvc3av` | Pharmacy Essentials | Rival Counter, Lahore, Punjab | `owner@qa-rival.test` |

Shared provisioning marked the Clifton deployment READY (`qa/pharmacy/evidence/platform-jobs.txt`). Both organizations remain `ONBOARDING`.

## Invalid automated results

These script results are **not** product defects:

- An earlier follow-up matched `/platform/login` and those platform calls returned HTTP 401. A later pass waited until the path was `/platform` and is the one recorded below.
- The first run’s PH-RV-03 and PH-RV-04 posted `organization.update` with a status. The response was HTTP 200 and the row stayed `ONBOARDING` with `updatedAt` unchanged. Lifecycle changes go through `organization.transition`. Suspend and resume were still in progress when this report was written.
- The first PH-SA-08 fail (“Disable appears next to Pharmacy Core”) does not match the screenshot. Pharmacy Core has no Disable control and is marked mandatory (`qa/pharmacy/evidence/sa-06-modules.png`).
- The first PH-ON-01 fail was a 1.5s race during cold compile. The follow-up landed on `http://qa-clifton.localhost:3000/dashboard`.
- PH-ON-02 compared the login hero, including the text “Signing in...”, and never observed the alert. It is blocked, not a proven mismatch of error copy.

## Coverage

Walked as the Clifton owner after a real sign-in (HTTP 200, no application-error text in the captured body): `/dashboard`, `/pharmacy`, `/pharmacy/regulatory`, `/pharmacy/inventory`, `/pharmacy/inventory/expiry`, `/pharmacy/inventory/transfers`, `/pharmacy/inventory/imports`, `/organization`, `/team`, `/pharmacy/medicines`, `/pharmacy/medicines/prices`, `/pharmacy/medicines/staged`, `/pharmacy/counter`, `/pharmacy/counter/close`, `/pharmacy/purchasing`, `/pharmacy/purchasing/suppliers`, `/pharmacy/purchasing/orders`, `/pharmacy/purchasing/receiving`, `/pharmacy/purchasing/returns`, `/pharmacy/finance`, `/pharmacy/reports`, `/pharmacy/reports/replenishment`, `/pharmacy/reports/repeat-purchasing`, `/pharmacy/reports/supplier-credit-follow-up`, `/pharmacy/orders`.

Not reached before the stall: prescriptions, pharmacist queue, substitution, controlled register, loyalty, marketing, cameras, camera privacy, settings, settings/modules, settings/receipts, and the dead prefixes `/pharmacy/procurement`, `/pharmacy/dispensing`, `/pharmacy/safety`, `/pharmacy/crm`.

Rival was opened on `/pharmacy/inventory` only. Essentials navigation stops at Cameras, Regulatory profile, Organization, and Settings. Loyalty, marketing, prescriptions, pharmacist queue, substitution, and the controlled register are not in that nav. Clifton Professional shows them.

## Results

| ID | Result | Notes |
| --- | --- | --- |
| PH-SET-01 | Fail | Documented migrate fails. Issue 001. |
| PH-SET-02 | Pass | `devfathom_app` is NOSUPERUSER and NOBYPASSRLS. Tenant reads require the org GUC. |
| PH-SET-03 | Pass | Platform and tenant login documents return HTTP 200. |
| PH-SA-01 | Pass | Four verticals, nothing preselected. |
| PH-SA-02 | Pass | Only the three pharmacy packages. Provinces are human names. Seat label is issue 003. |
| PH-SA-03 | Blocked | The form stayed. Empty city was likely stopped by HTML5 required before slug and password errors were shown. |
| PH-SA-04 | Pass | `qa-clifton` created, status ONBOARDING, deployment later READY. |
| PH-SA-05 | Pass | Authenticated `organization.update` with the agency package returns HTTP 400: “The selected package is not available for the PHARMACY vertical.” |
| PH-SA-06 | Pass | Professional pharmacy modules are ENABLED / PACKAGE. Non-pharmacy modules are DISABLED, and they are still listed. Issue 012. |
| PH-SA-07 | Pass | Authenticated `organization.transition` to ACTIVE returns HTTP 400: “Activation preflight failed: pharmacy regulatory profile denied operation (PROFILE_MISSING).” Status stays ONBOARDING. |
| PH-SA-08 | Pass | No Disable control on the module card. Authenticated disable returns HTTP 400: “The mandatory pharmacy-core module cannot be disabled.” |
| PH-ON-01 | Pass | Follow-up session landed on `/dashboard`. |
| PH-ON-02 | Blocked | A wrong password returns “Invalid email or password. Please try again.” The unknown-email attempt’s text grab still showed the login hero. The screenshot of that attempt shows the same sentence. Not filed. |
| PH-ON-03 | Fail | `/dashboard` is the command centre, not the first-run checklist, and it shows a false financial restriction. Issue 006. |
| PH-ON-04 | Pass | Heading Onboarding. 2/12 done. Package and owner templates DONE. The other ten NEEDS YOU. Activation BLOCKED. |
| PH-ON-05 | Blocked | “Confirm this step” is on the page. Empty and filled evidence were not submitted. |
| PH-ON-06 | Pass | Signed-out `/pharmacy/counter` redirects to `/login?callbackUrl=%2Fpharmacy%2Fcounter`. |
| PH-ST-01 | Fail | Branch is Clifton Chemist — Karachi. Province control shows Punjab (rules provisional). Issue 004. |
| PH-ST-02 | Blocked | Save was not submitted. |
| PH-ST-03 | Fail | The form offers Punjab (rules provisional) for the Karachi branch and says the branch cannot operate. A save click did not store a profile (`pharmacy_branch_regulatory_profiles` count stayed 0). The inputs did not take the script’s label-based fill, so this is not a proven server accept of an empty profile. Issue 004. |
| PH-ST-04 | Pass | Inventory working branch is Clifton Chemist · Karachi. 0 units. Empty lots. Create-location form is present. |
| PH-UR-01 | Pass | Administrator is listed. Owner, Owner / Operator, Pharmacist, Manager, Cashier, Procurement, Inventory, Finance, and Auditor are installed with the ALLOW lines in issue 005. |
| PH-UR-02 | Fail | No invite control. `/team` is the disabled HR module. Issue 010. |
| PH-UR-03 | Blocked | No cashier user. |
| PH-UR-04 | Blocked | No cashier user. |
| PH-PR-01 | Pass | Medicines, prices, and staged render an empty staged catalogue. No other tenant’s rows. |
| PH-PR-02 | Fail | No create or publish control on the catalogue the onboarding link opens. Issue 007. |
| PH-PR-03 | Blocked | Cannot create a medicine in the UI. |
| PH-IN-01 | Blocked | No saleable pack to receive. Location form was not submitted. |
| PH-IN-02 | Blocked | No lots. Expiry board itself renders for Clifton Chemist with PKR 0.00 and 0 units. |
| PH-IN-03 | Blocked | Receive form not reached. |
| PH-IN-04 | Blocked | No lots. |
| PH-IN-05 | Pass | Transfers explain that a second branch is required. Counts say to receive stock and create a location first. |
| PH-PU-01 | Pass | “Purchasing & receiving”. 0 suppliers, 0 orders. “Add a supplier” form is visible (trading name, legal name, service area, contact, terms, credit limit). |
| PH-PU-02 | Blocked | “QA Distributors” was created and is listed as NOT AUTHORIZED. The page says to record a verified licence before ordering. Licence and authorization were not completed, so the parties gate was not rechecked. A stock location “Shelf A” (`SHELF-A`) was created from inventory. |
| PH-PU-03 | Blocked | No pack and no authorized supplier. |
| PH-PU-04 | Blocked | Returns page rendered; no receipt to return. |
| PH-PU-05 | Blocked | No cashier user. |
| PH-POS-01 | Pass | Counter shows Clifton Chemist · MAIN, scan/search, empty cart, Returns & refunds, Open drawer. |
| PH-POS-02 | Blocked | Nothing to sell. |
| PH-POS-03 | Blocked | No stock. |
| PH-POS-04 | Blocked | No expired lot. |
| PH-POS-05 | Blocked | No bill. |
| PH-POS-06 | Blocked | No bill. |
| PH-POS-07 | Blocked | No settled sale. |
| PH-POS-08 | Blocked | Day close renders the heading and then “Loading pharmacy branches…”. Not confirmed as a hang. |
| PH-POS-09 | Blocked | No cashier and no prescription line. |
| PH-RP-01 | Blocked | Reports render and list Clifton Chemist. No sale exists to assert. Dashboard financial widgets are issue 006. |
| PH-RP-02 | Pass | Replenishment, repeat purchasing, and supplier-credit follow-up return HTTP 200 with no stack trace. |
| PH-RP-03 | Pass | Finance explains that no balance postings are recorded and completeness is unknown. No sale was posted. |
| PH-NT-01 | Blocked | Copy is honest: “WhatsApp remains disabled until a provider integration is implemented” and “No messages are sent.” Digest time was not saved. |
| PH-NT-02 | Pass | Unsigned POST 401 `Invalid signature.` GET 403 `Forbidden.` |
| PH-NT-03 | Blocked | `/pharmacy/orders` shows the storefront and “Loading orders…”. The run stalled on this route. |
| PH-SE-01 | Blocked | Settings routes not opened. |
| PH-SE-02 | Blocked | Cameras not opened. |
| PH-SE-03 | Blocked | Marketing and loyalty not opened. Professional nav includes both. |
| PH-CL-01 | Blocked | Clinical routes not opened. Professional nav includes them. |
| PH-CL-02 | Blocked | Clinical routes not opened. |
| PH-RV-01 | Blocked | CRM disable was not authenticated. |
| PH-RV-02 | Blocked | Depends on PH-RV-01. |
| PH-RV-03 | Blocked | Suspend via `organization.transition` was not authenticated. Earlier `organization.update` did not change status. |
| PH-RV-04 | Blocked | Same as PH-RV-03. |
| PH-MT-01 | Pass | Rival inventory shows Rival Counter · Lahore and 0 units. Clifton is not on the page. Essentials nav omits clinical and CRM items. |
| PH-MT-02 | Blocked | IDOR calls were not made. The run stalled earlier. |
| PH-MT-03 | Pass | Clifton cookies on the Rival host land on Rival `/login`. Clifton’s name is not shown. |
| PH-MT-04 | Blocked | Support session not opened. |
| PH-PM-01 | Fail | Pharmacist template grants `pharmacy.dispense`, which does not match `pharmacy:dispense`. Issue 005. |
| PH-PM-02 | Fail | Procurement, inventory, and finance templates grant only dot capabilities. Issue 005. |
| PH-PM-03 | Fail | Owner `pharmacy.*` does not match colon actions or `reports:financial`. Issue 005. |
| PH-VL-01 | Blocked | Counter search was not given the payload. |
| PH-VL-02 | Blocked | Same. |
| PH-VL-03 | Blocked | Same. |
| PH-VL-04 | Blocked | Money and date edges not submitted. |
| PH-UX-01 | Blocked | Platform and tenant screenshots share the Studio shell. A formal visual-QA matrix was not completed. |
| PH-UX-02 | Fail | Dashboard paints a permission denial and raw keys while data is absent. Ask Fathom stays on “availability is being checked.” Issues 006 and 008. Network throttle and a stopped database were not run. |
| PH-UX-03 | Fail | “1 licensed seats are currently occupied.” Package options say “1 default seats.” Dashboard prints raw metric keys. Issues 009, 003, 006. |
| PH-RS-01 | Blocked | Mobile and tablet viewports were not captured. The follow-up stalled before that step. |
| PH-A11Y-01 | Blocked | Keyboard pass not run. |
| PH-A11Y-02 | Blocked | axe was not run. |
| PH-PF-01 | Blocked | Warm timings were not taken. Cold dev navigations are listed under performance. |
| PH-SEC-01 | Pass | Unauthenticated counter search and counter branches 401. Print 400. Replay 403 `origin_denied`. Platform control 401. Bodies do not contain stock. |
| PH-SEC-02 | Blocked | Supplier-portal token calls were not made. |
| PH-SEC-03 | Blocked | Tenant-origin platform call was not made. |
| PH-SEC-04 | Blocked | Logout click was not reached. Signed-out direct URL is PH-ON-06. |
| PH-SEC-05 | Pass | `X-Frame-Options`, `X-Content-Type-Options`, and `Content-Security-Policy` are set on `/login`. `X-Powered-By` is absent. |
| PH-GAP-01 | Blocked | Dead commercial prefixes were not requested. |
| PH-GAP-02 | Fail | Untouched pharmacy form is timezone UTC and currency USD. Issue 002. |
| PH-GAP-03 | Fail | Activation cannot be reached. Regulatory rules refuse operation, and the catalogue has no saleable medicine. Issues 004 and 007. |

## Defects

GitHub links do not exist yet. File these from `qa/pharmacy/issues/`.

| File | Title | Severity |
| --- | --- | --- |
| `001-documented-migrate-needs-extension-prep.md` | [QA][Pharmacy][SEV2] Documented database migrate fails until undocumented extension prep runs | sev2-major |
| `002-pharmacy-defaults-utc-usd.md` | [QA][Pharmacy][SEV2] New pharmacy organization defaults to UTC and USD | sev2-major, ux |
| `003-pharmacy-packages-one-default-seat.md` | [QA][Pharmacy][SEV2] Every pharmacy package is offered as 1 default seat | sev2-major, ux |
| `004-regulatory-profile-cannot-operate.md` | [QA][Pharmacy][SEV1] A Sindh pharmacy cannot record an operable regulatory profile | sev1-critical |
| `005-role-templates-miss-colon-actions.md` | [QA][Pharmacy][SEV1] Pharmacy role templates do not grant the actions the product checks | sev1-critical, security |
| `006-dashboard-false-financial-restriction.md` | [QA][Pharmacy][SEV2] Owner command centre shows financials as restricted and prints raw metric keys | sev2-major, ux |
| `007-no-medicine-create-path.md` | [QA][Pharmacy][SEV1] Onboarding sends the operator to a medicine page that cannot create a saleable medicine | sev1-critical, ux |
| `008-ask-fathom-availability-stuck.md` | [QA][Pharmacy][SEV3] Ask Fathom stays on “availability is being checked” | sev3-minor, ux |
| `009-licensed-seats-grammar.md` | [QA][Pharmacy][SEV4] People card says “1 licensed seats are currently occupied” | sev4-trivial, ux |
| `010-no-tenant-staff-invite.md` | [QA][Pharmacy][SEV2] Pharmacy owner cannot add a cashier or pharmacist in the workspace | sev2-major, ux |
| `011-package-displays-as-custom.md` | [QA][Pharmacy][SEV3] Assigned Pharmacy Professional package displays as Custom | sev3-minor, ux |
| `012-other-vertical-modules-on-pharmacy-ledger.md` | [QA][Pharmacy][SEV3] Pharmacy license ledger lists every other vertical’s modules | sev3-minor, ux |

## UX

The platform desk and the tenant workspace are one shell: paper canvas, ink type, numbered nav, hairline cards. Empty purchasing, inventory, expiry, transfers, and finance states explain what is missing and what to do next. Supplier create and stock-location create are on the page.

The breaks are in the words and the false states. The command centre tells the owner that `reports:financial` is required and prints `EXPIRYVALUEMINOR30` while the reports page already knows the branch. Ask Fathom never leaves “being checked” even though the organization card says chat is on. The package the operator selected is labeled Custom. The people card cannot add the next employee and uses agency departments (ENGINEERING, PRODUCT, DESIGN). Seat copy does not agree with the number 1.

## Performance smoke

Cold dev-server navigations, first hit, DOMContentLoaded. Not a warm production measure. PH-PF-01 stays blocked until those four routes are timed warm.

| Route | Cold time |
| --- | ---: |
| `/dashboard` | 1438 ms |
| `/pharmacy` | 2575 ms |
| `/pharmacy/inventory` | 1137 ms |
| `/pharmacy/counter` | 2160 ms |
| `/pharmacy/purchasing/suppliers` | 5993 ms |
| `/pharmacy/finance` | 18091 ms |
| `/pharmacy/reports` | 8466 ms |
| `/pharmacy/reports/supplier-credit-follow-up` | 35412 ms |

Finance and the supplier-credit report are the outliers. They were not repeated after compile.

## Security observations that passed

- Unauthenticated pharmacy tRPC and the WhatsApp webhook reject the caller (PH-SEC-01, PH-NT-02).
- Login responses carry frame, content-type, and CSP headers (PH-SEC-05).
- A second tenant’s inventory does not show the first tenant’s branch (PH-MT-01).
- Clifton session cookies presented to the Rival host do not open the Clifton workspace (PH-MT-03).

Not tested this pass: IDOR on branch and supplier ids, supplier-portal tokens, a tenant calling the platform control route, logout, XSS, and SQL injection in counter search. Role isolation was judged from the installed grants and `capabilityMatches`, not by signing in as a pharmacist or cashier.

## Top risks

1. A Sindh pharmacy cannot become operable. The only rule set the form offers is provisional Punjab, and the page says the branch cannot operate (004).
2. There is no operator path to a saleable medicine, so opening stock, purchasing, and the first sale cannot start (007).
3. Job templates named Pharmacist, Cashier, Finance, and Owner do not grant the colon actions the procedures check. The bootstrap `ALLOW *` role hides this until a real employee is assigned (005).
4. The owner cannot add that employee in the workspace (010).
5. The owner command centre presents a financial restriction and raw metric keys (006).

## What this pass did not finish

The first follow-up stalled on `/pharmacy/orders` while Postgres stopped accepting connections. A later tail pass, after Postgres recovered, completed platform package rejection, core-disable rejection, and activation refusal. It also created an unauthorized supplier and a stock location. Attestation, clinical routes, module revoke, suspend, axe, and mobile were still running or not captured when this report was written. `/pharmacy/prescriptions` was on “Loading prescriptions / Retrieving protected patient and prescription records.” Those leftovers stay blocked. They do not change the release call: the three critical defects already stop a first sale.

Activation itself fails closed. The control desk names `PROFILE_MISSING`. The operator still cannot record a Sindh profile the product will accept, and cannot publish a saleable medicine.
