# Restaurant administrator and operator guide

This guide covers the restaurant product delivered in `restaurant/v1` at
`27b4e51165428e00248edc12d1b6e175f31933a6`. It is for restaurant administrators,
managers, cashiers, servers, kitchen staff, and SOP operators.

## What the status labels mean

- **Delivered** — a user-facing route and the named controls exist in this release.
- **Configuration-dependent** — delivered, but visible or usable only when the organization has
  the relevant module and the signed-in user has the required capability and branch access.
- **Externally provisioned** — a platform administrator or implementation contact must perform the
  setup; there is no restaurant-user control in this release.
- **In progress** — do not plan an operating procedure around it yet.

All restaurant routes are configuration-dependent. A missing navigation item is normally an
entitlement or permission boundary, not an empty dataset.

## Before the first service

### 1. Restaurant onboarding and branches

Organization creation, restaurant activation, module entitlements, and branch creation are
**externally provisioned**. Give your implementation contact each branch's display name, timezone,
business-day cutoff, and operating requirements. After provisioning, confirm that the restaurant
links appear on `/dashboard` and that the expected branch appears by name in `/restaurant/menus`.

Keep branch display names distinct. Some delivered admin filters still ask for **Branch ID**. Obtain
that value from a branch-backed screen rather than a database or support query:

- `/restaurant/devices` shows each device's branch name and branch ID.
- `/restaurant/menus` presents branches by name when creating a publication.
- `/restaurant/sop/admin` and `/restaurant/sop/reports` present active branches by name.

Copy the value exactly only when a route explicitly asks for it. Never guess an ID, reuse one from
another organization, or bypass a denied branch.

### 2. Staff, job roles, permissions, and shifts

Go to `/restaurant/staff` (**Delivered**).

1. Select **Add staff** and enter the person's operational profile details and primary branch.
2. Use **Edit** to maintain the profile and access status.
3. Use the credential action to issue, reset, revoke, or unlock an operator PIN. Give the PIN only
   to its operator; administrators cannot retrieve an existing PIN.
4. Use **Job roles** to assign branch-scoped job roles. Saving changes only the selected branch.
5. Use `/restaurant/staff/roster` to choose a branch and date range, then create or edit shifts.
   Only active staff assigned to that branch can be scheduled and sign in there.

Permissions remain capability-based and branch-scoped. A manager approval must come from a
different eligible operator where the control requires co-authorization. Never share a manager PIN
or enter it to work around a denied action.

The richer **role-profile B2** experience is **in progress**. Use only the job-role controls that are
visible in `/restaurant/staff`; do not assume an unpublished role profile grants access.

### 3. Devices and operator PINs

Go to `/restaurant/devices` (**Delivered**).

1. Select the enrollment action, name the terminal, and choose or enter its provisioned branch.
2. Complete the manager co-authorization when requested.
3. Copy the one-time enrollment secret directly into `/terminal` or `/pos`. Treat it as a secret:
   do not paste it into tickets, documentation, or chat. It is not recoverable later.
4. Confirm the device is **Active** and note its last-seen state. Use the revoke control only when a
   device is retired or compromised; revocation invalidates its session and device-bound offline
   work.

At `/terminal`, enroll once, select the operator shown for that branch, and enter the operator PIN.
Use **Lock**, **Unlock**, and **Switch operator** for handoffs. The POS route provides the same
device-session and operator-unlock boundary.

## Configure what the restaurant sells

### 4. Catalog, modifiers, allergens, ingredients, and recipes

Go to `/restaurant/catalog` (**Delivered**, Menu and Costing module required).

1. In **Categories**, create the reporting/menu hierarchy.
2. In **Products**, create each sellable item with its customer-facing name and description. Add
   variants where size or format must be priced separately.
3. In **Modifiers**, create a group, its minimum/maximum selection rules, and each option's price
   delta. Open the product and attach the group.
4. In **Allergens**, create the controlled labels, then attach them to products.
5. In **Units**, create measures and conversions before ingredients and recipes.
6. In **Ingredients**, set the base unit and optional reference cost.
7. In **Recipes**, create the recipe, add ingredient or sub-recipe lines, then publish the completed
   version. Published versions are historical records; create a new version for later changes.

Product, variant, modifier, ingredient, and recipe selectors use their names. Where a detail page
shows an internal identifier, it is reference information, not a value users should manufacture.

### 5. Prices and publication

Go to `/restaurant/menus` (**Delivered**, Menu and Costing module required).

