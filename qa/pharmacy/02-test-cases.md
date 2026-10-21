# Pharmacy vertical — test cases

Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`.  
Environment assumptions are in `01-test-plan.md`. Each case is executed against the running app. Priorities: P0 release-blocking, P1 primary journey, P2 secondary, P3 polish.

Global preconditions, unless a case says otherwise:

- Platform super admin can sign in at `http://admin.localhost:3000/platform/login`.
- No pharmacy organization with slug `qa-clifton` or `qa-rival` exists at the start of PH-SA-01. Later cases reuse those orgs.

---

## A. Setup and boot

### PH-SET-01 — Database migrates and seeds
- Priority: P0
- Preconditions: empty `devfathom` database, `.env.local` present.
- Steps: run `prisma migrate deploy`, then `bun run db:seed`.
- Expected: both exit 0. Seed prints the DevFathom agency login. `platform_packages` contains `pharmacy-essentials`, `pharmacy-professional`, and `pharmacy-chain`. A `platform_users` row exists for the configured platform admin.
- Evidence: command log.

### PH-SET-02 — App role does not bypass RLS
- Priority: P0
- Preconditions: PH-SET-01 passed. Role `devfathom_app` created `NOSUPERUSER NOBYPASSRLS`.
- Steps: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'devfathom_app'`.
- Expected: both flags are false. The Next.js process `DATABASE_URL` uses this role.
- Evidence: SQL output in the setup log.

### PH-SET-03 — Server boots and answers
- Priority: P0
- Steps: start the app. Request `http://admin.localhost:3000/platform/login` and `http://devfathom.localhost:3000/login`.
- Expected: both return HTTP 200 and render a sign-in form. No uncaught overlay.
- Evidence: screenshots `evidence/set-03-platform-login.png`, `evidence/set-03-tenant-login.png`.

---

## B. Super admin onboarding

### PH-SA-01 — Vertical chooser does not preselect
- Priority: P1
- Steps: sign in. Open `/platform/organizations/new`.
- Expected: step 1 of 2, four types (Agency, Restaurant, Pharmacy, Hospitality), none selected, no organization created. Pharmacy description matches the catalog.
- Evidence: screenshot.

### PH-SA-02 — Pharmacy form lists only pharmacy packages
- Priority: P0
- Steps: choose Continue as Pharmacy.
- Expected: step 2. Package dropdown contains Pharmacy Essentials, Professional, and Chain only. No agency, restaurant, or hospitality package. First-branch name, address, city, and province are required. Province options are human names (Punjab, Sindh, …), not raw codes alone. Copy states the workspace stays in onboarding.
- Evidence: screenshot of the form.

### PH-SA-03 — Create refuses a short password and a bad slug
- Priority: P1
- Steps: submit with password `short`, slug `QA Clifton`, and an empty branch city.
- Expected: the form stays put. Field errors name the password length, the slug pattern, and the city. No organization row is created.
- Evidence: screenshot and a count of orgs with that display name.

### PH-SA-04 — Create a Pharmacy Professional tenant
- Priority: P0
- Steps: submit display name `QA Clifton Chemist`, legal name `QA Clifton Chemist (Private) Limited`, slug `qa-clifton`, shared deployment, Pharmacy Professional, seat limit 10, currency `PKR`, timezone `Asia/Karachi`, branch `Clifton Chemist`, address `12 Clifton Road`, city `Karachi`, province Sindh, contact and administrator `Pharmacy Owner` / `owner@qa-clifton.test`, password of at least 12 characters.
- Expected: redirect to `/platform/organizations/<id>`. Status `ONBOARDING`. Vertical PHARMACY. Package Pharmacy Professional. A branch `MAIN` exists. Bootstrap user is an active admin.
- Evidence: screenshot of the organization page.

### PH-SA-05 — Cross-vertical package is rejected
- Priority: P0
- Steps: `POST /api/platform/control` as the platform session with `organization.update` and an agency package id.
- Expected: HTTP 400. Message states the package is not available for PHARMACY. The org’s package is unchanged after reload.
- Evidence: response body.

### PH-SA-06 — Professional modules are granted, others are not
- Priority: P0
- Steps: open the Modules section for `qa-clifton`.
- Expected: enabled (inherited): core, counter, inventory, procurement, finance, reports, dispensing, safety, CRM. Not enabled: none of the chain-only extras beyond that set (chain equals professional today). Agency and restaurant modules are absent. `pharmacy-core` cannot be disabled.
- Evidence: screenshot.

