# Restaurant test cases

Commit: `fa3658b715bf2e672f7e38f983b558d8d86b5a75`.
Priority: P0 blocks a restaurant release, P1 is the service path, P2 is back office, P3 is polish.

Accounts created during execution (not the agency seed):

- Platform super admin: `PLATFORM_ADMIN_EMAIL` from the untracked local env.
- Restaurant Enterprise administrator: `qa-karahi-owner@example.com` / `QaRestaurant!Owner2026` on organization **QA Karahi House**.
- Restaurant Essentials administrator: `qa-essentials-owner@example.com` / `QaRestaurant!Owner2026` on **QA Karahi Essentials**, used only for the location cap.
- Agency comparison user: `alex@company.com` with `SEED_PASSWORD`.

Global preconditions, unless a case says otherwise: PostgreSQL is migrated and seeded, the dev server is listening on port 3000, and hosts `devfathom.localhost` and `admin.localhost` resolve to loopback.

## Setup

### SET-01 — Documented local migrate boots a fresh database

- Priority: P0
- Preconditions: empty PostgreSQL database, dependencies installed, no prior `_prisma_migrations` rows. Follow `docs/LOCAL_SETUP.md` only.
- Steps: Copy `.env.example` to `.env.local`, create `devfathom`, run `bunx prisma migrate deploy`.
- Expected: All migrations apply. The guide names every command required, including extension hardening if the migrate cannot succeed without it.

### SET-02 — Seed and both realms respond

- Priority: P0
- Preconditions: SET-01 recovered so migrations are applied. `SEED_PASSWORD` and platform admin credentials are set.
- Steps: Run `bun run db:seed`. Open `/login` on the tenant host and `/platform/login` on the admin host.
- Expected: Seed completes and prints agency logins. Both pages return HTTP 200 and show a sign-in form. Seed does not invent a restaurant tenant.

### SET-03 — Platform MFA enrollment is explained

- Priority: P1
- Preconditions: Fresh platform admin, `PLATFORM_MFA_ENFORCE` unset.
- Steps: Sign in at `/platform/login` with the seeded platform email and password.
- Expected: If MFA enrollment is required, the screen says so and offers a setup key. The local setup guide tells the operator this will happen. Enrollment completes with a valid 6-digit TOTP and lands on `/platform`.

## Onboarding

### ONB-01 — Type is not preselected

- Priority: P0
- Preconditions: Platform session with organization-create capability.
- Steps: Open `/platform/organizations/new`.
- Expected: Agency, Restaurant, Pharmacy, and Hospitality are shown. No type is selected. Nothing is created. Copy says the type cannot be changed after activation.

### ONB-02 — Restaurant form asks for the first outlet

- Priority: P0
- Preconditions: ONB-01.
- Steps: Continue as Restaurant.
- Expected: Only active restaurant packages are listed. Fields include display name, legal name, slug, deployment, package, seats, currency, timezone (default Asia/Karachi), first branch name, address, business-day cutoff, locale, contact, administrator name, email, and a password of at least 12 characters. Dedicated enterprise is hidden or disabled when Vercel is not configured. Submit label is "Create onboarding record". Helper copy says the result is ONBOARDING, not an active restaurant.

### ONB-03 — Empty restaurant submit is blocked

- Priority: P1
- Preconditions: ONB-02.
- Steps: Clear required fields and submit.
- Expected: The browser or the form focuses the first invalid field and does not create an organization. No raw stack trace.

### ONB-04 — Create QA Karahi House on Enterprise

- Priority: P0
- Preconditions: ONB-02. Slug `qa-karahi-house` is unused.
- Steps: Display name QA Karahi House, legal name QA Karahi House (Pvt) Ltd, slug `qa-karahi-house`, shared deployment, Restaurant Enterprise, 25 seats, currency PKR, timezone Asia/Karachi, branch Clifton, address "14 Sea View, Karachi", cutoff 04:00, contact Ayesha Khan / `qa-karahi-contact@example.com`, administrator Ayesha Khan / `qa-karahi-owner@example.com` / `QaRestaurant!Owner2026`. Submit.
- Expected: Redirect to the organization detail page. Status ONBOARDING. Vertical RESTAURANT. One default branch MAIN named Clifton. Enterprise modules are enabled, including core, POS, menu, inventory, purchasing, loyalty, insights, and integrations. The administrator exists and is not a platform user.

### ONB-05 — Duplicate slug is rejected

- Priority: P1
- Preconditions: ONB-04.
- Steps: Start a second restaurant with slug `qa-karahi-house`.
- Expected: A conflict or validation error. The first organization is unchanged. No partial second tenant.

### ONB-06 — Agency package cannot be assigned to a restaurant

- Priority: P0
- Preconditions: Platform session. An agency package id is known from the catalog.
- Steps: POST `/api/platform/control` `organization.create` with `vertical: RESTAURANT` and that agency `packageId`, plus otherwise valid restaurant fields.
- Expected: HTTP 400. Message states the package is not available for the restaurant vertical. No organization row with that slug.

### ONB-07 — Tenant cannot open the control plane

