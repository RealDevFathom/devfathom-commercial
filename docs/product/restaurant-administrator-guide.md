# Restaurant administrator guide

This is the canonical operator guide for the current DevFathom restaurant workspace. Product PRDs
explain design and evidence; this guide explains what administrators and service teams can safely do.
The guide reflects accepted local behavior. It does not claim deployment, release, external-service,
hardware, or browser evidence.

## Read this first

- Restaurant workspaces use organization type `RESTAURANT`. Platform onboarding and commercial
  module assignment happen in the platform console; restaurant staff cannot grant entitlements.
- A page can be denied when its module is disabled or the user lacks the named capability. Ask the
  owner to correct the role or the platform operator to correct the module. Never share accounts.
- A shared POS/KDS is a registered device, not a shared web user. PINs/badges are individual
  terminal credentials, never web passwords.
- **MOCK CARD LIMIT:** Card tender is an operator-confirmed mock/local record. OPay New 9220 is a
  candidate device only; DevFathom does not prove processor authorization, capture, settlement,
  tokenization, or refund until a provider-specific integration is accepted.
- **PRINT BRIDGE LIMIT:** Receipt/kitchen print routing persists durable simulation jobs and ESC/POS
  bytes, queues offline simulation jobs for retry, and deduplicates a repeated print intent. It does
  not connect to physical or network printers, drawers, or operating-system print services.
- **DIRECT DELIVERY:** Configure active branch zones and publish a menu to Delivery. POS delivery
  requires a customer and saved address and stays connected-only. KDS provides the kitchen-ready
  PREPAID/COD handoff; marketplace providers and full rider logistics remain outside this release.
- **NOT OPERATOR READY** means a live screen requires a typed internal identifier instead of an
  operator-safe choice. Stop and use another supported flow pending product correction. Never look
  up an identifier in a database.
- Branch, operator, order, occurrence, device, table, and gateway choices use readable names,
  codes, dates, or statuses. A provider-issued reference can remain unavoidable during initial
  external integration setup; the label must identify it as external, never as a DevFathom record ID.

## Roles and capabilities

Use the least-privileged standard role. Owner/Administrator has all capabilities; General Manager
and Branch Manager cover broad operations. Cashier/Server operate the register, Kitchen operates
KDS, Inventory Controller handles stock, Finance handles financial reports/refunds, and Compliance
Manager handles SOP administration/verification. Explicit user denies override role grants, and
branch access limits results. A title alone does not authorize an action; sensitive actions can
require a distinct manager credential.

## Initial setup

### 1. Onboard the restaurant and modules

- **Navigate:** A SuperAdmin/platform operator opens Platform → Organizations → New
  (`/platform/organizations/new`), chooses `RESTAURANT`, then assigns a compatible package/modules
  from the organization.
- **Required:** SuperAdmin/platform operator authorization. Restaurant administrators cannot create
  the tenant or grant their own commercial modules.
- **Expected result:** A restaurant workspace, default branch, and licensed restaurant surfaces.
  Menu work requires `restaurant-menu`; SOP requires `restaurant-sop`; other surfaces require their
  applicable restaurant entitlement.
- **Common failure/recovery:** If restaurant type or module is absent, ask the platform operator to
  correct onboarding/entitlements. Do not substitute an agency workspace. Active vertical
  conversion is not an ordinary operator workflow.
- **Browser validation:** Validation pending.

### 2. Review branches

- **Navigate:** Restaurant → Settings → Branches (`/restaurant/settings/branches`). Use Create branch
  for a new location; use Edit, Make primary, Activate, or Deactivate on the named location for
  later changes.
- **Required:** `restaurant:configure`; the active-branch commercial limit still applies.
- **Expected result:** Operators choose locations by readable name/code. The first branch becomes
  primary; the current active primary cannot be deactivated until another branch is made primary.
- **Common failure/recovery:** If saving fails, correct the displayed fields or plan limit and retry.
  Preserve historical locations by deactivating them; do not use internal identifiers.
- **Browser validation:** Validation pending.

### 3. Set up staff, roles, PINs, devices, and roster

- **Navigate:** Restaurant → Staff (`/restaurant/staff`) for profiles, roles, credentials, status,
  organization-user selection, and branch assignment; Staff roster (`/restaurant/staff/roster`) for
  shifts. On the browser that will become the terminal, open Restaurant → Devices
  (`/restaurant/devices`) → Enroll device.