### PH-SA-07 — Activation is refused before readiness
- Priority: P0
- Preconditions: PH-SA-04. Production deployment may still be pending.
- Steps: on the lifecycle gate, choose ACTIVE and apply with a reason, without completing regulatory profile or gates.
- Expected: the transition is rejected. Status remains ONBOARDING. The reason names the failed gate (deployment, regulatory profile, or pharmacy readiness). The page does not claim the org is active.
- Evidence: screenshot and response.

### PH-SA-08 — Mandatory module cannot be disabled
- Priority: P1
- Steps: attempt to disable Pharmacy Core.
- Expected: no disable control, or the command returns an error. Core stays enabled.
- Evidence: screenshot or response.

---

## C. First login and onboarding

### PH-ON-01 — First login on the tenant host
- Priority: P0
- Steps: open `http://qa-clifton.localhost:3000/login`. Sign in as `owner@qa-clifton.test` with the temporary password.
- Expected: session lands in the workspace (dashboard or the callback). The shell shows the pharmacy organization, not DevFathom agency and not a restaurant nav group.
- Evidence: screenshot of the shell.

### PH-ON-02 — Wrong password and unknown email share one message
- Priority: P1
- Steps: submit a wrong password for the owner, then submit `nobody@qa-clifton.test`.
- Expected: both attempts fail with the same generic message. Neither reveals whether the email exists.
- Evidence: screenshots.

### PH-ON-03 — Dashboard first-run checklist
- Priority: P1
- Steps: open `/dashboard`.
- Expected: a pharmacy first-run checklist (branch, staff and roles, catalog and opening stock, first test sale; counter device and tax optional). Branch and staff are already done because create provisioned them. Catalog, stock, and first sale are pending. Links go to pharmacy routes, not `/pos`.
- Evidence: screenshot.

### PH-ON-04 — Twelve gates render without a spinner dead-end
- Priority: P0
- Steps: open `/pharmacy` as the admin.
- Expected: heading “Onboarding”. Twelve steps in order. Commercial package and Owner and role templates are PASSED from evidence. Premises, catalog, opening stock, and parties are not PASSED. Attested gates are NOT_STARTED. No gate is PASSED merely because the org exists.
- Evidence: screenshot of the full list.

### PH-ON-05 — Attestation requires an evidence reference
- Priority: P1
- Steps: try to mark “Organization type” passed with an empty evidence reference, then with a reference.
- Expected: empty reference is rejected or does not stick after reload. A real reference plus the signed-in actor records PASSED and survives reload.
- Evidence: screenshots before and after reload.

### PH-ON-06 — Direct URL while signed out
- Priority: P0
- Steps: in a fresh context, open `http://qa-clifton.localhost:3000/pharmacy/counter`.
- Expected: redirect to login. No counter data in the response body.
- Evidence: final URL and screenshot.

---

## D. Store, regulatory, users

### PH-ST-01 — Regulatory profile empty state
- Priority: P1
- Steps: open `/pharmacy/regulatory`.
- Expected: the MAIN branch is listed (Clifton Chemist, Karachi, Sindh). The form explains the licence is not yet recorded. Province is not a raw code dumped as the only label.
- Evidence: screenshot.

### PH-ST-02 — Regulatory validation
- Priority: P1
- Steps: save with an empty licence number, a qualified-person name of one character, and an effective date in an impossible format.
- Expected: errors sit on those fields. Nothing is stored as an in-force profile. Onboarding gate 4 stays failed.
- Evidence: screenshot.

### PH-ST-03 — Save a regulatory profile
- Priority: P0
- Steps: save a complete profile for Sindh (licence number, qualified person, premises, effective from today).
- Expected: success copy, values visible after reload. If the published Sindh rule set is unconfirmed or incomplete, the save or the gate says that explicitly and does not pretend the branch may operate.
- Evidence: screenshot. Record the exact rule-set outcome.

### PH-ST-04 — Branch is visible in inventory
- Priority: P1
- Steps: open `/pharmacy/inventory`.
- Expected: working branch Clifton Chemist / MAIN. Empty lots and locations, not an error page. Copy does not tell the operator to create the first branch that already exists, unless the branch is actually missing.
- Evidence: screenshot.