- Priority: P0
- Preconditions: Restaurant administrator session on the tenant host.
- Steps: Open `http://devfathom.localhost:3000/platform` and POST `/api/platform/control` with the tenant cookie only.
- Expected: Platform pages are not served on the tenant host (redirect away or 404). The control API returns 404 on a non-admin host.

## Activation and lifecycle

### LCY-01 — Activation is refused before acknowledgements

- Priority: P0
- Preconditions: ONB-04, deployment not yet ready, acknowledgements empty.
- Steps: On the organization page, set lifecycle to ACTIVE with a reason of at least 10 characters and apply.
- Expected: Activation does not occur. The unmet list names the missing restaurant policy acknowledgements and any missing ready deployment, with a next action for each. Status stays ONBOARDING.

### LCY-02 — Save restaurant readiness

- Priority: P0
- Preconditions: LCY-01. Exactly one default branch.
- Steps: Save readiness with branch Clifton, the Karachi address, Asia/Karachi, cutoff 04:00, and checked acknowledgements for tax `QA-TAX-2026-01`, payment `QA-PAY-MOCK-2026-01`, device `QA-DEVICE-2026-01`, and operator `QA-OPERATOR-2026-01`.
- Expected: Save succeeds. Reloading the page keeps the four references. No provider, printer, or card terminal is created by the acknowledgement itself.

### LCY-03 — Shared deployment can be marked ready without Vercel

- Priority: P0
- Preconditions: LCY-02. Environment has no Vercel token.
- Steps: Use the shared-deployment action on the lifecycle gate, or run the platform job worker once.
- Expected: A production deployment is READY for the shared host. The operator is not forced to paste a Vercel project id for the default shared mode.

### LCY-04 — Manual activation

- Priority: P0
- Preconditions: LCY-02 and LCY-03.
- Steps: Move the organization to ACTIVE with reason "QA activation after readiness acknowledgements."
- Expected: Status becomes ACTIVE. An audit and lifecycle event record the operator and the reason. The tenant administrator can sign in.

### LCY-05 — Essentials organization activates

- Priority: P1
- Preconditions: Platform session.
- Steps: Create **QA Karahi Essentials** on Restaurant Essentials with branch DHA, address "1 Khayaban-e-Ittehad, Karachi", cutoff 05:00, administrator `qa-essentials-owner@example.com`. Complete readiness and activate.
- Expected: Status ACTIVE. Purchasing, loyalty, insights, and integrations are not entitled. Location limit is 1.

### LCY-06 — Suspend and resume

- Priority: P0
- Preconditions: LCY-04. Owner is signed in in another browser.
- Steps: Transition QA Karahi House to SUSPENDED with a reason. Attempt tenant sign-in and an authenticated restaurant API call with the old session. Resume to ACTIVE with a reason.
- Expected: Suspension blocks new sign-in and revokes the live session with a suspended or workspace-unavailable message, not a wrong-password message. Resume restores sign-in. Audit records both transitions.

## Branches

### BRN-01 — Default branch is visible

- Priority: P0
- Preconditions: LCY-04, owner signed in.
- Steps: Open `/restaurant/settings/branches`.
- Expected: Clifton is listed with a readable code MAIN, address, timezone, cutoff, and primary state. No raw database id is the only label.

### BRN-02 — Create a second branch on Enterprise

- Priority: P1
- Preconditions: BRN-01.
- Steps: Create branch "Boat Basin" with a distinct code and address. Reload.
- Expected: Both branches are active. Clifton remains primary. The new branch is selectable by name on staff, menu publication, and reports.

### BRN-03 — Primary cannot be deactivated in place

- Priority: P1
- Preconditions: BRN-02.
- Steps: Deactivate Clifton while it is still the primary.
- Expected: The action is refused with a visible reason. Clifton stays active and primary. After making Boat Basin primary, Clifton can be deactivated and remains in history.

### BRN-04 — Essentials blocks a second active branch

- Priority: P1
- Preconditions: LCY-05, essentials owner signed in.
- Steps: Create a second active branch.
- Expected: The save is refused because `restaurant.locations.max` is 1. The first branch is unchanged. The message names the plan limit, not an internal exception.

### BRN-05 — Invalid cutoff is rejected

- Priority: P2
- Preconditions: BRN-01.
- Steps: Edit Clifton cutoff to `25:99` and to `4pm`.
- Expected: Both are rejected. The stored cutoff stays `04:00`.

## Staff, roles, and credentials

### STF-01 — Owner can open staff

- Priority: P0
- Preconditions: Owner session.
- Steps: Open `/restaurant/staff` and `/restaurant/staff/roster`.
- Expected: Both pages render inside the restaurant shell. Empty staff beyond the bootstrapped administrator is an empty state with a way to add a person. No uncaught error.

### STF-02 — Create a cashier web user and floor profile

- Priority: P0
- Preconditions: STF-01. Team or staff UI can add a user.
- Steps: Create user Hina Cashier, `qa-karahi-cashier@example.com`, organization role Cashier, branch Clifton, and a floor job role Cashier with a PIN.
- Expected: Hina can sign in to the web app. She can open POS-related review surfaces she is allowed and cannot open tax administration, branch settings, purchasing approval, or financial reports. Her PIN is not shown again after it is set.