1. Create a **Brand**, then a canonical **Menu** for that brand.
2. Open the menu, add sections, and add catalog products or variants. Set the display name and sort
   order used on live channels.
3. In **Price lists**, create a named list and a version with **Effective from**. Add a price for
   every sellable product/variant that the menu needs, then publish the version.
4. In **Publications**, bind the menu to a branch, one or more channels, and the published price
   list. Add branch availability, dayparts, exceptions, or price overrides only where needed.
5. Publish the branch menu.
6. In **Effective preview**, choose the branch publication, channel, and instant. Confirm every item
   resolves with the expected price before service.

Do not delete or deactivate records to make a published menu change. Version prices and update the
publication so historical order snapshots remain intact.

### 6. OCR menu import and review

Go to `/restaurant/menu-import` (**Delivered**, Menu and Costing module required).

1. Under **Upload a menu**, choose the supported menu file and submit it.
2. Select the import under **Imports** and wait for extraction to finish.
3. In **Review queue**, inspect every line. Correct product name, category, price, currency, and
   description. Accept, reject, or merge the line into an existing product/variant as appropriate.
4. Under **Import the reviewed menu**, choose the final menu name and import only the reviewed rows.
5. Open the resulting draft in `/restaurant/menus`; verify sections, items, and draft prices before
   publishing. OCR output is a draft, never a publication approval.

### 7. Menus and channels

The publication channel is selected in `/restaurant/menus`. This release supports the channel
options shown by that control and resolves them through **Effective preview**. A publication can be
unpublished without deleting its history. Channel availability, branch timezone, dayparts,
exceptions, and price precedence all affect the live result.

Promotions **A2/A3** are **in progress**. Do not promise automatic promotion authoring, evaluation,
or stacking from this release's operator UI. Loyalty redemption is a separate delivered checkout
flow, described below.

### 8. Floor, tables, sections, and kitchen stations

Go to `/restaurant/floor` (**Delivered**, POS module required).

1. Enter a branch and optional business date. Use a branch ID copied from `/restaurant/devices` if
   the filter requires it.
2. Select **Add floor**, then add tables with a unique, staff-friendly **Table code** and capacity.
3. Add server sections for the business date and assign tables and an eligible staff member.
4. Add kitchen stations and routing rules for products or categories, with the intended priority.

The table code is the friendly identifier visible to staff. The current POS open-order control asks
for table IDs, but `/restaurant/floor` does not display them. Associating a new POS order with a
table or server section is therefore **not operable without externally provisioned identifiers** in
this release. Leave those fields empty where the service mode permits; do not query the database or
guess values. Record the limitation with your implementation contact before running dine-in service.

### 9. Taxes and service charges

Tax and service-charge calculation is **delivered but externally provisioned** in this release;
there is no restaurant-user tax-configuration route. Ask your implementation contact to confirm
effective dates, inclusive/exclusive behavior, rounding, and branch scope. Validate the result on a
test order at `/pos`: the order ticket shows **Subtotal**, **Tax**, and **Service** before payment.
Do not override calculated amounts manually.

### 10. Inventory, purchasing, and wastage

Recipes and ingredients are configured in `/restaurant/catalog` as described above.

- `/restaurant/inventory` (**Delivered**, Inventory module required) is the branch/date stock
  ledger. It shows balances, movements, and variance derived from the inventory records available
  to the branch.
- `/restaurant/purchasing` (**Delivered**, Inventory module required) provides **Supplier registry**,
  **New purchase order**, the **Purchase-order queue**, approval/cancellation controls, **Receive
  stock**, and receipt history. Select suppliers, locations, stock items, and units by their shown
  names; add a clear reference and expected date where useful.
- Post-preparation item voids at `/pos` require a wastage disposition and independent manager
  approval. The resulting order and stock history remains attributable.

The inventory route is read-only in this release. Counts, transfers, stock locations, low-stock
rules, and other inventory actions without a visible control are **externally provisioned**; do not
substitute raw database access. Purchasing actions are limited to the controls listed above.

## Run service

### 11. POS sign-in and drawer opening

Go to `/pos` (**Delivered**, POS module and an active enrolled device required).

1. On first use, enter the one-time device enrollment secret.
2. Select an eligible operator and enter that person's PIN. Five failed attempts lock the operator
   credential; stop and ask an authorized administrator to unlock/reset it.
3. Open **Drawer**, enter the opening float, and select **Open drawer**. Cash payments remain
   unavailable until a drawer is open.