### PH-UR-01 — Provisioned roles are visible
- Priority: P0
- Steps: open `/organization` (and `/team` if people live there).
- Expected: the administrator is listed. System roles include Owner, Pharmacist, Manager, Cashier, Procurement, Inventory, Finance, Auditor, and Owner / Operator. The admin is not only an unlabeled member.
- Evidence: screenshot.

### PH-UR-02 — Create a cashier
- Priority: P0
- Steps: create `Cashier One`, `cashier@qa-clifton.test`, assign the Cashier role, set a password.
- Expected: the user appears as active and consumes a seat. Seat usage is 2 of the limit. A duplicate email is rejected.
- Evidence: screenshot.

### PH-UR-03 — Cashier cannot open admin pharmacy surfaces
- Priority: P0
- Steps: sign in as the cashier. Visit `/pharmacy`, `/pharmacy/finance`, `/pharmacy/regulatory`, `/pharmacy/medicines`, `/organization`.
- Expected: onboarding, finance, regulatory, medicines, and organization administration are hidden or show a permission state. They do not render admin data. Counter, if shown, is allowed.
- Evidence: screenshots.

### PH-UR-04 — Cashier API cannot record an onboarding gate
- Priority: P0
- Steps: as the cashier session, call `pharmacyOnboarding.recordGate`.
- Expected: 401 or 403. No gate row changes.
- Evidence: response body.

---

## E. Catalog, inventory, batches, expiry

### PH-PR-01 — Medicine catalog empty and permission
- Priority: P1
- Steps: as admin, open `/pharmacy/medicines`, `/pharmacy/medicines/prices`, `/pharmacy/medicines/staged`.
- Expected: each page renders a heading and an empty or “not configured” state. No uncaught exception. Prices and staged review do not show another tenant’s rows.
- Evidence: screenshots.

### PH-PR-02 — Create and publish a saleable medicine
- Priority: P0
- Steps: using the catalog UI, add an OTC medicine `QA Paracetamol 500mg Tablet`, a pack, a barcode `6285000000001`, MRP, and publish it so a reviewer has accepted it.
- Expected: the medicine is visible after reload and gate “Medicine catalog readiness” becomes PASSED. If the only UI is a reference connector with no manual create, the page says how to add a product. A dead end with no path to a saleable medicine is a fail.
- Evidence: screenshots of the catalog and the gate.

### PH-PR-03 — Duplicate barcode and blank name
- Priority: P2
- Steps: create a medicine with an empty name, then reuse barcode `6285000000001`.
- Expected: both are rejected with a field error. The original pack keeps its barcode.
- Evidence: screenshot.

### PH-IN-01 — Receive a lot with batch and expiry
- Priority: P0
- Steps: on `/pharmacy/inventory` (or imports), receive 20 packs of the published medicine, batch `QA-B1`, expiry 18 months out, a location such as Shelf A.
- Expected: the lot shows quantity 20, the batch, and the expiry. Gate “Opening stock readiness” becomes PASSED after reload. Stock balance matches the receipt.
- Evidence: screenshot.

### PH-IN-02 — Expired and short-dated lots are visible
- Priority: P1
- Steps: receive batch `QA-EXP` with an expiry date in the past, and batch `QA-SOON` expiring within 30 days. Open `/pharmacy/inventory/expiry`.
- Expected: the past-dated lot is flagged expired and is not offered as a normal saleable FEFO pick. The short-dated lot is warned. The board is not empty.
- Evidence: screenshots of the board and of counter search.

### PH-IN-03 — Negative receive and nonsense quantity
- Priority: P2
- Steps: submit quantity `-5`, then `0`, then a non-numeric value.
- Expected: all rejected. On-hand quantity unchanged.
- Evidence: screenshot.

### PH-IN-04 — Two batches stay distinct
- Priority: P1
- Steps: confirm `QA-B1` and `QA-SOON` are separate rows, not summed into an unlabeled pile.
- Expected: batch number and expiry are visible on each row. FEFO order prefers the earlier expiry among saleable lots.
- Evidence: screenshot.