### STF-03 — Create kitchen and server profiles

- Priority: P1
- Preconditions: STF-01.
- Steps: Create Bilal Kitchen (`qa-karahi-kitchen@example.com`, Kitchen role) and Sana Server (`qa-karahi-server@example.com`, Server role), each with a unique PIN, assigned to Clifton.
- Expected: Kitchen can open KDS operations and cannot collect payment. Server can take orders and cannot refund or discount. Role templates match the catalog, not the job title alone.

### STF-04 — Explicit deny overrides the role

- Priority: P1
- Preconditions: STF-02.
- Steps: If the staff screen can deny a capability, deny `payments:collect` on Hina. Otherwise record the absence of a deny control as the result.
- Expected: When the control exists, Hina's next payment attempt is forbidden even though Cashier grants collect. When it does not exist, the case fails because the administrator guide says explicit user denies override role grants.

### STF-05 — PIN is not a web password

- Priority: P0
- Preconditions: STF-02. PIN is known to the tester.
- Steps: Sign in at `/login` using Hina's email and her PIN as the password. Separately, call a terminal unlock with the PIN.
- Expected: Web login rejects the PIN. Terminal unlock accepts the PIN only on an enrolled device for her branch.

### STF-06 — Roster shift

- Priority: P2
- Preconditions: STF-02.
- Steps: On the roster, create a Clifton shift for Hina covering today.
- Expected: The shift appears under her name and branch. An overlapping duplicate for the same person is rejected or visibly warned. Payroll and tip payout are not implied.

## Catalog, modifiers, recipes

### CAT-01 — Catalog empty state

- Priority: P1
- Preconditions: New Enterprise tenant, owner.
- Steps: Open `/restaurant/catalog`.
- Expected: Products, categories, modifiers, allergens, units, ingredients, and recipes are reachable. Counts start at zero or at a clearly labeled default brand. Empty copy tells the operator what to add. No spinner forever.

### CAT-02 — Create category and product

- Priority: P0
- Preconditions: CAT-01.
- Steps: Add category "Mains". Add product "Chicken Karahi" in Mains, active.
- Expected: Both persist after reload. The category is a parent of the product. Names render as text.

### CAT-03 — Modifier group and option

- Priority: P0
- Preconditions: CAT-02.
- Steps: Add modifier group "Heat" required, min 1 max 1. Add options Mild and Extra hot with a price delta of 50 PKR on Extra hot. Attach the group to Chicken Karahi.
- Expected: The product shows Heat with both options. Sort order is stable. POS later offers the options by name.

### CAT-04 — Validation

- Priority: P1
- Preconditions: CAT-01.
- Steps: Submit a category with an empty name, a 201-character name, and a negative modifier price if the field allows typing it.
- Expected: Empty and over-long names are rejected with a field message. Negative money is rejected. No partial row.

### CAT-05 — XSS in a product name

- Priority: P0
- Preconditions: CAT-01.
- Steps: Create a product named `<img src=x onerror=alert(1)>` and a category named `<script>alert(1)</script>`. Reopen the catalog and the POS menu.
- Expected: The strings display as text. No script runs. The DOM contains no injected element with that `onerror`.

### CAT-06 — Units, ingredient, recipe

- Priority: P1
- Preconditions: CAT-02.
- Steps: Create units g and kg with a conversion. Create ingredient Chicken with base unit kg and reference cost 700. Create a draft recipe for Chicken Karahi using 0.5 kg chicken and yield 4 portions. Activate it.
- Expected: The draft can be costed or shows a batch cost. Activation supersedes nothing on the first version and the active version is not editable in place. A missing conversion does not invent a reverse factor.

### CAT-07 — SQL injection in names and search

- Priority: P1
- Preconditions: CAT-01.
- Steps: Create a product named `Karahi' OR 1=1 --`. Use any catalog search with `' OR '1'='1`.
- Expected: The product is stored and found only by its literal name. Search does not return every row and does not 500.

## Menus and pricing

### MNU-01 — Menus empty state

- Priority: P1
- Preconditions: Owner.
- Steps: Open `/restaurant/menus`.
- Expected: A way to create a menu and a price version is visible. Nothing is published.

### MNU-02 — Price and publish to dine-in

- Priority: P0
- Preconditions: CAT-02, CAT-03, MNU-01.
- Steps: Create menu "Dinner", section "Mains", item Chicken Karahi at 1800.00 PKR, publish to Clifton for dine-in and takeaway.
- Expected: Price renders with two decimal places. Publication names the branch and channels. POS effective menu includes the item only after publish. A draft item is absent from POS.

### MNU-03 — Delivery publication is separate

- Priority: P1
- Preconditions: MNU-02.
- Steps: Leave delivery unpublished. Attempt a delivery order. Then publish the menu to Delivery and retry.
- Expected: Delivery order is refused until a Delivery publication exists. After publish, the item is available on that channel.

### MNU-04 — Menu import is operator-reachable