- **Required:** Staff/role/credential management capabilities; `devices:manage` for enrollment and
  revocation. Revocation requires a distinct active approver and their PIN/badge.
- **Expected result:** Active, branch-scoped staff have least-privileged roles and individual
  credentials. The administrator chooses the device name, branch, POS/KDS kind, and KDS station
  when applicable; Enroll this browser ends the administrator session and opens the dedicated
  terminal. The browser establishes its device session automatically.
- **Common failure/recovery:** If staff are missing at POS/KDS, verify active profile, credential,
  and device branch. Reset the individual credential; never disclose another PIN. If a device
  secret is lost, revoke and re-enroll. Revoke lost/compromised devices immediately. No specialized
  hardware or peripheral compatibility is promised. Link a staff profile with the Organization
  user selector; inactive or already-linked users remain unavailable. Never enter internal IDs.
- **Browser validation:** Validation pending.

### 4. Build catalog, menu, pricing, modifiers, and recipes/BOM

- **Navigate:** Restaurant → Catalog (`/restaurant/catalog`) for categories, products, variants,
  modifier groups/options, allergens, units, ingredients, and recipe versions; Restaurant → Menus
  (`/restaurant/menus`) for sections, items, price versions, branch/channel publications, windows,
  exceptions, and overrides.
- **Required:** `menu:read`; `menu:write` to author; `menu:price` to price; `menu:publish` to publish.
- **Expected result:** Canonical products/modifiers and active recipe/BOM versions feed a reviewed,
  effective menu and price list published to the intended branch.
- **Common failure/recovery:** Keep changes draft until reviewed. POS presents each item's available
  modifier options by name; choose them while composing the line. If POS misses a change, verify
  product status, active price version, branch publication, channel/daypart, exception, and device
  branch. Modifier groups with the same configured sort order remain deterministic by creation
  order. Retire/supersede through the UI; do not rewrite historical versions or enter internal IDs.
- **Browser validation:** Validation pending.

### 5. Import with OCR, review/correct, then publish manually

- **Navigate:** Menu import (`/restaurant/menu-import`) → upload → wait for extraction → review every
  line → Accept, Reject, or Merge → Commit; then Menus (`/restaurant/menus`) to price, review, and
  publish manually.
- **Required:** `menu:import`; then `menu:price` and `menu:publish`.
- **Expected result:** OCR produces candidates only. Commit creates/merges products plus a **DRAFT**
  menu and **DRAFT** price version. It never publishes automatically.
- **Common failure/recovery:** Correct uncertain text/prices against the source; reject unsupported
  values and merge true duplicates. Commit remains blocked while a row is undecided or a price has
  no source evidence. A retry with the same idempotency key resumes one import and safely completes
  source cleanup; it does not create a duplicate import. A finished copy of the same file is blocked
  unless an explicit new idempotency key starts a deliberate new import. Retry/discard in the
  console or create manually in Catalog. OCR output is not authoritative.
- **Browser validation:** Validation pending.

### 6. Configure Pakistan tax

- **Navigate:** Restaurant → Tax (`/restaurant/tax`). Either activate an available Pakistan preset,
  or create a Custom tax profile: choose branch and jurisdiction, set inclusive or exclusive
  pricing, effective start/end dates, enter accountant-supplied Cash/Card/Other rates and approval
  reference, inspect the live calculation preview, confirm accountant review, then publish.
- **Required:** Authorized restaurant tax administrator; the surface enforces tenant, entitlement,
  and authorization rules.
- **Expected result:** An effective-dated profile is published for one branch with approval evidence.
  If Atomically close and replace is selected, the current open profile closes at the new start
  time. Settlement and later refund/reversal calculations retain the historical tax snapshots.
- **Common failure/recovery:** Unavailable profiles fail closed. Never guess rate, eligibility,
  payment treatment, or date. Obtain current advice from a qualified Pakistani accountant and,
  where needed, legal counsel; DevFathom is not tax/legal advice. Filing, fiscal-device
  certification, authority e-invoicing, and automatic legal updates are not built.
- **Browser validation:** Validation pending. Legal applicability remains adviser-confirmed.

## Opening and daily service

### 7. Open the terminal, drawer, and KDS