### PH-IN-05 — Transfer and count empty states
- Priority: P2
- Steps: open `/pharmacy/inventory/transfers` and the physical count section.
- Expected: a second branch does not exist, so transfer explains that, or offers a create path. Count can be started or explains why not. No raw exception text.
- Evidence: screenshots.

---

## F. Purchasing and suppliers

### PH-PU-01 — Purchasing empty state
- Priority: P1
- Steps: open `/pharmacy/purchasing` and `/pharmacy/purchasing/suppliers`.
- Expected: heading “Purchasing & receiving”. Zero suppliers, orders, and receipts. A way to add a supplier is visible to the admin.
- Evidence: screenshot.

### PH-PU-02 — Create an authorized supplier
- Priority: P0
- Steps: create supplier `QA Distributors`, a licence, and mark it authorized and active.
- Expected: the supplier remains after reload. Gate “Parties and balances” becomes PASSED. An empty name is rejected.
- Evidence: screenshots.

### PH-PU-03 — Purchase order through to stock
- Priority: P0
- Steps: raise a requisition or PO for 10 packs of QA Paracetamol from QA Distributors, approve if required, send, then receive on `/pharmacy/purchasing/receiving` with batch `QA-PO1` and a future expiry.
- Expected: PO status moves forward at each step. Posted receipt increases on-hand by 10. A receipt against a draft PO is refused. The new lot appears on the inventory board.
- Evidence: screenshots of PO, receipt, and inventory.

### PH-PU-04 — Supplier return
- Priority: P1
- Steps: on `/pharmacy/purchasing/returns`, return 1 pack of `QA-PO1` with a reason.
- Expected: the return is recorded, stock decreases by 1, and a debit or credit note is visible or explicitly not yet available. Cancelling the return does not double-decrement.
- Evidence: screenshots.

### PH-PU-05 — Cashier cannot create a supplier
- Priority: P1
- Steps: as cashier, open suppliers and call `pharmacyPurchasing` create.
- Expected: UI hidden or permission state. API 403. Supplier count unchanged.
- Evidence: screenshot and response.

---

## G. POS, discounts, customers, returns

### PH-POS-01 — Counter empty state
- Priority: P0
- Steps: as admin, open `/pharmacy/counter`.
- Expected: branch Clifton Chemist, a search box, an empty cart, and a way to take payment that stays disabled until there is a sale. No console error overlay.
- Evidence: screenshot.

### PH-POS-02 — Sell an OTC pack for cash
- Priority: P0
- Preconditions: PH-IN-01 stock on hand.
- Steps: search `Paracetamol`, add 1 pack, tender exact cash, complete.
- Expected: a receipt with medicine name, batch or FEFO lot, quantity, price, tender, and change. On-hand decreases by 1. The sale survives reload. First-run “first test sale” becomes done.
- Evidence: receipt screenshot and inventory quantity.

### PH-POS-03 — Cannot sell more than on-hand
- Priority: P0
- Steps: add a quantity greater than the remaining saleable stock.
- Expected: the line is refused or capped, with an explanation. Stock does not go negative.
- Evidence: screenshot and balance.

### PH-POS-04 — Expired batch is not sold
- Priority: P0
- Steps: search and try to sell `QA-EXP` only (or confirm the picker skips it).
- Expected: the expired lot is not allocated. If it is the only lot, the sale is blocked.
- Evidence: screenshot.

### PH-POS-05 — Discount
- Priority: P1
- Steps: sell 1 pack with a line or sale discount smaller than the price, then try a discount larger than the line.
- Expected: the smaller discount reduces the total and prints on the receipt. The oversized discount is rejected. The drawer or tender matches the discounted total.
- Evidence: receipt screenshot.

### PH-POS-06 — Customer attach, khata, loyalty
- Priority: P1
- Steps: from the counter, create or attach customer `Ayesha Khan`, phone `03001234567`. Complete a sale in her name. Open loyalty and the customer snapshot.
- Expected: the sale is linked to her. Loyalty points, if the package includes CRM, increase by the stated rule or the UI says points are not configured. A second customer with the same phone is rejected or clearly merged. Khata shows the transaction.
- Evidence: screenshots.

### PH-POS-07 — Return and refund
- Priority: P0
- Steps: open the receipt and return the sold pack, refund the cash tender.
- Expected: stock returns to the same batch, the receipt shows a refund, the drawer movement matches, and a second refund of the same line is refused.
- Evidence: screenshots of the return and the inventory row.