- Priority: P1
- Preconditions: Owner with `menu:import` (owner `*` includes it).
- Steps: From the restaurant sidebar, find Menu import. Open `/restaurant/menu-import` directly.
- Expected: The guide's destination is linked from restaurant navigation, or the page itself explains where it lives. The direct URL loads an upload console, not a 404. OCR may be unavailable without an AI key; that state must say extraction is unavailable rather than succeed with an empty menu.

### MNU-05 — Offers page

- Priority: P2
- Preconditions: `restaurant-menu` enabled.
- Steps: Open `/restaurant/promotions`. Create a 10% order discount named "QA weekday" if the form allows, with a required name and a percentage above 100.
- Expected: The page loads. 0 and 100 are bounded as the product specifies. A percentage of 150 or a blank name is rejected. Essentials, which includes menu, can open this page. A tenant without `restaurant-menu` cannot.

## Floor and tables

### FLR-01 — Floor empty state

- Priority: P1
- Preconditions: Owner, POS module on.
- Steps: Open `/restaurant/floor`.
- Expected: Empty state offers Add floor. No fake tables.

### FLR-02 — Floor, section, and tables

- Priority: P0
- Preconditions: FLR-01.
- Steps: Add floor "Ground". Add tables T1 and T2 with seats. Reload.
- Expected: Both tables show under Ground by name. They are selectable on a dine-in POS order. Internal ids are not required.

### FLR-03 — Duplicate table code

- Priority: P2
- Preconditions: FLR-02.
- Steps: Add another table named T1 on Ground.
- Expected: Rejected as a duplicate, or the two tables are disambiguated by a visible code. The operator can tell them apart.

## Orders

### ORD-01 — Orders empty state

- Priority: P1
- Preconditions: Owner, no orders yet.
- Steps: Open `/restaurant/orders`.
- Expected: Empty copy, not a zero-revenue chart pretending there was a day of sales. Filters for branch and status exist or their absence is noted.

### ORD-02 — Dine-in order

- Priority: P0
- Preconditions: Enrolled Clifton POS, server or cashier unlocked, MNU-02, FLR-02.
- Steps: New order, Dine in, table T1, add Chicken Karahi, choose Extra hot, fire.
- Expected: An order number is shown. The line price includes the 50 PKR modifier. The table shows occupied. The fired item reaches the Clifton KDS. A second identical fire with the same idempotency key does not duplicate the line.

### ORD-03 — Takeaway order

- Priority: P0
- Preconditions: ORD-02 device session.
- Steps: New order, Takeaway, add Chicken Karahi Mild, hold, then fire.
- Expected: Channel is takeaway. No table is required. Held items are not on the KDS. Fired items are.

### ORD-04 — Delivery requires customer, address, and zone

- Priority: P1
- Preconditions: MNU-03 delivery publication. Delivery zones page `/restaurant/delivery`.
- Steps: Create an active Clifton zone. Attempt delivery with no customer, then with a customer and no address, then with both.
- Expected: The first two attempts fail before an order id is consumed. The third creates a connected delivery order and freezes the zone fee. Offline delivery is refused.

### ORD-05 — Move and merge tables

- Priority: P1
- Preconditions: ORD-02 open on T1, T2 empty.
- Steps: Move the order to T2. Open a second dine-in on T1 and merge tables if the control is offered.
- Expected: Move updates the table without duplicating items. Merge combines checks or is refused with a visible rule. No typed order id.

### ORD-06 — Cancel and void rules

- Priority: P1
- Preconditions: An unfired takeaway and a fired dine-in.
- Steps: Cancel the unfired order. Void a fired item as the cashier, then with a distinct manager credential and a reason.
- Expected: Unfired cancel succeeds. Fired void is refused for the cashier and succeeds only with a different manager, a reason, and an audit trail.

## Kitchen

### KDS-01 — KDS without a device

- Priority: P1
- Preconditions: No KDS cookie in this browser.
- Steps: Open `/kds`.
- Expected: The page does not show another branch's tickets. It asks for enrollment or shows an unauthorized state.

### KDS-02 — Enroll KDS and bump

- Priority: P0
- Preconditions: ORD-02 fired ticket. A browser enrolled as KDS for Clifton and a station that receives the item.
- Steps: Unlock as Bilal. Acknowledge, mark ready, recall if the control exists.
- Expected: The ticket shows the order number, item, and Extra hot modifier. Transitions follow the allowed sequence. A repeated bump does not corrupt the ticket. Recall returns it to an active state only when the product allows.

### KDS-03 — Disconnect copy

- Priority: P2
- Preconditions: KDS-02.
- Steps: Stop the network for the KDS page (offline mode) and restore it.
- Expected: The board keeps the last confirmed state and shows a recovery alert with retry. It does not claim the kitchen is fully operational while disconnected.

### KDS-04 — Delivery handoff

- Priority: P2
- Preconditions: A kitchen-ready delivery that is unpaid, and one that is prepaid.
- Steps: Dispatch the unpaid order as PREPAID, then as COD. Mark delivered.
- Expected: PREPAID dispatch is refused until payment is complete. COD can be dispatched with collection still due. Mark delivered records completion. Marketplace riders are not implied.

