# Restaurant administrator guide

This is the canonical operator guide for the current DevFathom restaurant workspace. Product PRDs
explain design and evidence; this guide explains what administrators and service teams can safely do.
Delivery source claims are pinned to `e3a5de4c3d358149319f185bbf9d60c177023005`; exact-candidate
browser and release evidence remains pending.

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
  bytes only. DevFathom does not connect to physical printers, drawers, or operating-system print
  services.
- **DIRECT DELIVERY:** Configure active branch zones and publish a menu to Delivery. POS delivery
  requires a customer and saved address and stays connected-only. KDS provides the kitchen-ready
  PREPAID/COD handoff; marketplace providers and full rider logistics remain outside this release.
- **NOT OPERATOR READY** means a live screen requires a typed internal identifier instead of an
  operator-safe choice. Stop and use another supported flow pending product correction. Never look
  up an identifier in a database.

## Roles and capabilities

Use the least-privileged standard role. Owner/Administrator has all capabilities; General Manager
and Branch Manager cover broad operations. Cashier/Server operate the register, Kitchen operates
KDS, Inventory Controller handles stock, Finance handles financial reports/refunds, and Compliance
Manager handles SOP administration/verification. Explicit user denies override role grants, and
branch access limits results. A title alone does not authorize an action; sensitive actions can
require a distinct manager credential.

## Initial setup

### 1. Onboard the restaurant and modules

- **Navigate:** Platform → Organizations → New (`/platform/organizations/new`); choose `RESTAURANT`,
  then assign a compatible package/modules from the organization.
- **Required:** Platform operator authorization.
- **Expected result:** A restaurant workspace, default branch, and licensed restaurant surfaces.
  Menu work requires `restaurant-menu`; SOP requires `restaurant-sop`; other surfaces require their
  applicable restaurant entitlement.
- **Common failure/recovery:** If restaurant type or module is absent, ask the platform operator to
  correct onboarding/entitlements. Do not substitute an agency workspace. Active vertical
  conversion is not an ordinary operator workflow.

### 2. Review branches

- **Navigate:** Workspace Settings (`/settings`) for context; branch choices appear in Menus,
  Devices, Tax, Inventory, Purchasing, SOP, and Reports.
- **Required:** Owner/Administrator or the domain’s manager capability, plus branch access.
- **Expected result:** Work attaches to the intended active branch, timezone, and business date.
- **Common failure/recovery:** A complete standalone branch-administration workflow is not evidenced.
  Creating, renaming, re-zoning, or reactivating a branch is **NOT OPERATOR READY** pending product
  correction. Never type or look up a branch ID; escalate to the product owner/platform operator.

### 3. Set up staff, roles, PINs, devices, and roster

- **Navigate:** Restaurant → Staff (`/restaurant/staff`) for profiles, roles, credentials, status,
  and branch assignment; Staff roster (`/restaurant/staff/roster`) for shifts; Devices
  (`/restaurant/devices`) → Enroll for POS/KDS. Open `/pos` or `/kds` on the intended device.
- **Required:** Staff/role/credential management capabilities; `devices:manage` for enrollment and
  revocation. Revocation requires a distinct active approver and their PIN/badge.
- **Expected result:** Active, branch-scoped staff have least-privileged roles and individual
  credentials; each device is branch-bound. Save the one-time enrollment secret when shown.
- **Common failure/recovery:** If staff are missing at POS/KDS, verify active profile, credential,
  and device branch. Reset the individual credential; never disclose another PIN. If a device
  secret is lost, revoke and re-enroll. Revoke lost/compromised devices immediately. No specialized
  hardware or peripheral compatibility is promised. Creating a profile by typing a **Linked user
  ID** is **NOT OPERATOR READY** pending product correction; stop and do not query the database.

### 4. Build catalog, menu, pricing, modifiers, and recipes/BOM

- **Navigate:** Restaurant → Catalog (`/restaurant/catalog`) for categories, products, variants,
  modifier groups/options, allergens, units, ingredients, and recipe versions; Restaurant → Menus
  (`/restaurant/menus`) for sections, items, price versions, branch/channel publications, windows,
  exceptions, and overrides.
- **Required:** `menu:read`; `menu:write` to author; `menu:price` to price; `menu:publish` to publish.
- **Expected result:** Canonical products/modifiers and active recipe/BOM versions feed a reviewed,
  effective menu and price list published to the intended branch.
- **Common failure/recovery:** Keep changes draft until reviewed. If POS misses a change, verify
  product status, active price version, branch publication, channel/daypart, exception, and device
  branch. Retire/supersede through the UI; do not rewrite historical versions. A POS flow asking for
  typed **Modifier option IDs**, or Floor routing asking for a **Product or category ID**, is **NOT
  OPERATOR READY** pending product correction; stop and do not query the database.

### 5. Import with OCR, review/correct, then publish manually

- **Navigate:** Menu import (`/restaurant/menu-import`) → upload → wait for extraction → review every
  line → Accept, Reject, or Merge → Commit; then Menus (`/restaurant/menus`) to price, review, and
  publish manually.