### PH-POS-08 — Day close
- Priority: P1
- Steps: open `/pharmacy/counter/close`, review the preview, close the day.
- Expected: totals equal the tenders minus refunds from this session. Closing twice is refused or is a no-op with an explanation.
- Evidence: screenshot.

### PH-POS-09 — Prescription-only line is blocked for a cashier
- Priority: P1
- Steps: if a non-OTC medicine exists, the cashier adds it without a prescription. Otherwise attempt `pharmacySales` controlled path as the cashier.
- Expected: the sale is blocked until a pharmacist or a recorded prescription allows it. The block is a sentence a cashier can read.
- Evidence: screenshot or response. If no Rx product can be created, status is Blocked with the reason.

---

## H. Reports, notifications, WhatsApp, settings

### PH-RP-01 — Reports show the sale
- Priority: P1
- Steps: open `/pharmacy/reports` for the Clifton branch and today’s dates.
- Expected: the completed sale and the refund appear in the operational figures. Empty widgets say they are empty. No other tenant’s numbers.
- Evidence: screenshot.

### PH-RP-02 — Replenishment, repeat purchasing, supplier credit
- Priority: P2
- Steps: open the three report sub-routes.
- Expected: each renders, filters by this branch, and shows an empty or populated state consistent with the data created above. No stack trace.
- Evidence: screenshots.

### PH-RP-03 — Finance journal
- Priority: P1
- Steps: open `/pharmacy/finance`.
- Expected: the cash sale and refund are posted, or the page explains that posting is a separate action and that action works. Debits equal credits on the posted entry. A cashier receives a permission state.
- Evidence: screenshot.

### PH-NT-01 — Owner digest does not pretend to send WhatsApp
- Priority: P1
- Steps: on reports, open digest settings. Save a digest time. Inspect WhatsApp status.
- Expected: the setting saves. Copy states that WhatsApp is not sending (the P0-lite stub). It does not say a message was delivered.
- Evidence: screenshot.

### PH-NT-02 — WhatsApp webhook rejects a bad signature
- Priority: P0
- Steps: `POST /api/pharmacy/whatsapp/webhook` on the Clifton host with a JSON body and no valid Meta signature. Then `GET` the same URL with no verify token.
- Expected: 401 or 403. No customer order is created.
- Evidence: status codes and an order count.

### PH-NT-03 — Customer order queue
- Priority: P2
- Steps: open `/pharmacy/orders`.
- Expected: empty staff queue with an explanation that orders are proposals. No control that marks a nonexistent order complete.
- Evidence: screenshot.

### PH-SE-01 — Settings and modules
- Priority: P1
- Steps: open `/settings` and `/settings/modules` as admin, then as cashier.
- Expected: admin sees the pharmacy modules that match the platform grant. Cashier does not change entitlements. Receipt settings at `/settings/receipts` load or explain they are unused.
- Evidence: screenshots.

### PH-SE-02 — Cameras are labeled as a simulator
- Priority: P2
- Steps: open `/pharmacy/cameras` and `/pharmacy/settings/cameras/privacy`.
- Expected: the page does not claim a live camera is recording. Enrollment of a simulated source is labeled as such. Privacy page loads.
- Evidence: screenshots.

### PH-SE-03 — Marketing and loyalty empty states
- Priority: P2
- Steps: open `/pharmacy/marketing` and `/pharmacy/loyalty`.
- Expected: both load for the admin. Creating a campaign without a required field fails validation. Cashier is denied.
- Evidence: screenshots.

---

## I. Clinical surfaces (Professional package)

### PH-CL-01 — Prescriptions, queue, substitution, controlled register
- Priority: P1
- Steps: open `/pharmacy/prescriptions`, `/pharmacy/pharmacist-queue`, `/pharmacy/substitution`, `/pharmacy/controlled-register`.
- Expected: each renders an empty state and a primary action, or a clear “not available” permission card. No restaurant staff copy presented as pharmacy pharmacists unless the product truly uses that record, in which case the label must say so.
- Evidence: screenshots.

### PH-CL-02 — Capture a patient and a prescription
- Priority: P1
- Steps: add patient `Ayesha Khan` if not already a patient, record an OTC note or prescription image placeholder the UI allows, and open the pharmacist queue.
- Expected: the patient is scoped to Clifton. The queue shows the item or explains why a pharmacist must be assigned. A cashier cannot decide the queue (API 403).
- Evidence: screenshots.