## Billing

### PAY-01 — Bill the dine-in check

- Priority: P0
- Preconditions: ORD-02 items served or the product allows close from the current state.
- Steps: Close the check with no split. Read subtotal, modifier, tax if a profile is active, and total.
- Expected: The total equals the sum of snapshotted lines plus disclosed tax and service charge. Two decimal places. The receipt does not show a card number.

### PAY-02 — Split by item and by seat

- Priority: P0
- Preconditions: An order with two items and two seats, or the split controls on PAY-01.
- Steps: Split one item to a second bill. Attempt a fractional split that does not sum to 100%.
- Expected: Item split allocates the whole item once. A fraction that does not total the check is rejected. Remaining due is exact.

### PAY-03 — Cash tender, tip, and change

- Priority: P0
- Preconditions: PAY-01 balance due, drawer open with a float.
- Steps: Tender cash greater than the total and enter a tip. Then tender cash less than the remaining due.
- Expected: Change is total tender minus amount applied minus tip, without a rounding surprise beyond the currency minor unit. Insufficient cash does not mark the bill paid. The drawer expected cash includes the sale.

### PAY-04 — Mock card is not an authorization

- Priority: P0
- Preconditions: PAY-01.
- Steps: Choose card tender and read every label on the tender and the receipt.
- Expected: The UI calls the card an operator-confirmed or mock record. It does not say approved by the bank, captured, or settled. No PAN or CVV field is stored in the receipt payload.

### PAY-05 — Discount permission

- Priority: P1
- Preconditions: Server or cashier session, and a manager session.
- Steps: Apply a 10% discount as the cashier. Repeat as a user who holds `orders:discount`.
- Expected: Cashier is refused. The authorized user can apply it once. A second identical idempotency key does not discount twice. A discount above the line total is refused.

### PAY-06 — Refund

- Priority: P0
- Preconditions: A settled cash bill. Cashier session and a distinct manager.
- Steps: Refund more than the captured amount. Refund the exact amount as the cashier. Refund the exact amount with the manager credential and a reason.
- Expected: Over-refund is refused. Cashier refund is refused. Manager refund posts once, reduces the refundable balance to zero, and a repeat does not pay the guest twice. The original business day is not silently rewritten.

### PAY-07 — Finance reconciliation

- Priority: P1
- Preconditions: PAY-03 and PAY-06 posted. Owner or accountant.
- Steps: Open `/restaurant/money`. Filter Clifton and today's business date. Open bills, payments, drawers, and daily close.
- Expected: The settled bill, tender, tip, change, and refund appear. Figures match the POS. The page is read-only. A kitchen user receives a permission state before ledger rows load.

### PAY-08 — Daily close

- Priority: P1
- Preconditions: Open drawer with the cash sale.
- Steps: Preview close, enter the counted cash, close the drawer and the day. Reopen the preview.
- Expected: Expected, declared, and variance are stored. Closing again is refused or requires the manager correction path with a reason. Variance is not auto-zeroed.

## Customers and loyalty

### LOY-01 — Loyalty empty state

- Priority: P1
- Preconditions: Operations or Enterprise (`restaurant-loyalty`). Owner.
- Steps: Open `/restaurant/loyalty`.
- Expected: Programs and accounts can be created, or an empty state explains how. Essentials owner is denied this module.

### LOY-02 — Create a guest and attach at checkout

- Priority: P1
- Preconditions: LOY-01. An open check.
- Steps: Create guest "Nadia Qureshi" with phone `03001234567`. At POS, search Nadia and attach her. Search a phone that does not exist.
- Expected: Attach succeeds without showing another tenant's guests. Unknown search is empty, not an error banner that dumps SQL. The guest is not duplicated when attach is repeated.

### LOY-03 — Earn and redeem

- Priority: P1
- Preconditions: LOY-02. A program that earns points on the settled total.
- Steps: Settle a bill so points earn. Redeem more points than the balance. Redeem a legal amount. Replay the redeem request.
- Expected: Balance never goes negative. Replay does not redeem twice. Reversal of the refund in PAY-06 adjusts liability rather than deleting the earn row.

### LOY-04 — Essentials denial

- Priority: P1
- Preconditions: LCY-05 owner.
- Steps: Open `/restaurant/loyalty` and call the loyalty tRPC procedures.
- Expected: HTTP 403 or a module-disabled page. No loyalty rows are written.

## Inventory, recipes, purchasing

### INV-01 — Inventory empty state

- Priority: P1
- Preconditions: Owner, inventory module on.
- Steps: Open `/restaurant/inventory`.
- Expected: On-hand, movements, counts, and wastage are present. Empty stock is "no stock", not a crash. Low stock is empty until a threshold exists.

### INV-02 — Receive stock and record waste

- Priority: P1
- Preconditions: CAT-06 ingredient linked to a stock item, or the inventory UI can create one.
- Steps: Post a receipt of 10 kg chicken. Record 0.2 kg wastage. Reload the movement list.
- Expected: On-hand is 9.8 kg. Wastage is its own movement type, not an edited balance. A negative receipt is rejected.