- **Navigate:** After an administrator enrolls this browser in Restaurant → Devices, it opens `/pos`
  or `/kds` and establishes the terminal automatically. Choose the named operator and enter their
  individual PIN to unlock/connect. At POS, open Drawer and record the opening float. Use Lock when
  leaving the register and Switch operator for a handoff; the incoming operator selects their name
  and enters their own PIN.
- **Required:** Registered branch device; active staff; `pos:operate` and relevant cash capability
  for POS, or `kitchen:operate` for KDS.
- **Expected result:** An attributable terminal session/open drawer and a station-bound KDS polling
  the server-resolved business date. KDS offers Start, Mark ready, and Recall when valid.
- **Common failure/recovery:** On 401/403, verify entitlement, browser enrollment, device
  status/kind/branch/station, operator status, credential, and lockout. Re-enroll the browser only
  after revocation or expired enrollment. KDS remains connected-only: a network failure keeps the
  last confirmed station state visible with a recovery alert, while polling backs off and Retry now
  is available. A cursor gap triggers a full reconciliation; an overflow warning means the bounded
  oldest-first view is authoritative, not that later tickets disappeared. There is no KDS offline
  queue, push channel, cross-station expediter view, bump-bar integration, or physical kitchen-print
  delivery.
- **Browser validation:** Validation pending.

### 8. Run dine-in and takeaway

- **Navigate:** `/pos` → New order → Dine in or Takeaway → add menu items/modifiers →
  hold/fire → serve → close for payment. Managers review Orders (`/restaurant/orders`) and Floor
  (`/restaurant/floor`).
- **Required:** `orders:take`/`pos:operate`; `orders:read` to review; protected changes require the
  applicable manager capability.
- **Expected result:** A branch-scoped order uses the effective menu, routes fired items to KDS, and
  progresses through preparation/service.
- **Common failure/recovery:** Refresh menu/open orders after publication or stale session. For
  dine-in, select available tables grouped under the named floor and optionally select a named floor
  section. On the open ticket, Move table uses Current table and Destination table selectors; Merge
  tables uses available named tables. Use only offered safeguarded cancel/void actions and never
  enter internal identifiers. Delivery requires a Delivery publication, customer, saved address,
  active zone, and a live connection. Missing or unauthorized inputs are rejected before order,
  idempotency, or audit mutation.
- **Browser validation:** Validation pending.

### 9. Dispatch and complete direct delivery

- **Navigate:** At POS create the connected Delivery order, attach the customer and saved address,
  send it to the kitchen, and settle it as PREPAID or leave it for COD. On the enrolled KDS open the
  Delivery handoff board; after kitchen work is ready, choose Dispatch order, confirm the handoff,
  then choose Mark delivered and confirm completion.
- **Required:** Active POS/KDS sessions for the same branch and the applicable order, kitchen, and
  payment capabilities.
- **Expected result:** Only dispatchable deliveries advance from pending to dispatched and then
  delivered. PREPAID requires completed payment before dispatch; COD retains collection due for the
  handoff.
- **Common failure/recovery:** Delivery stays connected-only. Resolve the displayed readiness,
  payment, permission, or connection failure and reload before retrying a transition.
- **Browser validation:** Validation pending.

### 9A. Work through a connection loss at POS

- **Navigate:** Keep the enrolled POS open. When it shows Offline, use the cached catalog only to
  compose and queue a **new** order. Reconnect, unlock with the named operator's own PIN when asked,
  then review the queue and retry or discard only through the offered controls.
- **Required:** A previously enrolled device and cached catalog. Offline drafts remain device-bound.
- **Expected result:** Reconnect replays queued open-order and add-item commands idempotently. A
  catalog change can hold a draft for review. Reauthentication pauses rather than drops the queue.
- **Common failure/recovery:** Checkout, tenders, refunds, receipts, drawers, close, customers,
  loyalty, delivery, and edits to existing orders stay connected-only. Device revocation discards
  its drafts. If the saved store cannot be recovered, clear site data or re-enroll this browser;
  never recreate queued work by guessing whether replay succeeded.
- **Browser validation:** Validation pending.

### 10. Split, tender, void, refund, and receipt

- **Navigate:** `/pos` → order → close/collect → no split, item, seat, or fractional split → Cash,
  Card, or Other tender. Use offered void/refund actions; managers inspect Money
  (`/restaurant/money`).