### 12. Create and manage an order

Under **Open order**:

1. Select the channel shown by the control: dine-in, takeaway, or delivery.
2. For dine-in, enter covers. Table and section association is not self-service in this release:
   the POS requires IDs that `/restaurant/floor` does not expose. Leave those fields empty where
   permitted and use the restaurant's approved externally provisioned setup; do not guess values.
   Takeaway and delivery do not require a table.
3. Select menu items by name and set quantity, course, and seat. Adding an item without modifiers is
   delivered. An item that requires modifiers is **not operable through the current UI** because the
   POS asks for modifier-option IDs that `/restaurant/catalog` does not display. Do not bypass that
   boundary; ask the administrator to offer the item without required modifiers until the UI lands.
4. Submit the draft. On the order ticket use **Hold**, **Fire**, **Send**, **Served**, **Remake**,
   table move/merge, or **Close order** only as the service state requires.

The live menu comes from the branch/channel publication. Prices, tax, service charge, and item
snapshots are server-calculated; operators must not type a replacement price.

### 13. Discounts, complimentary items, voids, and refunds

- Loyalty redemption is **Delivered** in checkout: find the guest, attach the customer, enter the
  points, and select the redemption control. The server calculates the discount.
- General promotion discounts are **in progress** with promotions A2/A3. No manual-discount control
  is delivered on `/pos` in this release.
- Complimentary-item calculation and refund APIs are delivered, and receipts/`/restaurant/money`
  show comp and refund history. A general operator-facing comp/refund initiation control is **not
  delivered** in the canonical UI. Escalate to the authorized restaurant administrator's approved
  support workflow; never call an API or edit data directly.
- To void an item, select **Void**, give a reason, and confirm. A post-preparation void additionally
  requires wastage disposition and a different manager's profile/PIN. To cancel an entire order,
  use `/restaurant/orders`, open the order, and select **Cancel order** with the required attribution.

### 14. Split bills and payments

1. Select **Collect payment**. Create one bill or choose **Split bill**.
2. Split equally, by item groups, or by fractional weights as offered by **Split method**.
3. For each bill, select cash or card and enter only the fields shown. Multiple tenders can settle
   a bill; the remaining balance updates after each accepted tender.
4. Cash requires an open drawer and sufficient amount tendered. Card processing in this release is
   configuration-dependent; the verified default adapter is non-production, so confirm the live
   payment provider with your implementation contact before service.
5. Review the receipt after settlement, then close checkout/order when the balance is zero.

### 15. Drawer close and daily close

Open **Drawer**, record paid-in/paid-out movements with a reason as they occur, then:

1. Count physical cash and enter **Counted cash**.
2. Select **Close drawer** and review the expected-versus-counted variance.
3. Use `/restaurant/money` to select the branch and review **Bills**, **Payments**, **Drawers**,
   **Daily close**, and terminal audit views. Daily close/correction actions are permission- and
   state-dependent; use only controls presented to your role.

### 16. Offline behavior

The POS stores eligible order drafts on the enrolled device and replays them in order after
connectivity returns. The queue is capped at 50 drafts. Use the on-screen offline queue status:

- leave queued work on the device that created it;
- review conflicts instead of repeatedly resubmitting them;
- refresh the catalog after reconnecting and resolve any removed item, unavailable item, changed
  price, or closed-channel warning before sending;
- do not rely on offline card authorization, loyalty redemption, refunds, or manager approvals;
- understand that device revocation purges that device's queued work.

## Kitchen, guests, SOP, and reporting

### 17. KDS and kitchen tickets

Go to `/kds` (**Delivered**, KDS access and an active device required). Enter the device secret. The
route also requires an **Acting operator profile ID**, but it does not provide an operator chooser
or a user-visible source for that value. KDS connection is therefore **externally provisioned** in
this release; obtain the value through the approved implementation handoff, not a database query.
After connection, tickets are grouped by their displayed lane. Use the item actions shown to
acknowledge/start, complete/bump, or recall work. Use **Refresh** if the queue is stale and disconnect
the display before leaving it unattended. Station routing comes from `/restaurant/floor`.

### 18. Customers and loyalty

Go to `/restaurant/loyalty` (**Delivered**, Customers and Loyalty module required).

1. Search by the guest's visible name/contact identifier and select the result.
2. Review customer detail, tags, consent timeline, branch interactions, and loyalty ledger.
3. Create an account only when the customer has opted in. Configure a new effective-dated program
   version where authorized; old versions remain history.