### INV-03 — Recipe consumption on sale

- Priority: P2
- Preconditions: INV-02 and a settled Chicken Karahi if the product consumes stock at settle or at fire.
- Steps: Compare on-hand before and after the sale that the guide says consumes the BOM.
- Expected: Consumption matches the active recipe quantity, once. A replay does not consume twice. If this build does not consume on sale, the UI must not claim that it did.

### INV-04 — Purchasing lifecycle

- Priority: P1
- Preconditions: Enterprise or Operations, so `restaurant-purchasing` is on. Essentials is the negative case.
- Steps: Create a supplier if required, draft a PO for chicken, submit, approve, and receive a partial quantity. Open the same route as the Essentials owner.
- Expected: Each status advances only forward. Partial receipt leaves a remaining quantity. Essentials is denied. Approve requires the purchasing capability; a cashier cannot approve.

### INV-05 — Count correction

- Priority: P2
- Preconditions: INV-02.
- Steps: Post a stock count that sets chicken to 9.8 kg, then a count of -1.
- Expected: The matching count posts no surprise variance or posts zero variance with a reason. Negative counted quantity is rejected.

## Catering

### CATR-01 — Catering console

- Priority: P2
- Preconditions: Owner, Restaurant Core.
- Steps: Open `/restaurant/catering`. Create a draft event "QA nikah" for 80 guests on a future date at Clifton.
- Expected: The draft is listed by event name and date. Status cannot jump to DELIVERED. Cancel is available before close.

### CATR-02 — Recipe line cost

- Priority: P2
- Preconditions: CATR-01 and CAT-06 active recipe.
- Steps: Add a recipe line for 80 portions at 750 PKR. Read ingredient cost and margin against a 60,000 PKR quote.
- Expected: Cost uses the active recipe until confirmation, then freezes. Margin matches quote minus cost minus extras. A zero quote does not show a fake 0% margin if the guide says the percentage is unavailable.

## Reports and insights

### RPT-01 — Reports empty versus zero

- Priority: P1
- Preconditions: Owner, before and after PAY-03.
- Steps: Open `/restaurant/reports` for Clifton, today, before any sale and again after the sale. Export CSV.
- Expected: Before sales, sections say no matching data rather than a misleading zero that looks like a closed day of nothing if the product distinguishes those states. After sales, the cash tender appears in the financial section. CSV uses the same branch and date. A kitchen user does not receive the financial CSV.

### RPT-02 — Food cost and dish class

- Priority: P2
- Preconditions: A settled costed item and `reports:financial`.
- Steps: Open food cost and dish profitability for Clifton.
- Expected: Chicken Karahi is costed from the active recipe. An item with no recipe is listed as a costing exception and is not treated as zero cost. Classifications are explained.

### RPT-03 — Insights module

- Priority: P2
- Preconditions: Enterprise owner, and essentials owner.
- Steps: Open `/restaurant/insights` and the dashboard management overview as each.
- Expected: Enterprise can load the reconciled view. Essentials sees the module disabled state. Dashboard edit, save, and restore default do not 500.

### RPT-04 — All-branch scope

- Priority: P2
- Preconditions: BRN-02. A user without `restaurant:configure` if one exists (cashier).
- Steps: As owner, run a report for all active branches. As cashier, attempt the same.
- Expected: Owner totals include only branches they may read. Cashier cannot pull the all-branch financial set.

## Notifications and WhatsApp

### NTF-01 — Notifications page

- Priority: P1
- Preconditions: Owner.
- Steps: Open `/restaurant/notifications`.
- Expected: The page explains the HTTPS webhook, signing secret, test send, and dead letters. The secret is write-only after save. A blank URL is rejected. An `http://` URL is rejected if the contract requires HTTPS.

### NTF-02 — Test event

- Priority: P2
- Preconditions: NTF-01. A local receiver or an intentionally bad URL.
- Steps: Save `https://127.0.0.1/qa-webhook` or the product's allowed test target and queue a test. If the product refuses loopback, record the message.
- Expected: The attempt is visible as success, retry, or dead letter. The UI does not claim the receiver accepted the event when the connection failed.

### NTF-03 — WhatsApp

- Priority: P1
- Preconditions: Owner, restaurant navigation and notifications, loyalty, and settings.
- Steps: Search the restaurant UI for WhatsApp. Read the notification page.
- Expected: Restaurant docs do not ship WhatsApp. The restaurant UI either omits it or labels it unavailable. It must not present a send button that fails silently or posts guest messages to the pharmacy WhatsApp seam.

## Settings, tax, devices, cameras

### CFG-01 — Tax profile

- Priority: P1
- Preconditions: Owner, POS module.
- Steps: Open `/restaurant/tax`. Start a Pakistan preset or a custom Clifton profile with inclusive pricing, a cash rate, and an approval reference. Leave the accountant confirmation unchecked and save. Then check it and publish.
- Expected: Unconfirmed publish is refused. Published profile shows the branch and dates. A cashier cannot open the page. The page does not say DevFathom files the return.