- **Required:** `payments:collect`; `orders:void` or `payments:refund`. Protected post-preparation
  voids, comps, refunds, and corrections require a distinct authorized manager and reason.
- **Expected result:** Exact bill allocations, tender entries, change/remaining due, and a
  display-only receipt with attributable history.
- **Common failure/recovery:** Correct insufficient/over-tender or refund-cap errors and retry once.
  Card is only a mock/operator-confirmed record. Existing provider-terminal configurations are
  chosen by readable configuration. Creating the first provider configuration still requires the
  provider source and its external terminal identifier; this is provider-issued configuration, not
  an internal database ID. Print routing is simulation-only and does not prove physical receipt
  delivery. Finance fails closed before protected ledger queries for users without finance access.
- **Browser validation:** Validation pending.

### 11. Customers and loyalty

- **Navigate:** Loyalty (`/restaurant/loyalty`) to administer programs/accounts; `/pos` checkout to
  search/attach a customer and view/redeem eligible points.
- **Required:** Customer read/management and loyalty administration capabilities; redemption
  authority as enforced at checkout.
- **Expected result:** A tenant-scoped customer attaches without unnecessary PII; earn, redemption,
  reversal, and liability entries remain append-only/replay-safe.
- **Common failure/recovery:** Respect displayed balance/unpaid-bill caps. Confirm program/account
  state and consent rather than duplicating a customer. Accounting export with expiration/breakage
  policy is not built. Optional order linkage uses a readable Order selector limited to the chosen
  branch; no typed internal Order ID is an operator step.
- **Browser validation:** Validation pending.

### 12. Inventory, counts, wastage, and purchasing

- **Navigate:** Catalog (`/restaurant/catalog`) for ingredients/units/BOM; Inventory
  (`/restaurant/inventory`) for on-hand, movements, counts, transfers, low stock, adjustments, and
  wastage; Purchasing (`/restaurant/purchasing`) → draft PO → submit → approve → select → receipt.
- **Required:** `inventory:read`, `inventory:count`, `inventory:adjust`, or `inventory:waste` for the
  corresponding stock action; purchasing create/approve/receive capability for its stage.
- **Expected result:** Posted counts, waste, adjustments, purchases, and receipts create auditable
  stock movements; active recipes provide the BOM consumption basis. Low-stock views compare
  on-hand quantities with configured thresholds so replenishment can start without rewriting stock.
- **Common failure/recovery:** Reconcile unit, location, item, snapshot quantity, supplier, and
  selected order before posting. Record wastage as wastage—never edit a balance/history. After an
  uncertain response, reload the order before retrying a receipt.
- **Browser validation:** Validation pending.

### 13. Execute SOPs and evidence

- **Navigate:** SOP (`/restaurant/sop`) → assigned occurrence → start → complete steps → attach
  requested evidence → submit.
- **Required:** `sop:complete`, active branch/staff assignment, and `restaurant-sop`.
- **Expected result:** Time-windowed work is recorded on-time/late with append-only evidence/events.
- **Common failure/recovery:** If absent, confirm published template, schedule, branch timezone,
  assignment, and generation window. Correct rejected work and resubmit; never delete evidence.
  Offline execution, malware scanning, and external object-retention policy are not built.
- **Browser validation:** Validation pending.

### 13A. Schedule staff and control access

- **Navigate:** Staff roster (`/restaurant/staff/roster`) to create branch shifts and review the
  schedule; Staff (`/restaurant/staff`) to maintain profiles, branch assignments, roles, status, and
  operator credentials.
- **Required:** Workforce scheduling or staff-management capability for the action.
- **Expected result:** Named active staff appear only in authorized branches and roles; roster work
  remains separate from web-account access, payroll, and tip payout.
- **Common failure/recovery:** If a staff member is absent from a selector, check active status,
  branch assignment, role, credential, and any linked organization user. Do not create a duplicate
  profile or share a PIN to bypass access.
- **Browser validation:** Validation pending.

## Back office, oversight, reports, and close

### 14. SOP administration and oversight

- **Navigate:** `/restaurant/sop/admin` to author/publish/schedule; `/restaurant/sop/oversight` for
  verification, rejection, waiver, escalation, scores, and audit; `/restaurant/sop/reports` for
  reconciled outcomes.
- **Required:** `sop:manage`; `sop:verify`; `reports:operational`. Waiver requires distinct
  co-authorization.