---

## J. Revocation

### PH-RV-01 — Disable CRM and confirm the tenant loses it
- Priority: P0
- Steps: as super admin, disable `pharmacy-crm` for Clifton. Reload the tenant.
- Expected: marketing and loyalty leave the nav and direct URLs show the module-unavailable state. Counter and inventory still work. `pharmacyMarketing` returns a module error.
- Evidence: screenshots and response.

### PH-RV-02 — Re-enable CRM
- Priority: P1
- Steps: reset or enable the module again.
- Expected: the surfaces return. Data created before the disable is still there.
- Evidence: screenshot.

### PH-RV-03 — Suspend the organization
- Priority: P0
- Steps: transition Clifton to SUSPENDED with a reason. Attempt tenant login and an authenticated API call with the old session.
- Expected: login fails with a workspace-unavailable message that does not blame the password. Existing session cannot read pharmacy data. Platform page shows SUSPENDED.
- Evidence: screenshots.

### PH-RV-04 — Resume restores access
- Priority: P1
- Steps: transition back to the previous operable state (ONBOARDING or ACTIVE).
- Expected: the owner can sign in again. Data is intact.
- Evidence: screenshot. If activation is still impossible, resume to ONBOARDING is the expected operable state.

---

## K. Isolation and a second tenant

### PH-MT-01 — Second pharmacy
- Priority: P0
- Steps: create `qa-rival`, Pharmacy Essentials, branch `Rival Counter` in Lahore, Punjab. Sign in as its admin.
- Expected: onboarding gates are its own. No Clifton medicines, lots, sales, suppliers, or patients. Essentials does not show dispensing, safety, or CRM nav.
- Evidence: screenshots.

### PH-MT-02 — IDOR on sale, patient, and supplier ids
- Priority: P0
- Steps: from the rival session, call sales, inventory, and purchasing reads and writes with Clifton ids (sale id, branch id, supplier id, patient id).
- Expected: not found or forbidden. No Clifton field values in the body. Counts on Clifton are unchanged.
- Evidence: responses.

### PH-MT-03 — Host mix-up
- Priority: P0
- Steps: on `qa-rival.localhost`, present the Clifton session cookie, and the reverse.
- Expected: the cookie is not honored for the other host. The user is signed out or sees only their own org.
- Evidence: screenshot of the resulting page.

### PH-MT-04 — Platform support session is audited
- Priority: P2
- Steps: from the Clifton org page, open a support session if the control offers one.
- Expected: a reason is required. The banner in the tenant says the session is support. Ending it returns to the platform. If the control is absent, record Gap only if the handbook claims it and the UI hides it; otherwise Pass with “control not offered”.
- Evidence: screenshot.

---

## L. Role matrix

### PH-PM-01 — Pharmacist template versus dispense permission
- Priority: P0
- Steps: create `pharmacist@qa-clifton.test` on the Pharmacist template only (not admin). Open the pharmacist queue and call `pharmacyDispensing.reviewQueue` and `pharmacySales` for a normal OTC add.
- Expected: the role the product calls Pharmacist can review the queue. If the template’s `pharmacy.dispense` grant does not satisfy `pharmacy:dispense`, this case fails.
- Evidence: UI and response. Quote the error.

### PH-PM-02 — Procurement versus inventory versus finance
- Priority: P1
- Steps: create one user per template. Each visits purchasing, inventory, and finance, and calls one mutation outside their area.
- Expected: procurement can manage suppliers and cannot post a journal or receive stock outside purchasing. Inventory can receive stock and cannot create a PO. Finance can open finance and cannot sell at the counter. Record each contradiction.
- Evidence: a small matrix in the execution report.

### PH-PM-03 — Owner star grant
- Priority: P1
- Steps: assign a non-admin user the Owner template only. Repeat the pharmacist queue call.
- Expected: either Owner can operate the pharmacy, or the UI does not describe Owner as full control. A `pharmacy.*` grant that silently matches nothing is a fail.
- Evidence: response.

---

## M. Validation, XSS, injection