### CFG-02 — Device list and enroll POS

- Priority: P0
- Preconditions: Owner on the browser that will be the register. POS module on.
- Steps: Open `/restaurant/devices`. Enroll this browser as POS for Clifton.
- Expected: The administrator web session ends. The browser lands on `/pos` and establishes a device session. The device appears by the name the operator chose. A second enroll of a lost secret is documented as revoke and re-enroll.

### CFG-03 — Cameras entitlement

- Priority: P2
- Preconditions: Enterprise owner and essentials owner.
- Steps: Open `/restaurant/integrations/cameras` as each.
- Expected: Enterprise shows a gateway selector by name, or an empty state. Essentials is module-disabled. No field asks for a raw gateway id as the only input.

### CFG-04 — Organization settings and receipt layout

- Priority: P2
- Preconditions: Owner.
- Steps: Open `/settings` and `/settings/receipts`.
- Expected: Profile and receipt layout load. Receipt preview uses the restaurant name. A script in the restaurant display name cannot execute in the preview.

### CFG-05 — Growth route

- Priority: P3
- Preconditions: Owner.
- Steps: Look for growth in the sidebar. Open `/restaurant/growth`.
- Expected: If the page is a supported operator surface, it is linked and loads. If it is internal, the direct URL does not look like a broken customer page.

## Revocation

### REV-01 — Disable POS module

- Priority: P0
- Preconditions: CFG-02 enrolled device, platform operator.
- Steps: Disable `restaurant-pos` for QA Karahi House. Call a terminal order route with the device cookie. Re-enable the module.
- Expected: The device receives 403 while the module is off, even though the device secret is still valid. Web POS navigation is hidden or denied. Re-enable restores operation.

### REV-02 — Revoke the device

- Priority: P1
- Preconditions: CFG-02. A second staff member who can approve.
- Steps: Revoke the POS device. Retry a terminal heartbeat with the old cookie.
- Expected: Revoke requires a distinct approver when the guide says so. The next request is 401 or 403. Offline drafts for that device are discarded.

### REV-03 — Deactivate the cashier

- Priority: P1
- Preconditions: STF-02 signed in.
- Steps: Set Hina to inactive. Refresh her session and try to sign in again.
- Expected: The live session ends. Sign-in is refused with an inactive-account message. Her historical orders remain attributable.

### REV-04 — Terminate is not a silent delete

- Priority: P2
- Preconditions: A disposable restaurant (use Essentials after its cases, or stop before this case if data is still required).
- Steps: Transition to TERMINATED with a reason. Sign in as that owner.
- Expected: Access is blocked. The platform still shows the organization and its lifecycle history. Data is not purged until the purge state and retention window.

## Permissions and isolation

### PERM-01 — Cashier navigation

- Priority: P0
- Preconditions: STF-02.
- Steps: Sign in as Hina. Visit `/restaurant/tax`, `/restaurant/settings/branches`, `/restaurant/purchasing`, `/restaurant/money`, `/restaurant/sop/admin`.
- Expected: Each denied surface is a permission or module state, not a half-rendered ledger. Allowed pages (orders she may read, POS) still load.

### PERM-02 — Kitchen cannot pay

- Priority: P0
- Preconditions: STF-03.
- Steps: As Bilal, POST checkout tender and refund for a known order.
- Expected: 403. No tender row is created.

### PERM-03 — Server cannot discount or refund

- Priority: P1
- Preconditions: STF-03.
- Steps: As Sana, call the discount and refund routes.
- Expected: 403. Bill totals unchanged.

### PERM-04 — Accountant can read money and cannot take orders

- Priority: P2
- Preconditions: An accountant user if STF creation allows it; otherwise create one.
- Steps: Open `/restaurant/money` and attempt POS order create.
- Expected: Money is readable. Order create is denied.

### TNT-01 — Agency user sees no restaurant operations

- Priority: P0
- Preconditions: `alex@company.com` signed in. QA Karahi House has a category and an order.
- Steps: Open `/restaurant/catalog`, `/restaurant/orders`, and `/pos`. Call `restaurantCatalog.listCategories` with Alex's cookie.
- Expected: Alex is denied or sees only the agency shell. He does not see Chicken Karahi, Clifton, or the Karahi order.

### TNT-02 — Restaurant user sees no pharmacy workspace

- Priority: P0
- Preconditions: Owner of QA Karahi House. This overlaps issue `#59` if pharmacy links render.
- Steps: Sign in and read the primary navigation at 1440×900. Open `/pharmacy` and `/pharmacy/counter`.
- Expected: Pharmacy onboarding, counter, and regulatory links are absent. Direct pharmacy URLs are denied. If they are present, add evidence to the existing issue instead of filing a second one.

### TNT-03 — Two restaurants do not share rows

- Priority: P0
- Preconditions: ONB-04 and LCY-05, each with at least one category.
- Steps: As the Enterprise owner, `getProduct` or `listCategories` and also request the Essentials category id. Repeat in the other direction.
- Expected: Each list contains only that tenant's rows. A foreign id is not found. It is not returned with the other tenant's name.