- **Required:** `menu:import`; then `menu:price` and `menu:publish`.
- **Expected result:** OCR produces candidates only. Commit creates/merges products plus a **DRAFT**
  menu and **DRAFT** price version. It never publishes automatically.
- **Common failure/recovery:** Correct uncertain text/prices against the source; reject unsupported
  values and merge true duplicates. Commit remains blocked while a row is undecided or a price has
  no source evidence. Retry/discard in the console or create manually in Catalog. OCR output is not
  authoritative.

### 6. Activate Pakistan tax

- **Navigate:** Restaurant → Tax (`/restaurant/tax`) → branch → available Pakistan profile →
  effective date → approval reference → eligibility confirmations → accountant confirmation →
  Activate.
- **Required:** Authorized restaurant tax administrator; the surface enforces tenant, entitlement,
  and authorization rules.
- **Expected result:** An effective-dated profile is published for one branch with source and
  approval evidence.
- **Common failure/recovery:** Unavailable profiles fail closed. Never guess rate, eligibility,
  payment treatment, or date. Obtain current advice from a qualified Pakistani accountant and,
  where needed, legal counsel; DevFathom is not tax/legal advice. Filing, fiscal-device
  certification, authority e-invoicing, and automatic legal updates are not built.

## Opening and daily service

### 7. Open the terminal, drawer, and KDS

- **Navigate:** `/pos` → device secret → Load operators → operator → individual PIN → unlock →
  Drawer → opening float. On the kitchen device, `/kds` → device secret → Load operators → kitchen
  operator → Connect.
- **Required:** Registered branch device; active staff; `pos:operate` and relevant cash capability
  for POS, or `kitchen:operate` for KDS.
- **Expected result:** An attributable terminal session/open drawer and a station-bound KDS polling
  the server-resolved business date. KDS offers Start, Mark ready, and Recall when valid.
- **Common failure/recovery:** On 401/403, verify entitlement, device status/kind/branch/station,
  operator status, credential, and lockout. Re-enroll only if the secret is lost. KDS gap/overflow
  triggers full reconciliation. There is no KDS push channel, bump-bar integration, or physical
  kitchen-print delivery. Offline/disconnect behavior is under active correction and is not an
  accepted operator promise yet.

### 8. Run dine-in and takeaway

- **Navigate:** `/pos` → New order → Dine in or Takeaway → add menu items/modifiers →
  hold/fire → serve → close for payment. Managers review Orders (`/restaurant/orders`) and Floor
  (`/restaurant/floor`).
- **Required:** `orders:take`/`pos:operate`; `orders:read` to review; protected changes require the
  applicable manager capability.
- **Expected result:** A branch-scoped order uses the effective menu, routes fired items to KDS, and
  progresses through preparation/service.
- **Common failure/recovery:** Refresh menu/open orders after publication or stale session. Use only
  offered safeguarded cancel/void actions. POS dine-in fields requiring typed **Table IDs** or
  **Section ID**, table moves requiring **From/To table IDs**, and table merges requiring
  **Additional table IDs** are **NOT OPERATOR READY** pending product correction. Never query a
  database; use takeaway or another supported floor flow until selectors exist. Delivery requires
  a Delivery publication, customer, saved address, active zone, and a live connection. Missing or
  unauthorized inputs are rejected before order, idempotency, or audit mutation.

### 9. Split, tender, void, refund, and receipt

- **Navigate:** `/pos` → order → close/collect → no split, item, seat, or fractional split → Cash,
  Card, or Other tender. Use offered void/refund actions; managers inspect Money
  (`/restaurant/money`).
- **Required:** `payments:collect`; `orders:void` or `payments:refund`. Protected post-preparation
  voids, comps, refunds, and corrections require a distinct authorized manager and reason.
- **Expected result:** Exact bill allocations, tender entries, change/remaining due, and a
  display-only receipt with attributable history.
- **Common failure/recovery:** Correct insufficient/over-tender or refund-cap errors and retry once.
  Card is only a mock/operator-confirmed record. Money workflows requiring typed **Terminal ID** are
  **NOT OPERATOR READY** pending product correction; never look it up. Print routing is simulation-
  only and does not prove physical receipt delivery.

### 10. Customers and loyalty

- **Navigate:** Loyalty (`/restaurant/loyalty`) to administer programs/accounts; `/pos` checkout to
  search/attach a customer and view/redeem eligible points.
- **Required:** Customer read/management and loyalty administration capabilities; redemption
  authority as enforced at checkout.
- **Expected result:** A tenant-scoped customer attaches without unnecessary PII; earn, redemption,
  reversal, and liability entries remain append-only/replay-safe.
- **Common failure/recovery:** Respect displayed balance/unpaid-bill caps. Confirm program/account
  state and consent rather than duplicating a customer. Accounting export with expiration/breakage
  policy is not built. A loyalty interaction asking for a typed **Order ID** is **NOT OPERATOR
  READY** pending product correction; stop and do not query the database.