### PH-VL-01 — XSS in names
- Priority: P0
- Steps: create a customer, a supplier, and a note whose name is `<img src=x onerror=alert(1)>`. Reload list and receipt views.
- Expected: the string is shown as text. No dialog. `textContent` contains the markup; `innerHTML` does not contain an `img` node created from it.
- Evidence: screenshot and a DOM probe.

### PH-VL-02 — SQL injection in search
- Priority: P0
- Steps: counter search and supplier search for `' OR '1'='1` and `%`.
- Expected: zero unexpected rows, HTTP 200 or a validation error, no 500 with SQL text.
- Evidence: screenshot and status.

### PH-VL-03 — Oversized and unicode input
- Priority: P2
- Steps: paste a 5 000 character note, an emoji name, and Urdu `پیراسیٹامول` into customer and search fields.
- Expected: either accepted and round-tripped, or a limit message. No 500.
- Evidence: screenshot.

### PH-VL-04 — Date and money edges
- Priority: P2
- Steps: expiry `31/02/2026`, price `-1`, discount blank, seat limit `0` on a platform edit.
- Expected: each is rejected with a human message. No negative money stored.
- Evidence: screenshots.

---

## N. UI, responsive, accessibility, performance

### PH-UX-01 — Studio consistency on platform and tenant
- Priority: P2
- Steps: compare platform organization page and tenant counter at 1440px.
- Expected: same shell family (paper canvas, ink type, hairline borders, coral used sparingly). No second admin theme, no default unstyled browser buttons sitting in an otherwise styled page.
- Evidence: screenshots.

### PH-UX-02 — Empty, loading, and error
- Priority: P2
- Steps: hard-reload `/pharmacy/reports` and `/pharmacy/inventory` with the network slowed to Fast 3G. Stop the database and reload `/pharmacy` once, then start it again.
- Expected: a loading state exists (skeleton or honest text). A failed load is an error card with a retry, not a blank page and not a stack trace. Empty data is distinct from the error.
- Evidence: screenshots. If stopping Postgres is unsafe for the rest of the run, simulate with an aborted request and say so.

### PH-UX-03 — Copy and typos
- Priority: P3
- Steps: read the create form, onboarding, counter, inventory, and purchasing headings.
- Expected: no placeholder lorem, no “TODO”, no schema enum as the only label (`NOT_STARTED` may appear if a human label is beside it), no restaurant words (“menu”, “table”, “KDS”) in pharmacy nav. Record each slip.
- Evidence: notes plus screenshots of offenders.

### PH-RS-01 — Mobile and tablet
- Priority: P1
- Steps: at 390×844 and 768×1024, open login, dashboard, onboarding, counter, and inventory. Open and close the nav.
- Expected: no horizontal page scroll on login and onboarding. Counter remains usable (search, cart, and tender reachable). Nav does not cover content permanently. Buttons are at least 40px where the design system asks for a 40–44px target.
- Evidence: screenshots.

### PH-A11Y-01 — Keyboard and labels
- Priority: P1
- Steps: from the platform login and the counter, tab through the form. Use only the keyboard to search and add a line if a keymap is advertised.
- Expected: focus is visible. Every input has a label. Icon-only buttons have accessible names. Tab order is not trapped. The counter search is reachable without a pointer.
- Evidence: notes and a focused-control screenshot.

### PH-A11Y-02 — Contrast smoke
- Priority: P2
- Steps: run axe-core on platform login, tenant dashboard, onboarding, and counter.
- Expected: no serious or critical color-contrast or button-name violations. Minor violations are filed as P3 if they are real.
- Evidence: axe JSON summary in the report.

### PH-PF-01 — Performance smoke
- Priority: P2
- Steps: measure navigation timing for `/dashboard`, `/pharmacy`, `/pharmacy/counter`, and `/pharmacy/inventory` on a warm server.
- Expected: each HTML document returns in under 3 seconds locally, and the main heading is visible in under 5 seconds. Record the numbers even when they pass. A hang or a multi-ten-second server action is a fail.
- Evidence: timing log.

---

## O. Security extras

### PH-SEC-01 — Unauthenticated tRPC and REST
- Priority: P0
- Steps: with no cookie, POST `/api/trpc/pharmacySales.counterSearch`, `/api/trpc/pharmacyInventory.lots` (or the procedures the router actually exposes), `GET /api/pharmacy/print`, and `POST /api/pharmacy/counter/replay`.
- Expected: 401 or 403. Bodies do not contain Clifton stock or receipts.
- Evidence: statuses.