- **Expected result:** Published versions freeze, schedules pin a version, evidence is independently
  reviewed, and reports show window, denominator, and exclusions.
- **Common failure/recovery:** Publish before scheduling. Archive an eligible template when quota is
  exhausted; ask the platform operator to fix an unconfigured quota. When no work was scored, the
  result is “No data,” not 0%. Occurrence audit history uses a readable recent-occurrence selector
  showing template, branch, date, and status; no typed internal Occurrence ID is an operator step.
- **Browser validation:** Validation pending.

### 15. Customize the dashboard and run multi-branch analytics/reports

- **Navigate:** Dashboard (`/dashboard`) → Management overview. Choose an active branch and the last
  7 or 30 closed dates. Select Edit dashboard to show/hide, reorder, or resize widgets and change the
  saved default branch/date range; Save dashboard persists the layout and Restore default resets it.
  Open Restaurant → Reports (`/restaurant/reports`) for branch/from/to filters, multi-branch
  analytics, and CSV exports.
- **Required:** `restaurant-insights` for reconciled dashboard rollups; `reports:operational` or
  `reports:financial` for Reports, plus source-module and branch authorization. Workforce rate data
  also requires `workforce:rates`.
- **Expected result:** Reports separates financial, operational, inventory, purchasing, workforce,
  and SOP sections and shows freshness/partial status. Authorized users may choose one named branch
  or All active branches; the latter aggregates only branches they may read. CSV uses the same
  filters and authorization.
- **Common failure/recovery:** Treat Permission required, Source module not enabled, Section could
  not load, and No matching data as distinct states. Check branch/date/business-date cutoff, module,
  and permission; empty/no-data is not zero activity. Dashboard figures are reconciled closed-day
  rollups, not current-shift data.
- **Browser validation:** Validation pending.

### 16. Drawer and daily close

- **Navigate:** `/pos` → Drawer → record paid-in, paid-out, or drop as they occur → preview close →
  counted cash → close drawer/day. Use manager-corrected close only through the offered action.
- **Required:** Cash-management capability; correction requires manager approval and reason.
- **Expected result:** Expected/declared cash, variance, operator/register accountability, and branch
  daily close are retained.
- **Common failure/recovery:** Review open orders and cash movements first. Record actual count and
  explain variance; never falsify it. Later refunds post in the current open business date and
  reference the original; they do not silently reopen history.
- **Browser validation:** Validation pending.

### 17. Reconcile finance

- **Navigate:** Restaurant → Money (`/restaurant/money`). Select a readable branch, optional business
  date, then inspect Bills, Payments, Drawers, Daily close, or Card terminal.
- **Required:** Restaurant Finance access plus the source module and branch authorization. Without
  finance access, the page fails closed before protected ledger reads run.
- **Expected result:** Read-only financial history reconciles bills, tenders/refunds, drawer sessions,
  close snapshots, and provider-terminal events without rewriting source ledgers.
- **Common failure/recovery:** Choose the correct branch and business date before treating an empty
  result as no activity. Use readable staff/device/configuration values. Never retry a refund or
  correction until detail/history confirms whether the first attempt posted.
- **Browser validation:** Validation pending.

## Recovery checklist

1. Preserve the error and do not repeat a financial mutation blindly.
2. Confirm workspace, branch, business date, module, capability, device, and operator.
3. Refresh list/detail and determine whether the first attempt succeeded.
4. Use only explicit retry, correction, reversal, revoke/re-enroll, or resubmit actions.
5. If an internal ID is requested, stop: **NOT OPERATOR READY**, pending product correction. Never
   use a database lookup as operator procedure.
6. Escalate tax/legal decisions to qualified advisers and entitlement problems to the platform
   operator. Preserve audit evidence and reasons.

Camera enrollment uses a named gateway selector filtered to active gateways in the chosen branch.
No typed internal Gateway ID is an operator step. Validation pending.

## Product references

- [Restaurant management system plan](../../industry-specific-docs/restaurants/restaurant-management-system-plan.md)
- [POS and terminal module PRD](modules/pos-terminal.md)
- [KDS module PRD](modules/kds.md)
- [Menu import/OCR PRD](menu-import-ocr.md)
- [Tax PRD](tax.md)
- [SOP PRD](sop.md)
- [Customers and loyalty PRD](customers-loyalty.md)