### 11. Inventory, counts, wastage, and purchasing

- **Navigate:** Catalog (`/restaurant/catalog`) for ingredients/units/BOM; Inventory
  (`/restaurant/inventory`) for on-hand, movements, counts, transfers, low stock, adjustments, and
  wastage; Purchasing (`/restaurant/purchasing`) → draft PO → submit → approve → select → receipt.
- **Required:** `inventory:read`, `inventory:count`, `inventory:adjust`, or `inventory:waste` for the
  corresponding stock action; purchasing create/approve/receive capability for its stage.
- **Expected result:** Posted counts, waste, adjustments, purchases, and receipts create auditable
  stock movements; active recipes provide the BOM consumption basis.
- **Common failure/recovery:** Reconcile unit, location, item, snapshot quantity, supplier, and
  selected order before posting. Record wastage as wastage—never edit a balance/history. After an
  uncertain response, reload the order before retrying a receipt.

### 12. Execute SOPs and evidence

- **Navigate:** SOP (`/restaurant/sop`) → assigned occurrence → start → complete steps → attach
  requested evidence → submit.
- **Required:** `sop:complete`, active branch/staff assignment, and `restaurant-sop`.
- **Expected result:** Time-windowed work is recorded on-time/late with append-only evidence/events.
- **Common failure/recovery:** If absent, confirm published template, schedule, branch timezone,
  assignment, and generation window. Correct rejected work and resubmit; never delete evidence.
  Offline execution, malware scanning, and external object-retention policy are not built.

## Back office, oversight, reports, and close

### 13. SOP administration and oversight

- **Navigate:** `/restaurant/sop/admin` to author/publish/schedule; `/restaurant/sop/oversight` for
  verification, rejection, waiver, escalation, scores, and audit; `/restaurant/sop/reports` for
  reconciled outcomes.
- **Required:** `sop:manage`; `sop:verify`; `reports:operational`. Waiver requires distinct
  co-authorization.
- **Expected result:** Published versions freeze, schedules pin a version, evidence is independently
  reviewed, and reports show window, denominator, and exclusions.
- **Common failure/recovery:** Publish before scheduling. Archive an eligible template when quota is
  exhausted; ask the platform operator to fix an unconfigured quota. When no work was scored, the
  result is “No data,” not 0%. Oversight actions asking for a typed **Occurrence ID** are **NOT OPERATOR READY** pending
  product correction; stop and do not query the database.

### 14. Operational, financial, and multi-branch reporting

- **Navigate:** Insights (`/restaurant/insights`); SOP reports (`/restaurant/sop/reports`) with
  branch/date/department filters; Money (`/restaurant/money`) for financial oversight.
- **Required:** `reports:operational` or `reports:financial`, plus branch access.
- **Expected result:** Authorized users inspect one required branch and one period at a time without
  mixing tenants; report filters/freshness remain visible. Consolidated branch comparison is not
  verified or built.
- **Common failure/recovery:** Check branch/date/business-date cutoff, module, and permission.
  Reconcile against orders, tenders, drawer/stock movements, and SOP evidence. Empty/no-data is not
  zero activity. Any report action requiring a typed internal ID is **NOT OPERATOR READY** pending
  product correction.

### 15. Drawer and daily close

- **Navigate:** `/pos` → Drawer → record paid-in, paid-out, or drop as they occur → preview close →
  counted cash → close drawer/day. Use manager-corrected close only through the offered action.
- **Required:** Cash-management capability; correction requires manager approval and reason.
- **Expected result:** Expected/declared cash, variance, operator/register accountability, and branch
  daily close are retained.
- **Common failure/recovery:** Review open orders and cash movements first. Record actual count and
  explain variance; never falsify it. Later refunds post in the current open business date and
  reference the original; they do not silently reopen history.

## Recovery checklist

1. Preserve the error and do not repeat a financial mutation blindly.
2. Confirm workspace, branch, business date, module, capability, device, and operator.
3. Refresh list/detail and determine whether the first attempt succeeded.
4. Use only explicit retry, correction, reversal, revoke/re-enroll, or resubmit actions.
5. If an internal ID is requested, stop: **NOT OPERATOR READY**, pending product correction. Never
   use a database lookup as operator procedure.
6. Escalate tax/legal decisions to qualified advisers and entitlement problems to the platform
   operator. Preserve audit evidence and reasons.

Camera enrollment that asks for a typed **Gateway ID** is also **NOT OPERATOR READY** pending product
correction. Stop and do not query the database; no operator-safe enrollment workaround is documented.

## Product references

- [Restaurant management system plan](../../industry-specific-docs/restaurants/restaurant-management-system-plan.md)
- [POS and terminal module PRD](modules/pos-terminal.md)
- [KDS module PRD](modules/kds.md)
- [Menu import/OCR PRD](menu-import-ocr.md)
- [Tax PRD](tax.md)
- [SOP PRD](sop.md)
- [Customers and loyalty PRD](customers-loyalty.md)