### PH-SEC-02 — Supplier portal token
- Priority: P0
- Steps: call `pharmacySupplierLinks.get` with no token, with a random token, and with a token issued for Clifton while sending Rival’s organization id if the procedure accepts one.
- Expected: no data without a valid token. A token returns only that supplier’s documents. A mismatched org id does not widen it.
- Evidence: responses.

### PH-SEC-03 — Platform route as a tenant user
- Priority: P0
- Steps: as the Clifton owner, `POST /api/platform/control` to suspend Rival, and open `/platform/organizations`.
- Expected: 401 or 403. Rival’s status unchanged. Tenant UI does not show the control desk.
- Evidence: response.

### PH-SEC-04 — Session fixation and logout
- Priority: P2
- Steps: sign out of the tenant. Use the browser back button and reload `/pharmacy/counter`. Call a tRPC query with the discarded cookie.
- Expected: the counter is gone. The old cookie is rejected.
- Evidence: screenshot and status.

### PH-SEC-05 — Security headers
- Priority: P3
- Steps: inspect response headers on `/login`.
- Expected: `X-Frame-Options: DENY` or equivalent frame-ancestors, `X-Content-Type-Options: nosniff`, a Content-Security-Policy, no `X-Powered-By`.
- Evidence: header dump.

---

## P. Dead ends and defaults called out in the product map

### PH-GAP-01 — Commercial route prefixes that are not pages
- Priority: P2
- Steps: as admin, open `/pharmacy/procurement`, `/pharmacy/dispensing`, `/pharmacy/safety`, `/pharmacy/crm`.
- Expected: either a redirect to the real page or a deliberate not-found. A raw Next.js 404 is acceptable if the nav never links there. A 500 is a fail.
- Evidence: status and screenshot.

### PH-GAP-02 — Timezone and currency defaults
- Priority: P2
- Steps: on the pharmacy create form, read the default timezone and currency before changing them. Create is already PKR and Asia/Karachi in PH-SA-04; this case records the untouched defaults.
- Expected: a Pakistan premises form should not silently default a new pharmacy to UTC and USD without the operator noticing. If the defaults are UTC and USD, this case fails as a usability defect.
- Evidence: screenshot of the untouched defaults.

### PH-GAP-03 — Activation after the honest gates
- Priority: P0
- Preconditions: evidence gates that have real data are satisfied, attested gates are attested in the UI, regulatory profile is acceptable, deployment marked ready only through the product’s own control (or the deployment section’s supported action).
- Steps: apply ACTIVE.
- Expected: status becomes ACTIVE, or the refusal names a specific unmet rule the operator can act on. A refusal that cites a gate the UI shows as PASSED is a fail. A refusal that asks for a surface the product says does not exist is a fail.
- Evidence: screenshot of gates and of the lifecycle result.

---

## Coverage map

| Journey area | Cases |
| --- | --- |
| Setup | PH-SET-01 … 03 |
| Super admin create and grant | PH-SA-01 … 08 |
| First login and onboarding | PH-ON-01 … 06 |
| Store and regulatory | PH-ST-01 … 04 |
| Users and roles | PH-UR-01 … 04, PH-PM-01 … 03 |
| Products | PH-PR-01 … 03 |
| Inventory, batches, expiry | PH-IN-01 … 05 |
| Purchasing and suppliers | PH-PU-01 … 05 |
| POS and billing | PH-POS-01 … 04, 08 |
| Returns and refunds | PH-POS-07, PH-PU-04 |
| Discounts | PH-POS-05 |
| Customers | PH-POS-06, PH-NT-03, PH-CL-02 |
| Reports | PH-RP-01 … 03 |
| Notifications and WhatsApp | PH-NT-01 … 02 |
| Settings | PH-SE-01 … 03 |
| Revocation | PH-RV-01 … 04 |
| Multi-tenant | PH-MT-01 … 04 |
| Validation and security | PH-VL-01 … 04, PH-SEC-01 … 05 |
| UI, responsive, a11y, performance | PH-UX-01 … 03, PH-RS-01, PH-A11Y-01 … 02, PH-PF-01 |
| Known structural gaps | PH-GAP-01 … 03 |