4. Use **Manual adjustment** only with points and a clear reason. Export or anonymize customer data
   only under the approved privacy process and granted capability.

The wallet feature is **in progress**. Do not advertise, issue, or troubleshoot Apple/Google wallet
passes as a delivered restaurant-user flow in this release.

### 19. SOPs, checklists, proof, and manager verification

Administration at `/restaurant/sop/admin` is **Delivered** when the SOP module and configure
capability are present.

1. Create a template family and draft version, add ordered checklist steps, and publish it.
2. Create branch assignments and schedules against a published version.
3. Operators use `/restaurant/sop`: choose the branch/date, select an occurrence, start it, complete
   each checklist step, attach the requested evidence metadata, and submit.
4. An eligible manager verifies or rejects submitted work. Rejected work retains its evidence and
   can be corrected and resubmitted. A waiver requires a distinct co-authorizer.
5. Managers use `/restaurant/sop/oversight` for late/missed/escalated work and
   `/restaurant/sop/reports` for outcome, timeliness, proof, verification, and performance records.

Offline SOP execution and external evidence-file scanning are not delivered. Role/direct-person
assignment union under role-profile B2 remains **in progress**.

### 20. Insights and reports

Go to `/restaurant/insights` (**Delivered**, Insights module required). Enter the branch ID copied
from `/restaurant/devices`, choose the date range, and review **Financial**, **Operational**, and
**Labour** rollups. Select a business date for detail and use the route's export control for the
same filtered report. These are read-only rollups reconciled to the close chain; missing data can
mean the branch/date has not produced a rollup yet.

Use `/restaurant/money` for bill/payment/drawer/daily-close ledgers,
`/restaurant/orders` for the immutable order ledger, and `/restaurant/sop/reports` for SOP outcomes.

## Troubleshooting

### Unavailable price

Open `/restaurant/menus` and use **Effective preview** with the same branch, channel, and time as the
order. Confirm the publication is published, the price-list version is published and effective,
and the item has a price or valid override. Also check dayparts, exceptions, and branch availability.
Refresh the POS catalog after correcting publication. Do not type a price into an order.

### Locked terminal or operator

Use **Unlock** with a valid branch-eligible operator. If five PIN attempts failed, stop trying and
ask an authorized administrator to unlock/reset that operator in `/restaurant/staff`. If the device
was revoked, enroll a newly authorized device; do not reuse its old secret or queued work.

### Missing branch

Confirm the user is assigned to the branch and has the route's capability. Check whether the branch
appears by name in `/restaurant/menus` or `/restaurant/sop/admin`. If it is absent there, branch
provisioning is external: contact the platform administrator. Do not borrow another branch's ID.

### Module unavailable

A disabled-module card or missing navigation item means the organization lacks that module or the
user lacks access. A restaurant administrator can correct staff/branch permissions; only a platform
administrator can enable the organization module. Re-authenticate after the authorized change.

### Offline or stale data

Keep the POS open on its enrolled device, watch the queue status, and reconnect. Resolve catalog or
409 conflicts from the review state. KDS, admin consoles, reports, loyalty, refunds, and SOP work
require connectivity; refresh after the connection returns. Never clear browser storage while
unsent POS drafts remain.

## Route reference

| Task                              | Route                       |
| --------------------------------- | --------------------------- |
| Staff and PINs                    | `/restaurant/staff`         |
| Shift roster                      | `/restaurant/staff/roster`  |
| Devices                           | `/restaurant/devices`       |
| Catalog and recipes               | `/restaurant/catalog`       |
| OCR menu import                   | `/restaurant/menu-import`   |
| Menus, prices, publications       | `/restaurant/menus`         |
| Floor, tables, sections, stations | `/restaurant/floor`         |
| Inventory ledger                  | `/restaurant/inventory`     |
| Purchasing ledger                 | `/restaurant/purchasing`    |
| Terminal setup                    | `/terminal`                 |
| Point of sale                     | `/pos`                      |
| Kitchen display                   | `/kds`                      |
| Orders                            | `/restaurant/orders`        |
| Money and close ledgers           | `/restaurant/money`         |
| Customers and loyalty             | `/restaurant/loyalty`       |
| SOP execution                     | `/restaurant/sop`           |
| SOP administration                | `/restaurant/sop/admin`     |
| SOP oversight                     | `/restaurant/sop/oversight` |
| SOP reports                       | `/restaurant/sop/reports`   |
| Insights                          | `/restaurant/insights`      |