### TNT-04 — Platform session is not a tenant session

- Priority: P0
- Preconditions: Platform operator signed in on the admin host. No tenant cookie.
- Steps: Call `http://devfathom.localhost:3000/api/trpc/restaurantCatalog.listCategories` with the platform cookie, and with no cookie.
- Expected: Both are unauthorized. Platform audit data is not in the response body.

### TNT-05 — IDOR on order detail

- Priority: P0
- Preconditions: A real order id from QA Karahi House.
- Steps: As the Essentials owner and as Alex, GET `/api/restaurant/orders/detail` with that id. Also try `organizationId` of Karahi House in the query string.
- Expected: 404 or 403. The response body does not include the guest, table, or line items.

## Validation, state, UX, accessibility, performance

### VAL-01 — Money precision

- Priority: P1
- Preconditions: A price field.
- Steps: Enter `1800.999` and `1e2` as a price.
- Expected: The value is rejected or rounded by a stated rule to minor units. It is not stored as a binary float that displays `1800.998999`.

### VAL-02 — Slug and email shape

- Priority: P2
- Preconditions: ONB-02.
- Steps: Slug `QA Karahi`, email `not-an-email`, password `short`.
- Expected: Each field explains the rule. Nothing is created.

### STA-01 — Loading and error recovery

- Priority: P2
- Preconditions: Owner.
- Steps: Throttle the network to Slow 3G and open catalog. Then stop the server briefly and reload orders, and start it again.
- Expected: A loading state is visible on the slow open. The failed reload is an error with a retry, not a blank shell. Console has no uncaught exception on the success path.

### STA-02 — Empty states across the shell

- Priority: P1
- Preconditions: Essentials owner before any catalog work, and Enterprise owner before orders.
- Steps: Open orders, inventory, purchasing, loyalty, floor, menus, notifications, and reports.
- Expected: Each first visit has an empty or module-disabled state with a sentence that says what to do. No "undefined", "NaN", or "[object Object]".

### UX-01 — Shell consistency

- Priority: P2
- Preconditions: Owner at 1440×900.
- Steps: Visit dashboard, catalog, orders, money, and settings. Compare sidebar, page title, and primary buttons with the Studio shell.
- Expected: One sidebar, one page heading, primary actions use the same button treatment. Restaurant pages do not invent a second header or a raw unstyled form.

### UX-02 — Mobile

- Priority: P1
- Preconditions: Owner at 390×844.
- Steps: Open dashboard, catalog, orders, and the platform onboarding type step. Open the navigation.
- Expected: No horizontal page scroll. Navigation can be opened and a restaurant destination chosen. Primary actions remain on screen. POS is usable without a desktop-only hover.

### UX-03 — Copy

- Priority: P3
- Preconditions: The pages visited above.
- Steps: Read headings, empty states, and errors captured in evidence.
- Expected: Customer-facing strings say restaurant, branch, and guest, not "tenant", "organizationId", or "Prisma". Errors do not expose stack traces.

### A11Y-01 — Axe on primary pages

- Priority: P1
- Preconditions: Owner session, desktop.
- Steps: Run axe WCAG 2 A/AA on login, platform organization detail, dashboard, catalog, menus, floor, orders, money, loyalty, reports, notifications, and POS.
- Expected: No critical or serious violations. Focus is visible on the sign-in fields and the first dialog. Icon-only controls have names.

### A11Y-02 — Dialog and keyboard

- Priority: P2
- Preconditions: CAT-02 dialog.
- Steps: Open Add category with the keyboard, tab through the fields, press Escape.
- Expected: Focus moves into the dialog, is trapped, and returns to the button that opened it. Escape closes it without saving.

### SEC-01 — Unauthenticated API

- Priority: P0
- Preconditions: No cookies.
- Steps: GET and POST `/api/restaurant/orders/open`, `/api/restaurant/checkout/tender`, `/api/restaurant/checkout/refund`, `/api/restaurant/kds/queue`, and `restaurantCatalog.listCategories`.
- Expected: 401 or 403 on every call. No order is created. Response bodies do not list tenants.

### SEC-02 — Mutation without idempotency key

- Priority: P1
- Preconditions: Valid device session.
- Steps: POST an add-item or tender body without the idempotency header, then with an empty key.
- Expected: Both are rejected. No line or tender is written.

### SEC-03 — Cross-realm cookie

- Priority: P0
- Preconditions: Platform session cookie and tenant session cookie.
- Steps: Send the platform cookie to a tenant mutation and the tenant cookie to `/api/platform/control` on the admin host.
- Expected: Each realm rejects the other cookie. A tenant cannot transition an organization.

### PERF-01 — Warmed navigation smoke

- Priority: P3
- Preconditions: Each route opened once so dev compile is finished.
- Steps: Reload dashboard, catalog, orders, and reports and record the navigation time.
- Expected: Warmed reloads complete. A warmed route that stays blank past 8 seconds is a defect. Cold compile time is recorded and is not itself a failure.

## Traceability

Execution status for every id is written to `qa/restaurants/evidence/results.json` and summarized in `qa/restaurants/03-execution-report.md`.
