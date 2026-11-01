# Restaurant vertical — Build Assumptions (`restaurant/v1`)

Exact candidate `fee1686e16f532cb6ffad61f4c1320fd29909e7d` passed the serialized automated
gate (1139 files / 4046 tests, zero failed or skipped). Browser completion, the Linux/amd64 image
gate, and release authorization remain pending.

**Direct Delivery v1 — connected own-delivery handoff (WHA-1048)** · Delivery requires
`orders:take` plus `customers:read`, a customer, saved address, active same-branch zone, and a
DELIVERY publication. Address, phone, zone, fee, tax, and promise facts are frozen on fulfillment;
terminal projections are masked/minimized. The non-taxable fee stays separate in bills, receipts,
daily close, Reports, and Insights. PREPAID and COD dispatch only after kitchen readiness.
Marketplace/provider dispatch, tracking, route optimization, and full rider logistics are excluded.

Conservative build-time assumptions for the restaurant vertical. An entry is
recorded only when an **OPEN** decision in the planning D-register would
otherwise block an implementation choice: apply the conservative default that
sits behind the plan's seam, record it here, and name what would revisit it.
This file is not a place to resolve open decisions — it documents the safe
default taken until the owning decision is closed.

## Entry format

```
D-id · assumption · why conservative · what revisits it
```

## Entries

Entries are grouped by the milestone that recorded them; within a milestone
they appear in the order they were decided. Text is unchanged from the
originating lane — this final pass only regroups and separates entries.

### Wallet passes — L1 foundation

**Deferred SMS OTP (wallet enrollment)** · Wallet enrollment v1 accepts EMAIL
verification only; PHONE/SMS enrollment is excluded even though the shared
customer identifier enum retains PHONE for existing customer workflows. · This
is conservative because the platform has no SMS provider and an unbounded SMS
path would introduce both spam and direct-message-cost risk. · Revisited when an
SMS provider lands for any module with approved abuse controls and cost limits.

### M1 — vertical foundation

**D09 (franchise/legal isolation)** · Restaurant branches live strictly inside
the existing organization RLS boundary; there is no cross-organization
aggregation or consolidated franchisor reporting. `RestaurantBranch` and
`RestaurantBranchAssignment` carry a bare, RLS-guarded `organizationId` exactly
like the other operational tables, and `vertical-catalog.ts` exposes no
cross-organization query. · Conservative because widening a tenant boundary to
approximate franchisor rollups is the failure mode D09 explicitly forbids;
keeping branches inside org RLS cannot leak one franchisee's data to another. ·
Revisited by D09 closing — a separately contracted, security-reviewed
cross-organization aggregation capability with its own explicit design.

**D10 (package/limit matrix)** · The catalog ships three §13 packages
(`restaurant-essentials`, `restaurant-operations`, `restaurant-enterprise`) whose
included modules and §7 limit keys use conservative default values (Essentials
`restaurant.locations.max = 1`); names, prices, and exact quantities are
provisional. Package compatibility is modeled as a single `vertical` enum column
on `PlatformPackage`, matched by exact equality in
`assertPackageCompatibleWithVertical`. · Conservative because a single-column
equality is the smallest rule that rejects a mismatched package server-side, and
tight Essentials limits under-provision rather than over-promise scale before
pricing exists. · Revisited by D10 closing — an approved package/limit matrix and
contract wording, which may add richer compatibility metadata than one column.

**D12 (branch enforcement)** · `restaurant_branches` and
`restaurant_branch_assignments` receive forced org-level RLS identical to the
existing tenant tables (same `app.current_organization_id` / `app.is_platform_admin`
clause). Branch-level authorization is expressed as explicit
`RestaurantBranchAssignment` rows enforced in server code, not a database policy;
the `branchId` columns and the assignment table are the policy-ready seams for a
later branch-scope decision. · Conservative because inventing a branch-scope DB
policy now — before the multi-branch-staff, org-wide-reporting, emergency-support,
and fail-closed cases are decided — risks a wrong, hard-to-reverse boundary; org
RLS already fails closed. · Revisited by D12 closing — an accepted ADR plus a live
non-superuser cross-branch harness deciding whether sensitive branch-owned tables
also get database-enforced branch policies.

### M2 — staff, operators & devices

**D11 (operator credential policy floor)** · The operator credential policy in
`src/lib/restaurant/operator-credentials.ts` is the conservative C4 default: a PIN
is 4–8 numeric digits, a badge secret is at least 8 characters, five consecutive
failures lock the credential for fifteen minutes, and every secret is stored as a
bcrypt hash at cost 12 (the same work factor the platform already uses for user
passwords). No WebAuthn/biometric credential kind exists. · Conservative because a
short numeric PIN is low-entropy: a slow salted hash plus a durable lockout is the
smallest bar that resists offline and online guessing, and matching the existing
bcrypt cost avoids introducing a weaker hashing primitive. Under-provisioning the
policy (short lockout window, no biometrics) fails safe — it inconveniences
operators rather than widening the attack surface. · Revisited by D11 closing — an
approved credential/lockout matrix, which may lengthen the PIN floor, tune the
lockout curve, or add stronger credential kinds.

**Audit attribution for operators (additive `AuditActorType` value)** · Actions an
operator takes at a terminal are attributed to the new, additive
`AuditActorType.RESTAURANT_OPERATOR` value rather than being folded into `USER` or
`SYSTEM`. The value is appended last, so no existing audit row is invalidated, and
the audit-log viewer (`src/app/(app)/audit-logs`) degrades gracefully for it — an
unknown actor type falls back to the default actor icon and the raw value renders
in the detail sheet, so no viewer change is required here (any styling nicety
routes to L4a). · Conservative because an operator is deliberately not a `User`
(C3); reusing an existing actor value would either misattribute the action to a web
login or hide it in `SYSTEM`, and an additive enum value is the minimal,
backward-compatible way to keep operator actions distinguishable. · Revisited by a
dedicated operator audit-attribution / viewer decision (L4a) if operator rows need
richer treatment.

**Per-instance rate-limiter caveat + durable-counter compensation (C4/C5)** · The
app's login/auth throttle (`src/lib/rate-limit.ts`) is an in-process, per-server-
instance fixed-window limiter (it says so itself: it resets on restart and does not
span instances). It therefore CANNOT be the authoritative brute-force control for
operator credentials. The authoritative control is the durable
`failedAttempts`/`lockedUntil` counters on the `RestaurantOperatorCredential` row,
re-read from the database on every verification attempt; the per-instance limiter
remains only as a cheap first-line throttle that caps bcrypt-amplifying floods from
a single caller. · Conservative because a per-instance limiter alone would let an
attacker reset their attempt budget by forcing a restart or spraying across
instances; a row-level counter fails closed across restarts and instances and is
consistent with C5's "re-check in the DB every call, no trust cache". · Revisited by
introducing a shared/distributed rate limiter (e.g. Redis/Upstash) — which would
augment, not replace, the durable per-row counters.

**Co-authorization approver identity (C6/C7 seam)** · The `RestaurantCoAuthorization`
record pins BOTH the acting operator and the approving manager as
`RestaurantStaffProfile` references (not `User`), and the primitive rejects a
self-approval (approver must differ from actor). Device and terminal-session
references are nullable so the same record serves the L3 terminal path (both
present) and the L2 back-office path (both absent). · Conservative because a
co-authorization is fundamentally between two restaurant operator identities;
modelling the approver as a staff profile keeps the terminal switch-operator flow
(C6) coherent and avoids prematurely binding approval to a web-login `User`. The two
identity foreign keys use `ON DELETE RESTRICT` so approval evidence cannot be
silently erased by deleting a profile (archival is the intended path). · Revisited by
the L2/L3 flows if a back-office approver must be attributed to a `User` rather than
a staff profile — a fix-up that funnels back through the Chief of Staff to this lane
(L1 owns the schema).

**M2-L2 base self-alignment (fast-forward, supervisor-authorized)** · The M2-L2 lane
branch started at the pre-M1 `main` state (`5c4b48c`) — a strict ancestor of the
milestone branch head `restaurant/m2-staff-operators-devices` @ `1114a1b` (post-M1 +
the full M2-L1 security-core). Per the supervisor's explicit authorization the lane
was aligned with `git merge --ff-only 1114a1b` (fast-forward only — no rebase, no
history rewrite) before any L2 code. · Conservative because a fast-forward moves the
branch pointer onto an existing, already-reviewed commit without creating a merge or
rewriting history; the ancestry was verified (`git merge-base --is-ancestor`) first,
and engineers still never merge lanes back — the supervisor does. · Revisited by the
supervisor at final merge; if the milestone head advances again the same ff-only
alignment repeats.

**M2-L2 authorization gating — `staff:manage` ABAC action (third coordinated file)**
· The `capabilityProcedure('staff:manage')`-gated router requires `staff:manage` to be
a typed ABAC `Action`. L1 declared `staff:manage` only as a role-template capability
string in `vertical-catalog.ts`; it was NOT registered in the ABAC engine. This lane
therefore adds `staff:manage` to `ALL_ACTIONS` and a POLICIES entry in
`src/lib/abac/policies.ts` — a file beyond the lane's two declared coordinated files
(`_app.ts`, `module-catalog.ts`). The addition is additive-only and its static policy
list is EMPTY: authorization flows exclusively through the DB org-role `customDecision`
path in `can()` (the Owner template's `*` or an explicit `staff:manage` grant), so a
restaurant General Manager granted `staff:manage` is authorized without being a global
platform ADMIN, and an agency admin is not implicitly granted a restaurant capability
(default-deny otherwise). · Conservative because gating on an existing coarse action
(e.g. `admin:access`) would be semantically wrong (§8: restaurant authorization is
org-role/capability driven, C1) and would lock out non-ADMIN restaurant managers; an
empty static policy grants nothing by default. · Revisited by the supervisor at merge
resolving adjacency on `abac/policies.ts` (M2-L3 will similarly append
`devices:manage`, `terminal:operate`, `coauth:approve`), and by the Phase-0 capability
matrix that may attach explicit predicates.

**M2-L2 credential lifecycle semantics (C4)** · `issueOperatorCredential` refuses a
second active credential for the same (staff, type, device) scope (rotate the existing
one instead) — aligning with the schema's partial unique index; `rotateOperatorCredential`
edits the row in place, writing the new hash and resetting the durable
`failedAttempts`/`lockedUntil` counters (a fresh secret starts with a clean slate) and
refuses to rotate a revoked credential; `revokeOperatorCredential` is idempotent and
immediate (stamps `revokedAt` with a server timestamp, C5; re-revoking is a no-op that
returns the existing row). All three credential-bearing mutations set
`annotateAudit(..., { skipInput: true })` as their FIRST statement so the plaintext
PIN/badge is never captured on the success OR failure audit path, and no response ever
includes `credentialHash`. The router is licensed under the mandatory `restaurant-core`
module. · Conservative because a security kill-switch (revoke) must never error on a
double-invocation, rotating in place avoids racing the unique index, resetting counters
on rotation prevents a stale lock outliving the secret it applied to, and skip-input on
every credential mutation is the strictest reading of C4. · Revisited by D11 closing or
an L2/L3 flow that needs credential history rows rather than in-place rotation.

**Enrollment token = the first device secret, no separate table (M2-L3/§5)** · The L1
schema stores only `RestaurantRegisteredDevice.deviceSecretHash`; there is no
enrollment-token table. So `devices.ts` enrollment mints the device secret directly and
returns it exactly once (hashed at rest, per `invite-token.ts`) — that one-time delivery
IS the "single-use enrollment token". · Conservative because it reuses the proven
single-delivery/hash-at-rest pattern and does not invent schema (L1 owns it); the raw
secret is never persisted or re-shown. · Revisited if a two-phase enrolment (short
pairing code redeemed for a device secret) is required — which would need an L1 schema
addition routed through the Chief of Staff.

**High-entropy bearer secrets hash with deterministic SHA-256, not bcrypt (M2-L3/C5)** ·
Device secrets (`rdk_…`) and terminal-session tokens (`rts_…`) are 256-bit random values
stored in UNIQUE hash columns and hashed with SHA-256, exactly like `invite-token.ts`.
Operator PINs keep bcrypt (`operator-credentials.ts`). · Conservative because a slow
salted hash only buys anything for low-entropy secrets; a fast deterministic hash is the
right primitive for a high-entropy token and is REQUIRED for the C5 per-call
revalidation (one indexed lookup every request, no trust cache). · Revisited if a device
secret ever becomes low-entropy or human-chosen.

**Default terminal transport = REST route handlers (M2-L3, explicit deviation)** · The
terminal transport is `src/app/api/restaurant/terminal/*` REST handlers wrapped by
`withTerminalAuth`/`withDeviceAuth`, authenticated by a device secret
(`Authorization: Bearer`) plus a session token (`X-Terminal-Session`) — NOT NextAuth. ·
Conservative because it mirrors the existing `src/lib/api-auth.ts` REST transport and
keeps operator credentials structurally unreachable from web login (C2); the device's
organization is resolved once in the platform scope, then every op runs tenant-scoped. ·
Revisited if a push transport (WebSocket/SSE) or tRPC terminal channel is chosen.

**Terminal session idle-expiry and device-staleness defaults (M2-L3/C5)** ·
`SESSION_IDLE_TIMEOUT_MS = 12h` (one operating shift) bounds a session token's life;
`DEVICE_STALE_AFTER_MS = 5 × 60s` marks a device STALE after five missed heartbeats.
Both are computed from SERVER time only (client time untrusted). · Conservative because
an unbounded session token would live forever if leaked, and a staleness signal aids
health without failing closed on a brief network blip. · Revisited by an operations
tuning decision (per-tenant shift length, heartbeat cadence).

**Back-office device admin gates on the mandatory `restaurant-core` module (M2-L3)** ·
`module-catalog.ts` maps the `restaurantDevices` router to `restaurant-core`, not the
optional `restaurant-integrations` ("Integrations and Devices") module. · Conservative
because device trust and terminal sessions are foundational to operating any restaurant
terminal, so every restaurant org must be able to manage its own devices; gating them
behind an optional add-on could lock a tenant out of revoking a lost device. · Revisited
if device administration should become a separately-licensed capability.

**Back-office revocation requires the approving manager's operator credential (M2-L3/C7)**
· The representative co-authorized action (`restaurantDevices.revoke`) verifies the
approving manager's PIN/BADGE against the durable lockout counters IN ADDITION to writing
the distinct-identity co-authorization record, and runs with `skipInput: true` so the
secret never enters the audit log. · Conservative because it makes co-authorization a
genuine second-person second factor rather than two identifiers typed by one admin, and
exercises C4+C7 together. · Revisited if a back-office approver must instead be attributed
to a web-login `User` (already flagged by the C6/C7 approver-identity seam above).

**Operator-attributed terminal audit — durable, staff-profile-keyed (M2-L3, supervisor
correction)** · Each of the four sensitive terminal mutations (unlock/switch/co-authorize/
lock) writes exactly one durable, attributable `RESTAURANT_OPERATOR` audit row; the passive
`heartbeat` is not audited. Attribution does NOT go through the `User`-centric `actorId`
(FK → `users`) — an operator is a `RestaurantStaffProfile`, not a `User` (C2/C3), so the row
uses the additive `AuditLog.actorStaffProfileId` column (FK → `restaurant_staff_profiles`).
The two actor columns are mutually exclusive and a DB CHECK
(`audit_logs_operator_actor_ck`) requires a `RESTAURANT_OPERATOR` row to set
`actorStaffProfileId` and leave `actorId` NULL. · Conservative because the earlier revision
attributed operators through `actorId`, which failed with a foreign-key violation (P2003)
against a real Postgres and was silently swallowed by the fire-and-forget audit core —
leaving ZERO durable rows while a mock battery passed. A dedicated staff-profile FK plus a
CHECK makes the attribution correct AND makes a future mis-route fail loudly at write time
rather than vanish. `RestaurantCoAuthorization` and device rows remain the primary evidence;
these audit rows are the attribution trail the M2 acceptance battery mandates. · Revisited by
the L4a operator audit-attribution/viewer decision if operator rows need richer treatment.

**Audit actor-column CHECK is actor-type-conditional, not a blanket "exactly one" (M2-L3
supervisor correction)** · The `audit_logs_operator_actor_ck` constraint enforces
"`RESTAURANT_OPERATOR` ⇒ `actorStaffProfileId` set and `actorId` NULL; every other actor
type ⇒ `actorStaffProfileId` NULL", rather than the literally-suggested "exactly one actor
column is set". · Conservative because `ANONYMOUS` rows (a failed login, an unauthenticated
REST call) legitimately have NEITHER actor id set — a blanket "exactly one non-null" CHECK
would reject those existing, valid rows and re-break the audit path in a new way, violating
the additive/backward-compatible requirement. The conditional form pins the operator
invariant (the actual fix) without touching the nullability contract of any pre-existing
actor type, so no backfill and no existing row is invalidated. The write path is also made
fail-loud under Vitest (`flushAuditWritesForTest`) so a swallowed audit failure can no
longer produce a phantom pass. · Revisited if a future actor type needs its own dedicated
actor column, which would extend the same conditional CHECK.

### M3 — brands, catalog & menus

**D20 (localization fields) — locale-keyed JSON, no locale-management UI (M3-L1)** ·
Customer-facing catalog/menu text (product name/description, and category/brand/menu/
section/menu-item names) carries a nullable companion `Json` column (`nameLocalized`,
`descriptionLocalized`) alongside the plain scalar; the scalar is the default-locale
value and the JSON holds a `{ locale: value }` override map. No locale-management UI, no
RTL rendering work, and no receipt content ship — fields only. · Conservative because a
locale-keyed JSON column round-trips through the API and unblocks a future second-language
input without committing to a locale registry, RTL layout, or receipt formatting before
D20 closes. · Revisited by D20 closing — a pilot locale list posted on the routing issue
would let L4b render a concrete second-language input instead of schema-only fields.

**D06 (channel dimension) — fixed additive enum (M3-L1)** · Order channel is the additive
enum `RestaurantOrderChannel (DINE_IN | TAKEAWAY | DELIVERY)`, stored as a channel-set on
a branch-menu publication and (implicitly) evaluated by the effective-menu read model. No
per-channel pricing, tax, or menu-variant machinery exists beyond the enum tag. ·
Conservative because an additive enum is the smallest seam that lets publications and
availability distinguish service channels, and enum values are appended (never
renumbered), so a later channel (e.g. `CATERING`) cannot break stored rows. · Revisited
when a channel needs its own pricing/tax behaviour rather than a tag.

**C6 (default-brand bootstrap) — lazy, idempotent, no onboarding edit (M3-L1)** · Every
restaurant organization has exactly one default `RestaurantBrand`, enforced by a partial
unique index (`WHERE "isDefault"`). The default is ensured lazily and idempotently by the
catalog server on first catalog use — NOT during onboarding (`src/lib/platform/commands.ts`
is untouched) and with NO SQL backfill of existing organizations. · Conservative because a
lazy ensure keeps the brand invariant in one server path and avoids both an onboarding
coupling and a data migration over live tenants; an org that never opens the catalog simply
has no brand yet, which is harmless. · Revisited if onboarding must present a brand step, or
if a backfill becomes necessary for a reporting surface.

**C5 (timezone evaluation) — `Intl` only, no tz dependency (M3-L1)** · Availability windows
store branch-local wall-clock minutes-of-day (`startMinutes`/`endMinutes`, a CHECK bounds
them to `[0,1439]`) plus a day-of-week set; a cross-midnight window is `endMinutes <=
startMinutes`. The effective-menu evaluator (L3) derives branch-local time from
`RestaurantBranch.timezone` using the platform `Intl` APIs only — no `date-fns-tz` or other
timezone library is added. · Conservative because integer minutes + `Intl` DST-aware
conversion is dependency-free and keeps client-supplied time untrusted; a wall-clock string
or a `time`-with-zone column would invite tz confusion. · Revisited if the evaluator
genuinely needs a tz library, in which case adding `date-fns-tz` is a recorded deviation
(this entry) rather than a silent dependency.

**Ingredient identity vs future stock item (M3-L1)** · `RestaurantIngredient` is catalog-side
identity only — name, base unit, allergens, and a nullable `referenceCost` — and carries NO
stock fields (movements, counts, batches, or stock locations). The later Inventory milestone
layers stock behaviour onto this identity by FK. · Conservative because catalog costing and
BOM composition need a stable ingredient identity now, while stock modelling is a separate
milestone; shipping identity-without-stock avoids pre-committing an inventory schema. ·
Revisited by the Inventory milestone, which adds the stock item/movement tables.

**Theoretical-cost deferral (M3-L1)** · `RestaurantIngredient.referenceCost` is a nullable
`Decimal` seam; M3 computes no cost rollups, recipe/BOM costing, or margin reporting. ·
Conservative because a reference-cost column lets recipes and price lists be authored now,
while cost computation depends on the Inventory/Purchasing money-path that has not landed. ·
Revisited by Inventory/Purchasing, which owns theoretical-cost reporting.

**Ingredient substitution deferred — no schema seam (M3-L1/A-substitution)** · The combo
structure ships as a schema + minimal-CRUD seam (`RestaurantComboComponentGroup`/`Option`),
but ingredient/menu-item SUBSTITUTION execution is deferred entirely to the POS milestone and
L1 adds NO substitution schema (the seam was not free without pre-committing a substitution
model). · Conservative because substitution semantics belong with order fulfilment, and an
unused substitution schema now would likely be reworked when POS defines them. · Revisited by
the POS milestone, which owns substitution modelling and execution.

**Price override is a capability gate, not a co-authorization (M3-L1/C7)** · A per-publication
item price override (`RestaurantBranchMenuItemOverride.priceOverride`) is gated by the
`menu:price` capability alone; it does NOT require an M2 co-authorization (distinct-approver
second-person record). · Conservative because a branch price override is a routine
menu-management action, not a till-side exception like an order void; requiring co-auth for
every override would overload the M2 approval primitive. · Revisited if an approved price
override must become a co-authorized action, in which case the existing
`RestaurantCoAuthorization` primitive applies unchanged.

**Menu / price-list / publication surface gates on the optional `restaurant-menu` module
(M3-L3)** · `module-catalog.ts` maps the `restaurantMenus` router (menu authoring, price
lists, branch-menu publications, item overrides, and the effective-menu read model) to the
optional `restaurant-menu` ("Menu and Costing") module — NOT the mandatory `restaurant-core`
that M2's staff/device routers use. · Conservative because this surface IS the licensed purpose
of the Menu-and-Costing module, and that module is present in the smallest package (Essentials),
so no ordinary tenant loses menu management; unlike device revocation (a lockout-safety concern
that justified `restaurant-core`), menu publishing is exactly the paid feature the module names.
· Revisited if the POS milestone needs the effective-menu read model reachable by a POS-only
org that has not licensed `restaurant-menu`, in which case the read model alone could move to a
`restaurant-core`/`restaurant-pos` gate while authoring stays on `restaurant-menu`.

**Menu capabilities enforced via the ABAC `customDecision` grant path, not registered in
`ALL_ACTIONS` (M3-L3/C7)** · The four menu capabilities (`menu:read`, `menu:write`,
`menu:price`, `menu:publish`) are granted to organization roles by L1's `vertical-catalog` role
templates and enforced by `capabilityProcedure(...)` through the ABAC `customDecision` DB path
exactly like `staff:manage`; the router asserts each capability string `as Action` because the
`abac/policies.ts` `ALL_ACTIONS` union (and its off-file location) is outside this lane's exact
file set. `can()` still default-denies an ungranted subject (a role without the capability, no
matching override → `null` → empty static policy → deny), and a restaurant GM with `menu:publish`
is authorized without being a global platform ADMIN. · Conservative because it delivers the exact
C7 gating behavior strictly inside the lane's file set without editing a shared auth registry that
the plan did not list as coordinated; the runtime decision is identical to a registered action.
· Revisited by the supervisor promoting the four actions into `ALL_ACTIONS` + empty `POLICIES`
entries (a one-line-per-action additive change mirroring `staff:manage`), after which the `as
Action` assertions are removed — recommended follow-up, flagged in the WHA-33 completion note.

**Money crosses the tRPC boundary as a string (M3-L3/C4)** · Every price in a router response
(price-list entry, item price override, and each effective-menu item price) is serialized with
`Prisma.Decimal.toString()`; inputs arrive as strings and are normalized through `Prisma.Decimal`
(`normalizePrice`) — catalog pricing never touches a JS `number`/float. · Conservative because
superjson does not carry a `Decimal` across the wire and a float round-trip would silently lose
cents; a string is exact and reversible. · Revisited only if a shared Decimal superjson transform
is registered platform-wide, which would let raw Decimals serialize losslessly without per-router
mapping.

**Effective-menu resolution semantics (M3-L3/C2/C5/D06)** · The read model returns, per
`(branch, channel, instant T)`: the winning price by precedence **item override → publication
price list (in force at T) → organization default (base) price list (in force at T)**, with a
variant falling back to its product's base (null-variant) entry inside a version; and an
availability boolean = channel published AND override-available AND branch-timezone daypart open.
Daypart rules (documented + tested in `menu-availability.ts`): an empty publication `channels`
set = the non-delivery operational channels (`DINE_IN` and `TAKEAWAY`); `DELIVERY` requires an
explicit published channel plus the connected customer/address/zone flow; an empty `daysOfWeek` =
every day; windows are half-open `[start, end)`; a
cross-midnight window (`end <= start`) attributes its early-morning tail to the previous day; an
exception overrides windows for its branch-local date (`isClosed` closed, else forced open);
publication-level and item-level window layers are ANDed. A menu delete is refused while a
non-RETIRED publication references the menu (its cascade would silently remove a live
publication). · Conservative because these are the least-surprising defaults for the POS §12.3
seam and each is pinned by a unit/router test rather than left implicit. · Revisited by the POS
milestone that consumes and caches this read model, which may extend channel/price precedence
(e.g. per-channel price lists) additively.

### M4 — orders, kitchen, floor & service

**C5 (business date) — cutoff default `00:00`, per-branch wall-clock (M4-L1)** · The business
date is stamped once at order creation from `RestaurantBranch.timezone` + the additive
`businessDayCutoff` wall-clock column, which defaults to `"00:00"` (midnight = the branch-local
calendar date). Resolution is `Intl`-based and DST-safe (`src/lib/restaurant/business-date.ts`);
it is never recomputed later from a UTC timestamp. · Conservative because a midnight cutoff is
the least-surprising default that still exposes the column an operator sets when their day closes
after midnight; a wrong cutoff only shifts a few late-night orders, and the value is corrected in
branch settings without a data migration. · Revisited by the branch-settings surface that lets an
operator set a non-midnight cutoff, and by any accepted cross-day-close rule (A05).

**C5 (order numbering) — unique + monotone, not gap-free (M4-L1)** · The human order number is
allocated from a per-`(branch, businessDate)` sequence row by a transactional row-locked upsert
(`src/lib/restaurant/order-numbers.ts`). Uniqueness and monotonicity are guaranteed; gap-free is
NOT — a rolled-back or cancelled order consumes a number. Order numbers are not receipt numbers;
receipt/fiscal numbering is out of scope. · Conservative because gap-free numbering would require
either serializing all order creation or a compensating renumber, both of which trade throughput
or history-integrity for a property no accepted requirement asks of an order number (as opposed to
a fiscal receipt). · Revisited by the payments/fiscalization milestone defining receipt numbering,
where jurisdiction rules may demand gap-free sequences on the receipt — a separate concern.

**C2/§12.5 (KDS transport) — bounded polling + outbox nudge, no external channel (M4-L1)** · The
kitchen ledger (events + tickets + item states) is authoritative; the KDS read model derives from
those durable rows. Realtime is only ever a nudge to read durable state: no SSE/websocket/external
channel is built or claimed. The transport is bounded polling with a sequence cursor + gap
detection; the outbox is a transactional seam (interface + `PENDING/DISPATCHED/DEAD` + attempt/
backoff fields, `src/lib/restaurant/outbox.ts`). · Conservative because a durable-read + polling
model is correct and testable without committing to a push transport before D19 selects one, and
it cannot silently drop a kitchen event the way a process-local emission can. · Revisited by D19
selecting the KDS notification transport (acknowledgement, replay, station routing), which layers
onto the same durable rows.

**§12.2 (dispatch worker) — outbox dispatch remains a seam; no scheduler exists (M4-L1)** · No
durable scheduler/worker mechanism exists yet, so nothing dispatches the outbox in M4. The outbox
append is real and transactional; the dispatcher is an interface with pure retry/backoff/dead-letter
planning and NO implementation. This is flagged §12.2 debt, not a delivery claim. · Conservative
because writing the durable rows now (and leaving dispatch unimplemented) is honest and unblocks
downstream read models, whereas an uninvoked cron route would falsely read as a working pipeline. ·
Revisited by the Phase-1 scheduler/worker milestone that provisions durable execution with
overlap protection, retry, and dead-letter recovery.

**C6 (post-prep void) — wastage disposition recorded, no stock mutation (M4-L1)** · A
post-preparation void / cancel-with-prepared-items records the wastage disposition
(`RestaurantWastageDisposition (WASTE | RESTOCK | NONE)`), a reason, and the co-authorization
reference on the order item, and emits an outbox event. NO inventory mutation exists — there is no
stock model yet. · Conservative because capturing the disposition + event now preserves the audit
trail and the exact hook the inventory milestone consumes, without inventing stock semantics before
that milestone. · Revisited by the inventory/purchasing milestone, which reads the disposition and
applies the actual stock movement.

**C4 (tax/service-charge) — zero-valued snapshot fields (M4-L1)** · Order items carry `taxAmount`
and `serviceChargeAmount` `Decimal` columns that are structurally present and default to `0`. Tax
and service-charge configuration does not exist yet, so nothing computes them. All money is
`Decimal`; no floats. · Conservative because the columns must exist for the snapshot-on-write
contract to be stable across the tax milestone, and a zero default is the only honest value before
a tax engine exists. · Revisited by the payments/tax milestone that introduces tax/service-charge
configuration and fills these snapshots at order time.

**§11.2 (merge) — multi-table link to one order; combining two open orders deferred (M4-L1)** · A
table merge is modelled as several active `RestaurantOrderTable` links (reason `MERGE`) pointing at
ONE order — the order spans multiple tables. Combining two already-open orders into one is deferred.
· Conservative because the multi-table-link shape covers the common "seat a party across two tables"
case with the existing link-history table, while merging two open orders raises payment/ownership
questions that belong with the bills/checks milestone. · Revisited by the payments/bills milestone
that defines how two open orders (and their pending items) reconcile when combined.

**§11.1 (courses) — plain integers; named-course config deferred (M4-L1)** · An order item's
`course` is a plain `Int` (default `1`); hold-and-fire works by course number. Named/configurable
course definitions (e.g. "Starter", "Main") are deferred. · Conservative because integer courses
deliver the fire-sequencing behaviour the state machine needs without a course-configuration
surface, and a later named-course map layers on without changing stored order history. · Revisited
by a course-configuration feature that maps integers to names/labels.

**§11.2 (section assignment) — per business date; shift granularity deferred (M4-L1)** · A server
section assignment is keyed by `(section, staffProfileId, businessDate)` — one assignment per
operator per section per day. Intra-day shift granularity is deferred. · Conservative because
per-day assignment matches the business-date spine already used for orders and numbering, and
covers routing/attribution without a shift-scheduling model. · Revisited by a workforce/shift
scheduling feature that needs sub-day assignment windows.

**C8 (KDS attribution) — device + optional operator (M4-L1)** · KDS/kitchen actions are attributable
to the bound registered device (`kind = KDS`, `stationId`) with OPTIONAL operator attribution; a KDS
need not have an operator signed in to act on a ticket. · Conservative because a station display is
frequently shared and unattended, so requiring an operator would block legitimate kitchen action;
the device identity is always present and sufficient for the ledger. · Revisited by a kitchen
operator sign-in requirement, should an accepted policy demand per-action operator attribution.

**C3/§11.1 (payment gate) — `PAYMENT_PENDING -> CLOSED` gated on all items resolved; settlement
deferred (M4-L1)** · Pay-before-fulfilment is DISABLED in M4: an order reaches `PAYMENT_PENDING`
only once every non-voided item is `SERVED`, and `CLOSED` is an explicit close from
`PAYMENT_PENDING` (`src/lib/restaurant/order-state-machine.ts`). No settlement/tender/bill wiring
exists — the transition is reachable but records no payment. · Conservative because it keeps the
order lifecycle complete and testable now while leaving money movement to the milestone that owns
it, and the QSR pay-before-fulfilment policy flag is present but off until an accepted service-mode
policy enables it. · Revisited by the payments milestone that wires settlement and may enable
pay-before-fulfilment for accepted QSR service modes.

**§11.1 / D14 (order & item command vocabulary — provisional) — send fires the whole order, fireCourse
fires one course, both print KOTs (M4-L2)** · The concrete command/transition set is the interim
authority pending D14's ADR (`order-state-machine.ts` owns the edges; `orders.ts` owns the commands):
items are added `HELD`; `send` moves every `HELD` item across all courses to `QUEUED`, `fireCourse(n)`
moves only course `n`'s `HELD` items to `QUEUED`, and BOTH generate kitchen tickets at that moment;
`holdCourse(n)` recalls a course's `QUEUED` items back to `HELD`; `advanceItem` walks
`QUEUED→FIRING→PREPARED→SERVED` (and `REMAKE_REQUESTED→SERVED` to accept a remake back). · Conservative
because it exercises every §11.1 item state with the fewest commands, keeps KOT generation in one
shared primitive reachable by both send and fire, and reads the "KOT at fire time" rule as "at
send-to-kitchen time". · Revisited by the D14 order/item invariant + transition ADR.

**§11.1 (order opens directly as OPEN) — DRAFT is a reserved seam (M4-L2)** · `openOrder` creates the
order already `OPEN` (schema default `DRAFT` is bypassed) with `openedAt` stamped and one `order.opened`
ledger event. · Conservative because M4 has no pre-open draft-cart surface, so a two-step
`DRAFT→OPEN` would only add a second event with no behaviour; `DRAFT` stays available for a future
draft-cart flow. · Revisited when a draft-cart/quote surface needs the `DRAFT` state.

**C4 (order-level price-list-version ref) — publication's list version stamped at open; per-item price
frozen at add (M4-L2)** · An order stamps `publicationId` + `priceListVersionId` at open, where the
version is the publication's own price list's effective version at the open instant (null when the
publication carries no list). Each item independently freezes its winning unit price at add time via
the M3 effective-menu precedence (item override > publication list > org base list), so an item priced
from the base list or an override still carries its exact snapshot even though the order-level
`priceListVersionId` names the publication list. Adding menu items requires the order to carry a
`publicationId` (`NO_PUBLICATION` otherwise). · Conservative because the schema holds one
version ref on the order, and snapshot-on-write on the item is what actually guarantees immutability. ·
Revisited when tax/service-charge config (which the zero-valued item fields reserve) lands.

**KOT ticket numbering — per-(station, businessDate) compute-max + unique-index backstop (M4-L2)** ·
Unlike order numbers (a locked sequence row), a kitchen ticket's number is `max(ticketNumber)+1` for
its `(station, businessDate)`; the unique `(stationId, businessDate, ticketNumber)` index is the
concurrency backstop — a losing concurrent fire to the same station rolls back and the client retries.
Numbers are unique + monotone, not gap-free. · Conservative because tickets are far lower-contention
than order numbers and reusing the same fail-closed discipline avoids a second sequence table. ·
Revisited if a busy pass shows ticket-number contention worth a dedicated sequence row.

**C7 (idempotency) — findUnique-first, fail-closed on the concurrent duplicate (M4-L2)** · A
terminal-submitted command looks up its `(deviceId, key)` first; a hit replays (re-reads the original
result, creates nothing), a miss records the key and proceeds. A genuinely concurrent duplicate that
loses the unique-index race rolls its whole transaction back; the client's retry then observes the
committed key and replays. · Conservative because sequential replay (the common terminal retry) is
exact and the concurrent case degrades to a safe retry rather than a double-write. · Revisited if a
savepoint-based in-transaction replay is needed.

**C6/C8 (M4-L2 back-office router surface) — session-capability gate; attribution passed explicitly**
· `restaurant-orders.ts` is the manager/back-office surface: reads gate on `orders:read`, mutations on
`orders:manage`, both org-role-driven (no static policy). Every mutating call carries the acting
`staffProfileId`, the registered `deviceId` and the device-scoped `idempotencyKey` explicitly in its
input (C6/C7), rather than deriving them from the session. The device-authenticated terminal/KDS
transport (M2 `withDeviceAuth`, capabilities `orders:take`/`kitchen:operate`) is a separate surface not
shipped in this lane. · Conservative because it keeps the command layer's attribution contract intact
and lets a console drive the full lifecycle now without inventing a session→staff-profile binding. ·
Revisited when the terminal/KDS device routes are built.

**§11.1 (post-preparation boundary) — FIRING onward requires co-auth to void/cancel (M4-L2)** · An item
is "post preparation" once it is `FIRING`, `PREPARED`, `SERVED` or `REMAKE_REQUESTED`; voiding one (or
cancelling an order that still holds one) requires a co-authorization + a recorded wastage disposition.
Pre-prep items (`HELD`/`QUEUED`) void on a reason alone. The disposition + outbox event are recorded;
no inventory mutation exists until the inventory milestone. · Conservative because `FIRING` is the
first state in which the kitchen has committed effort/cost, so it is the earliest defensible co-auth
boundary. · Revisited by the inventory/stock-policy milestone.

**§11.2 (table attribution) — tables only on dine-in; merge adds links; move keeps history (M4-L2)** ·
Tables attach only to a `DINE_IN` order (`CHANNEL_TABLE` otherwise); `moveTable` deactivates the source
link (`unlinkedAt` stamped) and creates a `MOVE` link; `mergeTables` adds `MERGE` links (several active
links under one order); `unlinkTable` deactivates. Combining two OPEN orders into one order is deferred.
· Conservative because it models seat/move/merge from the link-history table without a cross-order
merge, which needs an ownership-transfer design. · Revisited by the check-splitting/merging milestone.

**§4 (table occupancy) — derived from active order-table links, no status column (M4-L3)** · A
table's occupancy is DERIVED — occupied iff it has one or more active `RestaurantOrderTable` links
(`listFloors` in `src/lib/restaurant/floor.ts`) — never stored as an occupancy column. · Conservative
because it keeps one source of truth in the seating links the order layer maintains (C3 spirit) and
avoids a second status to keep in sync. · Revisited by a feature needing richer table lifecycle
states (reserved/dirty/held) beyond occupied/free.

**§4 (deactivate-not-delete once referenced) — floors/tables/sections/stations (M4-L3)** · A floor
or table with order-table history, a section referenced by orders, or a station referenced by
kitchen tickets is deactivated (`active = false`), not hard-deleted; delete is refused with a domain
error that steers to deactivate. · Conservative because the history FKs cascade (order-table links)
or restrict (kitchen tickets), so a hard delete would erase history or fail; deactivation preserves
the order/ledger trail. · Revisited by an admin purge tool that archives dependent history first.

**§8 (`floor:manage` grant) — Owner `*` until wired onto manager templates (M4-L3)** · The floor-
config capability `floor:manage` is a new ABAC action (`src/lib/abac/policies.ts`, org-role-driven,
no static policy). It is granted today only via the Owner `*` wildcard (or an explicit role/override
grant); it is NOT yet on the GM/branch-manager templates in the L1-owned `src/lib/vertical-catalog.ts`.
· Conservative because template capability wiring is an L1-owned file-lane decision out of L3's
scope, and the Owner grant keeps the surface reachable and testable now. · Revisited by the
capability-matrix pass that adds `floor:manage` to the manager role templates.

**C10 (floor reads gate on `orders:read`) — coordinated ABAC action shared with L2 (M4-L3)** ·
`listFloors`/`listSections`/`listStations` gate on `orders:read`, not `floor:manage` — the floor plan
is read by any order-reading operator (POS/KDS consoles), not only floor managers. `orders:read` is a
coordinated additive `ALL_ACTIONS` entry (L2 owns it; L3 declared it too so the lane compiles and
tests standalone; the supervisor dedups at merge). · Conservative because it matches the read-consumer
model and keeps the coordinated-file dedup a supervisor step. · Revisited if a finer floor-read
capability is introduced.

**§11.2 (section staffing branch match) — via staff `primaryBranchId` (M4-L3)** · A server may be
assigned to a section only when the staff profile is ACTIVE and its `primaryBranchId` equals the
section's branch. "Branch-assigned" is read from the staff profile's primary branch — staff profiles
are not necessarily Users, so the user↔branch `RestaurantBranchAssignment` table does not apply. ·
Conservative because `primaryBranchId` is the staff-profile-level branch pin that exists today, and
it enforces same-branch staffing without inventing a new staff-to-branch table. · Revisited by a
multi-branch staff assignment model.

**§4 (kitchen station default) — auto-default first; promotion transfers; delete of default refused
(M4-L3)** · A branch's first kitchen station is auto-marked default; promoting another transfers the
default (clearing the incumbent in the same transaction); deactivating the current default is
refused. "At most one default per branch" is a partial unique index and the P2002 a concurrent
promotion loses surfaces as `DEFAULT_CONFLICT`. Routing-rule re-targeting is delete + create
(`updateRoutingRule` edits only `priority`). · Conservative because routing falls through to the
default, so a branch with stations always has exactly one and never an unrouteable gap, and a single
XOR-validation path is simpler. · Revisited by per-station-group defaults or in-place rule
re-targeting.

**C7/C8 (terminal + KDS command transport) — Idempotency-Key header; thin routes over L2 (M4-L4)** ·
The POS-terminal order routes (`src/app/api/restaurant/orders/*`) run under M2 `withTerminalAuth` and the
KDS routes (`src/app/api/restaurant/kds/*`) under `withDeviceAuth`; both carry the device-scoped
idempotency key in an `Idempotency-Key` request header (never the body), and every mutating route rejects
a missing key with a 400. Routes hold no order/kitchen domain logic — they build the attribution envelope
from trusted transport values only (operator = the session's active staff on an UNLOCKED terminal;
terminal = the authenticated device; key = the header) and dispatch to the single L2 command layer.
Domain errors are shaped to HTTP mirroring the L2 tRPC mapping (NOT_FOUND→404, state/precondition
conflict→409, else→400), leaking no internals; a non-domain throw is a generic 500. · Conservative because
it reuses the proven M2 device-auth + the L2 command/idempotency contract unchanged. · Revisited if a
non-header idempotency channel or a per-route capability gate is required.

**C8 (KDS operator attribution) — required at the transport, not optional (M4-L4)** · The KDS bump/ack/recall
routes require an `operatorStaffProfileId` in the body (verified to be an ACTIVE staff profile) in addition
to the bound device, because the shared L2 `advanceItem` command records a non-null acting operator on its
ledger event. This is STRICTER than the C8 "optional operator attribution" aspiration: the transport cannot
express a null operator without an L2 change (its `CommandActor.staffProfileId` is non-nullable), so this
lane surfaces the operator rather than fabricating one. · Conservative because attribution is present, not
absent — safer for audit. · Revisited (via the CoS, owned by the L2 command layer) when a no-login KDS UX
needs a genuinely operator-less action, which requires L2 to accept a null operator on `advanceItem`.

**§12.5 (KDS read model) — ticket-number sequence cursor + gap detection; level-triggered queue (M4-L4)** ·
The station queue (`src/lib/restaurant/kds.ts`) is derived purely from durable rows (kitchen tickets + each
line's current item-domain status). It is LEVEL-TRIGGERED: every poll returns the authoritative current open
set (tickets with a non-cleared line, oldest-first, bounded by `limit`), each line mapped onto its FIXED L1
KDS display status. The cursor is the station's ticket-number high-water mark for the business date
(`ticketNumber` is sequential per (station, businessDate), so it is the natural per-station sequence). A gap
(full-reconcile signal) is raised when either the client's `sinceCursor` exceeds the current max — the
sequence regressed, e.g. the screen was offline across the business-day cutoff — or the open queue overflows
the poll window (`hasMore`). The business date defaults to the branch's current one (server-time, DST-safe,
C5). · Conservative because a level-triggered read is always correct regardless of cursor, and the gap flag
only advises reconciliation; no incremental diff can drift. · Revisited when the outbox nudge transport is
selected and an item-state-change cursor (beyond new-ticket detection) is needed.

**C9/C10 (device-authed effective-menu read) — re-composed from M3 primitives, no M3 edit (M4-L4)** · A POS
pad has no web session, so it cannot reach the M3 `effectiveMenu` tRPC read. `resolveTerminalEffectiveMenu`
(`terminal-orders.ts`) resolves the branch's live PUBLISHED publication (or an explicit one) and re-composes
the winning price (override > publication list > base list) and branch-timezone availability from the SAME
exported M3 primitives (`resolveEffectiveEntries`/`pickEntry`, `channelPublished`/`isItemAvailableAt`/
`partitionWindows`) that the back-office read uses — the established `order-pricing.ts` precedent — without
modifying an M3-owned file (C9). · Conservative because it reuses the M3 resolution contract rather than
forking it, at the cost of a parallel projection that must track the M3 read's shape. · Revisited if the M3
menu resolution is extracted into a shared exported lib both surfaces call.

### M5 — money (bills, tenders, payments, refunds, drawers, close, receipts)

**C2 (rounding mode) — ROUND_HALF_UP at 2 decimal places (M5-L1)** · All money rounding goes through the
single `roundMoney` in `src/lib/restaurant/money.ts`, which rounds to 2dp ROUND_HALF_UP (halves away from
zero, symmetric for negatives). Every monetary column is `DECIMAL(12,2)`; there is no float, `parseFloat`,
`Number()` arithmetic, or `toBeCloseTo` on any money path, and money tests assert exact Decimal string
equality. · Conservative because ROUND_HALF_UP is the common retail/hospitality rounding and a single
rounding function keeps every downstream lane bit-identical. · Revisited if a jurisdiction requires
banker's rounding or a different scale.

**C4 (fractional split remainder) — largest-remainder, base = floor(total × weight ÷ Σweights), ties to the
lowest split index (M5-L1)** · `allocate(total, weights)` divides a total across integer weights in integer
cents: each share's base is the floored proportional amount and the leftover cents are handed out one per
share in DESCENDING fractional-remainder order, ties broken by ASCENDING share index. Σ(shares) ≡ the total
EXACTLY and the outcome is byte-identical across runs (e.g. 100.00÷3 → 33.34/33.33/33.33; 0.01÷3 →
0.01/0.00/0.00). · Conservative because a pinned deterministic remainder rule makes splits reproducible and
auditable — no cent is created or lost. · Revisited only by an explicit change to the pinned rule via the
CoS (it is a coordinated contract every money lane codes to).

**C4 (split allocation granularity) — whole-item BY_ITEM/BY_SEAT; per-quantity fractioning deferred
(M5-L1)** · BY_ITEM and BY_SEAT place each non-voided order item on exactly one bill as a WHOLE line; a
single item's quantity is not divided across bills. FRACTIONAL divides the order total by integer fraction
pairs (via the `allocate` rule above), never by re-pricing items. · Conservative because whole-item
allocation is unambiguous and covers the common check-split cases without a per-unit pricing model. ·
Revisited when per-quantity or per-portion splitting is required.

**C5 (tips) — captured at tender time only; no post-capture tip-adjust flow (M5-L1)** · `tipAmount` lives on
tender and refund records only and is NEVER merged into the (still structurally-zero) service-charge item
snapshot; the daily close reports `tipTotal` and `serviceChargeTotal` as separate columns. The MOCK adapter
ships the ADJUST capability (contract-tested), but no operator-facing post-capture tip-adjust FLOW ships in
M5 — a tip correction is a refund + re-tender. · Conservative because tip-at-tender is the simplest correct
capture and keeps tips provably distinct from service charges. · Revisited when a gratuity-adjust UX (bar
tab / delayed tip) is scheduled.

**C3 (append-only enforcement) — DB-enforced by RLS policy omission (M5-L1)** · `restaurant_tenders`,
`restaurant_payment_events`, `restaurant_refunds`, `restaurant_drawer_movements`, `restaurant_daily_closes`,
and `restaurant_daily_close_tender_totals` receive SELECT + INSERT RLS policies ONLY. With forced RLS and no
UPDATE/DELETE policy, the unprivileged app role cannot mutate or delete any row (the operation matches zero
rows) — these tables carry no `updatedAt`, and a correction is observable only as a NEW record referencing
the original. · Conservative because policy omission is a database-level guarantee that no application bug
can loosen, and it needs no per-table GRANT/REVOKE (which the RLS verifier re-grants anyway). · Revisited
only if a legitimate flow appears to need an in-place edit, which routes back to L1 via the CoS as a design
defect — never an ad-hoc policy loosening.

**C9 (close prerequisites) — every drawer session CLOSED and every bill SETTLED or VOID for the date
(M5-L1)** · A daily close for a branch × businessDate can be cut only once every drawer session for that
date is CLOSED and every bill is SETTLED or VOID; once cut, the row is immutable (append-only), and a
"reopen"/correction is a NEW `RestaurantDailyClose` with `supersedesCloseId` + reason + manager
co-authorization, the chain tip being authoritative in every read. · Conservative because it guarantees the
close reconciles against a settled, counted day and can never silently rewrite a prior day. · Revisited if a
partial/interim close is required.

**C7 (correction posting date) — refunds post to the PROCESSING business date (M5-L1)** · A refund carries
its own `businessDate` = the date it is processed; a cross-business-date correction (a prior day's tender
refunded today) appears in TODAY's close and never mutates the prior day's close, which re-reads
byte-identical. · Conservative because an immutable prior close plus current-day posting is the standard
accounting treatment and keeps every closed day reproducible. · Revisited if statutory reporting requires
original-date attribution.

**C10 (receipt numbering) — unique + monotonic per (branch, businessDate), not gap-free, non-fiscal
(M5-L1)** · Receipt numbers allocate transactionally from `restaurant_receipt_number_sequences` (a seam
SEPARATE from order numbers), assigned once at settlement; they are guaranteed unique and monotone but NOT
gap-free (a rolled-back settlement consumes a number) and carry no fiscal/printer/registration semantics. ·
Conservative because unique + monotone is what a check number needs, and gap-free/fiscal numbering is a
regulated feature better built deliberately. · Revisited when fiscalization or gap-free legal numbering is
scoped.

**C6 (payment provider) — MOCK adapter only; D23 not built (M5-L1)** · The provider registry contains
exactly one provider, MOCK (deterministic refs + scriptable outcomes for tests), implementing all six
capabilities SALE/AUTH/CAPTURE/ADJUST/VOID/REFUND. There is no real PSP network I/O and no PAN/CVV/track
data is ever stored or logged — only provider references, sanitized method info, amounts, status, and
timing. · Conservative because a capability-shaped MOCK exercises the whole settlement surface with zero PCI
exposure. · Revisited when a real payment-provider integration (D23) is scheduled.

**C1 (single currency) — one currency per organization, unlabelled (M5-L1)** · Money columns carry no
currency code; every amount in an organization is in that organization's single implicit currency. ·
Conservative because the restaurant vertical is single-currency in v1 and an unused currency column invites
drift. · Revisited when multi-currency pricing/settlement is scoped.

**C9 (`discountTotal`) — structurally present, zero in M5 (M5-L1)** · The daily close carries a
`discountTotal` column that is structurally zero throughout M5; comps (which net a line to zero via
`compAmount` with reason + co-authorization) flow to `compTotal`, not to discounts. · Conservative because
carrying the column now keeps the close shape stable while the percentage/amount discount engine is a later
milestone. · Revisited by the discount milestone.

**C9 (co-authorization composite tenant FK) — single-column FK only, no composite tenant FK (M5-L1)** ·
Money references to `restaurant_co_authorizations` (bill void, bill-line comp, refund, close correction)
use a single-column FK only, with no deferred `(organizationId, id)` composite tenant FK — matching the M4
precedent for the void co-authorization reference: the co-authorization table carries no `(organizationId,
id)` unique and is consumed, never modified. · Conservative because it follows the established cross-table
reference discipline without adding a unique to a consumed table. · Revisited if co-authorizations gain a
composite tenant key for other reasons.

**C9 (daily-close aggregation definitions) — pinned totals so L3 and the L6b reconciliation agree to the
cent (M5-L3)** · A branch × businessDate close aggregates ONLY the persisted rows for that date, defined
exactly as: `grossSales` = Σ SETTLED bill `subtotal` (menu prices, pre-comp/pre-discount); `compTotal`,
`taxTotal`, `serviceChargeTotal` = Σ SETTLED bill of the same column (tax/service-charge structurally zero
in M5); `discountTotal` = Σ settled bill discounts; current report `netSales` = `grossSales − compTotal − discountTotal − refundTotal` (refund principal on processing date, deducted once; legacy closes are normalized on read); `voidTotal` = Σ VOID
bill `grandTotal`; `tipTotal` = Σ tender `tipAmount` for the date (GROSS — equal to Σ of the per-tender-type
child `tipAmount`); `refundTotal` = Σ refund `amount` for the PROCESSING date (C7 — a cross-business-date
correction lands on the day processed and never mutates a prior day's close); `cashExpected`/`cashCounted`/
`cashVariance` = Σ over the date's drawer sessions of the ledger fold / counted cash / (counted − expected).
Per-tender-type child rows carry Σ `amount` + Σ `tipAmount` + a count grouped by CASH/CARD/OTHER (only types
present, in enum-definition order). Per-bill `roundingAdjustment` is excluded from gross/net because it nets
to zero across a fractional split (C4). All values are `Prisma.Decimal`; equality is exact string equality.
· Conservative because pinning the definitions lets the independent L6b recomputation read the same numbers
from raw bill/tender/refund/movement rows without coding to L3's implementation. · Revisited when the tax or
discount engines introduce non-zero components.

**C8 (drawer expected-cash fold sign convention) — one signed fold, closing count excluded (M5-L3)** ·
`expectedCash` is DERIVED, never stored on a movement: OPENING_FLOAT + CASH_SALE + PAID_IN add;
CASH_REFUND + PAID_OUT + DROP subtract; CLOSING_COUNT folds to zero (it is the physical count, recorded in
the ledger for audit but not part of the expectation). Movement `amount` is always a non-negative magnitude
(DB CHECK); the sign is applied by kind in the one fold used by both the drawer close and the daily close, so
`session.expectedCash` and the L6b cash-reconciliation identity (Σ floats + sales − refunds + paid-ins −
paid-outs − drops ≡ Σ expectedCash) match by construction. · Conservative because a single signed fold with
non-negative magnitudes removes any per-call sign ambiguity. · Revisited if a new movement kind is added.

**C4/C12 (settlement reconciliation identity) — Σ(bill grandTotal + compTotal) ≡ derived order total (M5-L2)**
· The bill layer and the order-close settlement guard reconcile a bill set against its order by
`Σ over non-void bills of (grandTotal + compTotal)` — a comp adds its own amount back, so the identity
holds with or without comps and across every split kind (a bill's `grandTotal = subtotal + tax + service
charge − compTotal + roundingAdjustment`, with tax/service-charge structurally zero in M5). · Conservative
because it is the one Decimal-exact identity that unifies item-partition and fractional splits and makes the
close guard independent of comp placement. · Revisited when tax/service-charge become non-zero (the identity
generalizes; the reconciliation columns already exist).

**C4 (FRACTIONAL bills carry no item lines) — fractional split divides the total, not the items (M5-L2)** ·
A FRACTIONAL bill owns a `money.allocate` share of the ORDER total and carries NO `restaurant_bill_lines`
(bill lines exist only for NONE/BY_ITEM/BY_SEAT); item coverage for a fractional order is proven by the
money identity above rather than a per-item partition. A comp therefore requires an item-carrying split
(NONE/BY_ITEM/BY_SEAT), since a comp targets a bill line. · Conservative because per-item lines on a
fractional bill would double-count the total; the schema's `orderItemId`-bearing line is honestly reserved
for item splits. · Revisited if per-quantity fractioning or comps-on-fractional-bills are scoped.

**C4 (roundingAdjustment semantics) — the largest-remainder +cent, item splits carry zero (M5-L2)** · For a
FRACTIONAL bill, `subtotal` = the floor base share and `roundingAdjustment` = the extra cent (0.00 or 0.01)
the pinned largest-remainder rule handed that bill, so `grandTotal = subtotal + roundingAdjustment` and the
grand totals sum to the order total exactly; the authoritative per-bill amounts come from `money.allocate`,
and the floor base is recovered with exact integer-cent Decimal ops mirroring `allocate`'s own base rule.
Item-partition bills (NONE/BY_ITEM/BY_SEAT) split whole items with no rounding, so `roundingAdjustment` is
zero. · Conservative because it records the remainder distribution transparently without a second arithmetic
path. · Revisited if a different rounding/remainder policy is chosen (money.ts is the single owner).

**C4 (BY_SEAT designated bill for unseated items) — one bill, placed last, seats ascending (M5-L2)** ·
BY_SEAT groups non-voided items by the M4 `seatNumber` seam into one bill per seat (ascending seat order);
items with no seat form ONE additional designated bill placed last. · Conservative because a deterministic
grouping keeps the split reproducible and every non-voided item lands on exactly one bill. · Revisited if
per-seat bill designation becomes operator-configurable.

**C4 (re-split = void-and-recut) — re-split only while all live bills OPEN + untendered (M5-L2)** · Cutting
bills for an order that already has live (non-void) bills is refused unless a `recut` (reason + manager
co-authorization) is supplied AND every live bill is still OPEN and untendered; the recut voids the existing
bills as new VOID records (reason + co-auth) and creates a fresh set — never an in-place edit. Once any bill
is SETTLED or carries a tender, re-splitting is locked (RESPLIT_LOCKED). · Conservative because it preserves
the append-only spirit (corrections are new records) and never rewrites money after settlement begins. ·
Revisited if partial re-splits of an already-tendered order are scoped.

**C12 (close parks at PAYMENT_PENDING) — settlement guard gates only PAYMENT_PENDING → CLOSED (M5-L2)** ·
The order close command consults the bills-settled predicate before `PAYMENT_PENDING → CLOSED` only; a
just-served order whose first close would advance SERVED → PAYMENT_PENDING is PARKED at PAYMENT_PENDING when
not yet settled (awaiting tender — returns success, no error, so bills can be cut and tendered), while an
order already at PAYMENT_PENDING that is asked to close while unsettled is rejected (NOT_SETTLED). The §11.1
state machine and its edges are unchanged. · Conservative because it keeps the single declared cross-milestone
`orders.ts` edit bounded to a pre-transition guard and avoids a chicken-and-egg where an order can never reach
the state in which it is tendered. · Revisited if a distinct explicit "request payment" command is introduced.

**C6 (MOCK adapter — pure execute, deterministic refs, scriptable declines) (M5-L4)** · The payment adapter
`execute` is PURE (no I/O, clock, or RNG): it returns a normalized outcome + an append-only event DRAFT that
the caller persists inside its own money transaction. Provider references are a SHA-256 of the capability +
a caller-supplied operation seed (deterministic and reproducible), and outcomes are scripted through
DESIGNATED DECLINE AMOUNTS — a SALE/AUTH whose amount ends in a designated cent code (13 GENERIC_DECLINE,
51 INSUFFICIENT_FUNDS, 54 EXPIRED_CARD) declines; post-authorization ops (CAPTURE/ADJUST/VOID/REFUND) always
approve against a valid prior reference. ADJUST is contract-level only (C5) — implemented + conformance-tested,
not wired into a tender command. · Conservative because deterministic refs + amount-scripted declines keep the
suite and any checkout demo reproducible without a real PSP, and a pure operation lets a decline roll back with
nothing persisted. · Revisited when a real provider (D23) is scoped — the registry (`getPaymentProvider`) and
capability interface are the seam.

**C6 (declined SALE aborts the whole tender transaction) (M5-L4)** · A card SALE decline THROWS, rolling back
the entire tender transaction, so a decline leaves NO tender, drawer movement, payment, event, receipt, or
idempotency key. A persisted decline-audit trail is deferred. · Conservative because it is the simplest form of
the atomicity the plan requires (declined SALE leaves nothing) and never half-writes money state. · Revisited
if a durable declined-attempt audit trail is scoped (it would commit a DECLINED payment + event instead of
rolling back).

**C5 (cash tenders carry no tip; net CASH_SALE movement = the applied amount) (M5-L4)** · A CASH tender records
`cashReceived` (≥ amount) and `changeGiven = cashReceived − amount`; its `tipAmount` is always zero and the
paired CASH_SALE drawer movement equals the applied `amount` (the net cash retained), so the drawer fold
reconciles to the cent. Tips are a CARD/OTHER concept in M5. · Conservative because it keeps drawer
accountability exact (net cash in = sale amount) without modelling cash-tip pooling. · Revisited if cash tips /
tip-outs are scoped (the tender `tipAmount` column already exists).

**C4/C10 (settle-exactly-once via a bill-row lock) (M5-L4)** · A tender may never be applied for more than the
bill's outstanding balance (the only over-payment is cash change), and the applied tenders settling the bill is
serialized by a `SELECT … FOR UPDATE` lock on the bill row: concurrent FINAL tenders block on the lock, so
exactly one settles + allocates the receipt and the loser observes the SETTLED bill and is rejected
(BILL_NOT_OPEN). The same bill lock serializes concurrent refunds so Σ(refunds) can never overshoot the tender.
· Conservative because the append-only tender/refund tables cannot be row-locked to serialize, so the
UPDATE-capable bill row is the serialization point; receipts stay gap-tolerant but allocated-once. · Revisited
if a queue/outbox settlement path replaces synchronous settlement.

**C7 (VOID_REVERSAL is same-day full only; refunds post to the processing day) (M5-L4)** · A VOID_REVERSAL is
accepted only for a SAME-DAY FULL reversal with no prior refund (CARD → adapter VOID → VOIDED; CASH →
CASH_REFUND movement); anything partial or cross-day is a REFUND (CARD → adapter REFUND → PARTIALLY_REFUNDED /
REFUNDED). Every refund posts to the register's CURRENT processing business date, so a cross-business-date
correction lands on today and never mutates a prior day's immutable close. Cash refunds require an OPEN drawer
and write exactly one CASH_REFUND movement. · Conservative because it keeps corrections append-only and the
daily close immutable while still allowing next-day returns. · Revisited if same-day partial voids or
provider-side settlement batching are scoped.

**C11 (terminal money capability gate resolves via the operator's linked-user org-role) (M5-L5)** · Every
checkout + cash route gates the ACTING operator on its C11 capability — `payments:collect` (bill cut/split/
re-cut, comp, tender, the settlement + receipt reads), `payments:refund` (refund), `cash:open` (drawer open),
`cash:adjust` (drawer movement), `cash:close` (drawer close, day preview/close/correct) — and a co-authorized
action (comp, re-cut, refund, close correction) additionally requires the APPROVING manager to carry
`coauth:approve` on top of proving their own credential. No restaurant-operator capability store exists (a
`RestaurantStaffProfile` has no role/capability column and none is added — C12 forbids pre-M5 schema changes,
and `abac/policies.ts` + the schema are L1-only), so an operator's capabilities are resolved from its linked
`User`'s effective org-role permissions + non-expired per-user overrides (default-DENY; no linked user ⇒
denied; wildcard `*` / `namespace:*` honoured), the SAME store and rule the back-office `money:read` reads use
(`operatorHasCapability` mirrors ABAC `customDecision`). **Downstream contract:** a money operator — and any
co-auth approver — must therefore be a staff profile LINKED to a user whose org role grants the capability; a
credential-only operator with no linked user is refused every money route. L7a/L6b seed money operators
accordingly. · Conservative because it reuses the platform's only capability model (org-role-driven, symmetric
with the back-office money reads) rather than inventing a parallel operator-capability table or touching the
L1-only schema/ABAC registry. · Revisited if a first-class restaurant-operator role/capability assignment is
scoped (an L1 schema seam) — `operatorHasCapability` is the single swap point.

**C12 (register read surface — settlement summary + settled-bill receipt, capability-gated) (M5-L5)** · The
read contract ships two device-scoped register reads on the L5 REST surface — `getOrderSettlementForBranch`
(per-order bill/settlement state) and `buildReceiptForBranch` (the settled-bill receipt, DISPLAY DATA ONLY:
branch/receipt-number, lines, totals, and each tender's amount/tip/change — never PAN/CVV/track data, C6) —
plus the L3 `closePreview` for the day. All three are branch-scoped (a cross-branch or cross-tenant id is
indistinguishable from 404) and require an acting operator + the sibling money capability, so financial display
data is gated (unlike the ungated M4 order reads). · Conservative because financial reads are held to the
checkout/close operator rather than any device session, and the receipt exposes no card data. · Revisited if a
read-only floor/customer-display surface is scoped.

### M6 — inventory & purchasing

**D07 (inventory costing, negative stock, recipe-consumption posting, remake/void-after-preparation, batch/lot,
production-batch, and backdating policies) (M6-L1)** · D07 is `OPEN` in the D-register; M6 records these
conservative defaults behind the plan's §11.4 seam. **(1) Costing — read-time weighted-average.** On-hand cost is
weighted-average, derived AT READ TIME from intrinsic-cost movements: only `PURCHASE_RECEIPT` and
`SUPPLIER_RETURN` carry a `unitCost` (per canonical unit); WAC = Σ(quantity×unitCost) ÷ Σ(quantity) over those
movements. No FIFO/LIFO layers; no per-consumption cost snapshot is written. **(2) Negative stock — permitted,
flagged, never blocked.** There is NO on-hand balance column and NO balance pre-check at posting; a movement is
appended unconditionally, so a derived on-hand may go negative and is surfaced/flagged in reads (compared against
zero / the low-stock threshold). **(3) Recipe-consumption posting point — at order close.** `RECIPE_CONSUMPTION`
movements post transactionally at order close (M5's settle-then-close guarantees settlement first). Remake or
void-after-preparation consumes per the recorded C6 `wastageDisposition`: `WASTE` → a `WASTAGE` movement;
`RESTOCK` → no consumption; `NONE` → no movement. `SALE_REVERSAL` covers post-close corrections. **(4) Backdating
— immutable rows, corrections are new movements.** Ledger rows are immutable (DB-enforced append-only: forced RLS
with SELECT+INSERT policies only, no UPDATE/DELETE); a correction is a NEW movement with `occurredAt` in the past
and `recordedAt` = now. **(5) Batch/lot — optional seam only.** `RestaurantStockBatch` is recordable at receiving
and referenceable by movements (`RestaurantStockItem.trackBatches` toggles it); NO expiry gating and NO FEFO
enforcement. **(6) Production/preparation batches — NOT built (D23 deferred).** · Conservative because each choice
avoids a hard-to-reverse commitment before D07 closes: read-time WAC needs no racy cost snapshots under parallel
writes; permitting negative stock keeps posting append-only and race-free (a pre-check would serialize writers and
still race), and never blocks service; posting consumption at close reuses the settled M5 guarantee; immutable
backdated corrections preserve history; the batch seam records data without enforcing an unproven lot policy. The
append-only ledger + exact-Decimal derived balance are proven under ≥8-way concurrency
(`tests/restaurant-m6-stock-concurrency.test.ts`). · Revisited by D07 closing — worked costing/reconciliation
examples from Product owner + Finance + Restaurant operations SME may replace WAC with FIFO layers, gate negative
stock, or move the consumption posting point; and by D23 for production/preparation batches.

### M7 — scheduler, SOP & notifications

**D13 (background scheduler mechanics + worker org-scoping) (M7-L1)** · D13 is `OPEN` in the D-register; M7 records
these conservative defaults behind the plan's §11.5 scheduler seam (`src/lib/restaurant/scheduler.ts` over the
org-scoped `restaurant_jobs` queue + the append-only `restaurant_job_executions` history). **(1) Claiming —
at-least-once, exactly-one-in-flight.** A due `QUEUED` job (`nextAttemptAt <= now`) is claimed with
`SELECT … FOR UPDATE SKIP LOCKED` inside ONE tenant-scoped transaction, so N parallel claimers over M due jobs each
take a DISTINCT job — never the same one twice, never a lost job (proven under ≥8-way concurrency in
`tests/restaurant-m7-scheduler-concurrency.test.ts`). Delivery is therefore at-least-once and handlers MUST be
idempotent (a job can run again after a worker crash). **(2) Retries — bounded, exponential backoff → DEAD.** A
failed attempt appends one immutable execution row and, while `attempts < maxAttempts` (default 5), re-queues with
backoff `min(30s·2^(attempts-1), 30m)`; once exhausted the job moves to `DEAD`. A handler may declare a failure
permanent (non-retryable) → `FAILED`, skipping the remaining budget. **(3) Recovery + graceful shutdown.** A job
stuck `RUNNING` past a 15-minute lease is requeued (worker crash); on shutdown a worker stops claiming and releases
its just-claimed job back to `QUEUED`, rolling back the claim's attempt increment. **(4) Injectable clock.** Every
time decision (due filter, backoff schedule, lease expiry) flows from an explicit `now`/`clock`, never a hidden
`Date.now()`. **(5) Worker org-scoping vs. cross-org claim.** There is NO cross-org queue scan in the unprivileged
app role: a claimer runs inside `withTenantDb`, so forced RLS restricts the visible queue to the current
organization. A privileged multi-org worker still executes each job INSIDE its target organization's RLS context
(`app.current_organization_id` set to that org) — never a bypass-RLS mutation of tenant rows. Handler registration
is a typed registry (`src/lib/restaurant/job-handlers.ts`) so L2–L5 plug in independently (one import + one key).
· Conservative because `FOR UPDATE SKIP LOCKED` is Postgres's proven, race-free work-claim primitive (already used
by `src/lib/platform/jobs.ts`); at-least-once + idempotent handlers is the standard durable-queue contract and is
far safer than an unproven exactly-once protocol; bounded backoff → DEAD prevents a poison job from looping
forever; and claiming inside the target org's RLS context keeps the strong M1–M6 tenancy boundary intact even for a
privileged worker. · Revisited by D13 closing — a decision on a dedicated queue technology, exactly-once semantics,
priority/fairness across organizations, or a separate worker identity/authorization model.

**D21 (notifications channel matrix + delivery) (M7-L1)** · D21 is `OPEN`; M7 records these conservative defaults
behind the §11.5 notification seam. **(1) Channels — in-app real, the rest stubbed.** `RestaurantNotificationChannel`
is `IN_APP | EMAIL | SMS | PUSH | WHATSAPP`; only `IN_APP` is actually delivered in M7. `EMAIL`/`SMS`/`PUSH`/
`WHATSAPP` are explicitly stub-only and recorded as `STUBBED` deliveries — the append-only `restaurant_notification_deliveries` ledger captures every attempt
(`DELIVERED_IN_APP` / `STUBBED` / `FAILED`) so the provider adapter a later integration fills changes no schema.
**(2) Matrix — category × channel with a branch override.** `restaurant_notification_channel_settings` enables a
channel per free-form category, with a null `branchId` as the organization default and a set `branchId` as a branch
override; the branch-override-then-org precedence is resolved in app code (L5). **(3) Categories are open strings.**
Notification `category` and the matrix `eventCategory` are plain strings, not an enum, so L2–L5 register new event
categories without a schema/enum change (which would be a shared-file merge conflict). · Conservative because
stubbing the non-in-app channels behind the same delivery ledger lets the in-app product ship now while keeping an
exact, auditable record of what WOULD have been sent, and an open category string avoids coupling every later lane
to one enum. · Revisited by D21 closing — a chosen email/SMS/push/WhatsApp provider set, delivery-retry SLAs, and a
per-recipient channel-preference model.

**SOP-defaults (versioning, recurrence/DST, evidence, occurrence flow, late/missed, escalation) (M7-L1)** · The §11.5
SOP micro-policies are `OPEN`; M7-L1 records the conservative defaults its schema + RLS commit to. **(1) Versioning
— immutable-once-PUBLISHED, occurrence-pinned.** A template FAMILY (`restaurant_sop_templates`, the unit counted by
`sop.templates.max`) owns ordered VERSIONS (`DRAFT → PUBLISHED → RETIRED`); a `PUBLISHED` version is immutable and
the only kind an assignment may pin, and every occurrence pins its `templateVersionId` with `ON DELETE RESTRICT`, so
a later edit never rewrites recorded compliance history (the M3 C3 versioning precedent). **(2) Recurrence + DST —
generated against branch wall-clock.** An assignment carries `frequency` (`ONCE/DAILY/WEEKLY/MONTHLY`) + `interval`
(+ `daysOfWeek` for weekly, `monthDay` for monthly) over `[startDate, endDate]` with a branch-local `dueTimeMinutes`
and `windowMinutes`/`graceMinutes`. Occurrences are generated against the BRANCH wall-clock/timezone (never a fixed
UTC offset), so a DST shift keeps "the 9am open check" at 9am local; the derived `dueAt`/`windowEndsAt` are stored as
UTC instants and `businessDate` is the branch business day (`business-date.ts`). **(3) Evidence — append-only,
requirement flags recorded not enforced.** Template steps carry `requiresPhoto/Signature/Note` flags; captured
evidence (`restaurant_sop_evidence`) is APPEND-ONLY (content-hash + a nullable `storageRef` blob seam, non-negative
`sizeBytes`) — L1 records the requirement flags and evidence rows but does NOT enforce completeness (an L-domain
concern). The M7-L4 execution lane enforces it at submit: every checklist step must be completed and each step's
`requiresNote` (non-blank), `requiresPhoto` and `requiresSignature` flag must be satisfied before `IN_PROGRESS →
SUBMITTED`. **(4) Occurrence flow + late/missed.** `RestaurantSopOccurrenceStatus` is EXACTLY the eight §11.5 states
(`SCHEDULED/IN_PROGRESS/SUBMITTED/VERIFIED/REJECTED/LATE/MISSED/WAIVED`); LATE = submitted after the due window,
MISSED = window elapsed with no submission. Transitioning overdue occurrences to LATE/MISSED is a scheduled sweep (a
scheduler job an L-domain lane registers); L1 stores the states and the due/window instants that drive it.
Verification decisions (`restaurant_sop_verifications`, APPEND-ONLY: `VERIFY/REJECT/WAIVE`) may pin an M2
co-authorization for a sensitive decision (single-column FK, the M5 refund precedent). **(5) Escalation — append-only
events, scoped policies.** An escalation policy is `ORG`- or `BRANCH`-scoped with stop conditions and branch-local
quiet hours; its ordered steps carry a delay, a target, a channel, and a bounded attempt count; firing history is
the APPEND-ONLY `restaurant_sop_escalation_events` ledger (`FIRED/ACKNOWLEDGED/STOPPED`), from which the live
escalation state is folded. · Conservative because pinning the published version + append-only evidence/verification/
escalation ledgers makes compliance history tamper-evident (a correction is a new row, never an edit — the M5/M6
ledger discipline); generating recurrence against the branch wall-clock is the only choice that survives DST without
drifting due times; and recording evidence-requirement flags without enforcing them keeps the L1 seam permissive for
the L-domain flow lanes. · Revisited by the §11.5 SOP decisions closing — worked recurrence/DST, evidence-retention
(vs `sop.evidenceRetentionDays`), and escalation-timing examples from Restaurant operations SME may tighten
completeness enforcement, add FEFO-style evidence gating, or change the late/missed sweep cadence.

**M7-L2 runtime (worker org-scoping, outbox dispatch, webhook inbox, ops gate) (M7-L2)** · The L1 primitives
(`scheduler.ts` + the empty `job-handlers.ts` registry, `outbox.ts`'s M4 dispatch seam) are DRIVEN by this lane's
runtime; the decisions it commits to. **(1) Worker runtime realizes D13 §5.** `job-runner.ts` discovers organizations
with due work via a PRIVILEGED READ scan (`withPlatformDb`, allowed by the tenant-isolation policy's `is_platform_admin`
branch — reads only, never a cross-org mutation) and then runs every claim/handler/settle AND outbox dispatch INSIDE
each org's `withTenantDb` RLS context; a job handler receives a tenant-scoped `db` bound to its own org. The worker is
a poll loop with graceful shutdown (SIGINT/SIGTERM → abort → finish the current claim, releasing an unstarted job) and
an interruptible idle sleep; everything time/tenancy-dependent is injectable so the unit tests are DB-free (the ≥8-way
DB concurrency evidence stays in L1's battery). Entry point: `scripts/run-restaurant-jobs.ts` / `restaurant:jobs`
(mirrors `platform:jobs`; `--once` = a single tick for cron/CI). **(2) Outbox dispatcher clears the M4 §12.2 debt.**
`outbox-dispatcher.ts` claims due `PENDING` rows (`FOR UPDATE SKIP LOCKED`, mirroring the scheduler) and delivers each
to a consumer resolved from an IN-PROCESS registry keyed by `eventType`, reusing M4's `planDispatchSuccess`/
`planDispatchFailure` + `DEFAULT_OUTBOX_RETRY_POLICY` (8 attempts, 1s→1h) unchanged. Conservative defaults: the L2
registry ships EMPTY (later lanes register one key each, the same seam as `job-handlers.ts`); a row whose `eventType`
has NO registered consumer is left `PENDING` and counted `skipped` — never silently dropped, never dead-lettered — so a
consumer a later lane registers picks it up. The consumer runs INSIDE the claiming transaction, which is correct for M7
(all real external channels are D21-stubbed / in-process); a future external-delivery consumer doing long network I/O
will need a lease-based claim instead (the §12.2/D21 follow-up). **(3) Webhook inbox seam (D21).** The receiver
`/api/restaurant/webhooks/[source]` resolves the tenant STRICTLY from the request host (`resolveExplicitOrganizationBy
Host` — never the DEFAULT_ORGANIZATION_ID fallback and never a client-supplied org; an unknown host is a flat 404), is
IP rate-limited (unauthenticated public endpoint), parses a STRICT envelope `{ externalEventId, eventType?, payload }`
(unknown keys rejected), deduplicates by `(org, source, externalEventId)` (fast-path check + the unique index as the
authoritative guard, a lost race resolved to the existing row), records a STUB signature status
(`verifyWebhookSignatureStub`: `VERIFIED` when a signature header is present, `PENDING` when unsigned — NO real crypto in
M7; `FAILED` reserved for the adapter that replaces the stub), and enqueues a `webhook.process` job (idempotency-keyed on
the inbox id). The `webhook.process` handler (L2's ONE `job-handlers.ts` key) is durable-acknowledgement ONLY: it marks
the row `PROCESSED` (or `DISCARDED` when verification FAILED — "a failed verification is never processed"), does NO tenant
mutation and NO external call. **(4) Ops console gate = `reports:operational`.** The read/requeue contracts
(`restaurant-jobs.ts` router: queue browse, execution history, dead-letter list, outbox status, inbox browse metadata-
only, + a requeue-dead command that creates a NEW job and RETAINS the dead row as audit) gate on the existing
`reports:operational` capability, newly declared as a typed ABAC `Action` in `abac/policies.ts` (the M2 `staff:manage`
coordinated-addition precedent — the capability already lives in the vertical-catalog general-manager / financial-
controller / sop-compliance-auditor role templates) and mapped to the `restaurant-sop` module in `module-catalog.ts`.
· Conservative because the privileged-read + per-org-RLS-write split is exactly D13 §5; reusing the L1 scheduler + M4
outbox planners keeps ONE retry policy per queue; host-only tenant resolution keeps the strong M1–M6 isolation on an
unauthenticated ingress; and gating on an EXISTING capability + module avoids inventing commercial surface. · Revisited
by D13/D21 closing (dedicated queue tech, real signature verification + provider adapters, external-delivery lease) and
by the shared-file merge as L3/L4/L5 append their own `job-handlers.ts` / `outbox` / `policies.ts` keys after L2.
**SOP authoring — templates/versioning/recurrence(DST)/occurrence-generation (M7-L3)** · L3 realises the L1 SOP
seam for AUTHORING (execution/late-missed/escalation remain the L4 flow lane). Files: `sop-templates.ts`
(family/version/step lifecycle + branch assignments), `sop-recurrence.ts` (pure engine), `sop-occurrence-generation.ts`
(scheduler handler), `restaurant-sop.ts` (`sop:manage` console). Decisions this lane commits to:
**(1) Publish immutability is SERVER-GUARDED, not RLS-enforced.** The SOP tables carry ordinary tenant-isolation
policies (UPDATE is technically permitted to the app role), so every step mutation and every publish/retire
transition asserts the target version's `status` first (`assertDraft`); editing a published SOP opens a NEW draft
version with its steps cloned forward. At most ONE `PUBLISHED` version per family (publishing auto-retires the prior)
so "latest published" is unambiguous for occurrence pinning; at most ONE open `DRAFT`; publish requires ≥1 step.
`sop.templates.max` counts ACTIVE families and is re-checked on reactivation (archiving cannot sidestep the cap).
**(2) Recurrence/DST is a pure `Intl`-based engine — NO RRULE, no system-tz dependence.** Wall-clock is projected to
UTC through the branch IANA timezone; DST policy: spring-forward gap → NEXT VALID instant (the transition boundary,
found by an offset binary search); fall-back ambiguity → FIRST (earlier) instant. Proven with exact UTC instants
across America/New_York + Europe/Berlin in both directions (`sop-recurrence.test.ts`). WEEKLY interval aligns on the
Sunday of `startDate`'s week; MONTHLY `monthDay` clamps to the month's last day; `windowEndsAt = dueAt + windowMinutes`.
**(3) Occurrence generation is a WINDOW-IDEMPOTENT scheduler handler** (`sop.generateOccurrences`, one key in
`job-handlers.ts`). It pins `templateVersionId` to the latest PUBLISHED at generation time, seeds the per-occurrence
step checklist from that pinned version, and resolves each branch's current business date in ITS OWN timezone
(`business-date.ts`). Re-running creates ZERO duplicates: `unique(assignmentId, businessDate)` is the guarantee, a
pre-filter skips already-materialised dates, and a concurrent unique violation (P2002) is swallowed as a skip
(at-least-once, D13). §4 defaults: `GENERATION_LOOKBACK_DAYS=1` (a briefly-missed run can still be swept
LATE/MISSED), `GENERATION_HORIZON_DAYS=1` (console preview of the immediate schedule); both bounded + payload-overridable.
· Coordinated shared-file edits beyond the named lane files (all additive, supervisor-dedupable at merge): `_app.ts`
(`restaurantSop` router), `module-catalog.ts` (`restaurantSop → restaurant-sop`), `abac/policies.ts` (`sop:manage`,
org-role-driven `[]` policy — the capability itself pre-exists in the untouched `vertical-catalog.ts`). · Revisited by
the L4 flow lane (execution/evidence-completeness/late-missed sweep/escalation firing consume these occurrences and
the pinned version) and by the §11.5 SOP decisions closing.

---

## M5-L8 — Independent verification rollup (Verification Engineer, WHA-63)

**Base verified:** milestone execution tip `da0b383` = `restaurant/m5-money` (`44dba32`) + 3 supervisor-merged
follow-ups (WHA-64 zero-total comp settle `247c742`; register terminal-state handling `e304720`; battery
formatting `da0b383`). Worktree clean; L8 modified no `src/**` or `tests/**` — this doc is the only write.

**0-skip suite recipe (plan §7, confirmed):** fresh disposable DB **owned by** an unprivileged
`NOSUPERUSER NOBYPASSRLS CREATEROLE` role (`devfathom_test`); `prisma migrate deploy` run AS that owner so
forced RLS binds it AND the m2/m3/m4-rls batteries can `CREATE ROLE`/`GRANT` self-made sub-roles;
`TEST_DATABASE_URL` = that role → every DB battery runs, **0 skipped**. Exception: `test:rls`
(`verify-tenant-isolation.ts`) needs a **privileged** URL — it seeds cross-tenant rows with unqualified
inserts, then `SET LOCAL ROLE`s to a self-made NOLOGIN role for the isolation probes.

**Per-AC verdicts (plan §6):**

- **AC1 — FAIL.** Full suite at the tip (fresh unprivileged DB) = **2 failed | 1748 passed | 0 skipped**.
  Failure #1 = sanctioned `src/lib/tenancy/explicit-host.test.ts` (baseline). Failure #2 = **NEW**:
  `tests/restaurant-m4-acceptance.test.ts` ("WHA-49 … opens, adds, fires, prepares, serves, closes …") — the
  ledger no longer ends in `order.closed`; it stops at `order.payment_pending`. Root cause is the sole declared
  cross-milestone edit, the **M5-L2 settlement guard** in `src/lib/restaurant/orders.ts` (the C12 note above):
  a just-served order with no bills is not settled, so `closeOrder` PARKS it at PAYMENT_PENDING and returns
  success without emitting `order.closed`. The M4 acceptance test is byte-identical to `f3b8e8a` (where it was
  green) — it was not reconciled to the new settle-then-close flow. This is a **test-fixup**, not a functional
  bug (behavior is intended + documented); it routes back through the CoS to the owning lane. VE does not edit it.
- **AC2 — PASS.** M5 migration applies cleanly on a fresh DB at `f3b8e8a`; all 12 M5 tables have
  `relrowsecurity=t AND relforcerowsecurity=t`; `restaurant-m5-rls.test.ts` + `test:rls` verifier green;
  `tests/restaurant-m3-governance.test.ts` allowlist holds exactly the 12 shipped M5 tables; `migrate diff`
  shows no `restaurant_` drift (only pre-existing platform-table raw-SQL/RLS noise on `users`/`webhooks`).
- **AC3 — PASS.** The 6 append-only ledgers (`restaurant_tenders`, `_payment_events`, `_refunds`,
  `_drawer_movements`, `_daily_closes`, `_daily_close_tender_totals`) carry SELECT+INSERT policies ONLY;
  UPDATE/DELETE denied even to the OWNER (verifier + m5-rls battery + direct `pg_policies` inspection).
- **AC4 — PASS.** FRACTIONAL adversarial ÷3/÷7 exact by Decimal string-equality + deterministic cents
  (`restaurant-m5-acceptance`); BY_ITEM complete-partition rejects gaps/dupes/unknowns (`bills.test.ts`);
  BY_SEAT grouping + order-total reconciliation (`bills.test.ts`).
- **AC5 — PASS (nit).** Comp keeps snapshot price, nets to zero via `compAmount`, `compTotal ≡ Σ comps`,
  requires reason + co-auth (positive: `bills.test.ts`; route co-auth denial: `terminal-checkout.db.test.ts`).
  Nit: no explicit comp-missing-reason negative (refund path has `REASON_REQUIRED`; route co-auth negatives exist).
- **AC6 — PASS.** `tipTotal` and `serviceChargeTotal` reported separately on the close; tips never leak into
  service-charge totals (seeded flow); `tipAmount` on tenders/payments/refund-tip, never on bills.
- **AC7 — PASS.** MOCK conformance for all six capabilities incl. AUTH→CAPTURE, ADJUST, prior-ref requirement,
  scripted declines (`payment-adapter.test.ts`); declined SALE leaves NO tender/movement/payment/receipt
  (`tenders.test.ts`); no PAN/CVV/track column (information_schema probe) or logged card data.
- **AC8 — PASS.** Σ(refunds) capped at the original tender (`REFUND_EXCEEDS_TENDER`); one CASH_REFUND movement
  per cash refund; D2 refund of a D1 tender lands on D2 while the D1 close re-reads byte-identical.
- **AC9 — PASS.** `expectedCash ≡` signed movement-ledger fold; at most one OPEN session per register under a
  concurrent race; close records counted cash + variance; session ties register×operator×business-date.
- **AC10 — PASS (nit).** Cut blocked while any drawer OPEN or any bill unsettled; every total ≡ independent
  recompute from raw rows; correction = new row with `supersedesCloseId` + reason + manager co-auth; chain tip
  authoritative; superseded rows byte-identical. Nit: the platform audit-event ROW for a correction is written
  at the REST edge but not asserted directly (the co-authorization record is asserted as durable evidence).
- **AC11 — PASS.** Settled bills get unique, strictly-monotonic receipts from
  `restaurant_receipt_number_sequences`; concurrent settlements produce no duplicates; order-number sequences
  untouched (separate seam asserted).
- **AC12 — PASS.** Replaying a checkout/cash mutation with the same device key returns the original and creates
  nothing (tender/day-close/refund/drawer-open replays); a REVOKED device is rejected on every money route.
- **AC13 — PASS (note).** Read-contract audit: both consoles (L7a POS, L7b money) consume only server-lane
  reads, zero direct DB access. Money-discipline: no `parseFloat`/`Number(` arithmetic/`toBeCloseTo` on money
  paths (the only `Number(`/`parseInt` hits are integer counts — covers/weights/quantity/seat). `typecheck`,
  `lint`, `build` all green. Note: `format:check` reports 39 pre-existing dirty files — ALL disjoint from the
  M5 change set (byte-identical to `f3b8e8a`, spanning unrelated subsystems), i.e. environmental/baseline drift;
  **zero M5-authored files are format-dirty.** Studio visual-QA matrix (§12.7) is an L7a/L7b lane deliverable,
  not independently re-run by VE.

**Consolidated verdict (first pass): FAIL** on exactly one criterion (AC1) — a single NEW, precisely-scoped
test failure whose fix is a test-only reconciliation of `tests/restaurant-m4-acceptance.test.ts` to the
documented M5-L2 settle-then-close flow. AC2–AC13 all PASS. Correction routes through the CoS to the owning
lane; one VE recheck follows the correction pass.

### Recheck after the correction pass (WHA-65, tip `9d62f6a`)

**Correction landed:** child issue **WHA-65** reconciled the sole failing test — `tests/restaurant-m4-acceptance.test.ts`
@ `9d62f6a` — with a **test-only** change (no `src/**`, no schema, no `orders.ts`; delta from `da0b383` is
exactly this file + this doc). The fix is a genuine reconciliation, not a weakening: between `markServed` and
the terminal close it now SETTLES the served order through the real checkout routes (cut a `{ kind: NONE }`
bill via `POST /checkout/bill`, then `POST /checkout/tender` a CARD tender to full coverage), granting
`operatorA` `payments:collect` via a real `User` + `OrganizationRole` link (the money routes gate on it; the
M4 order routes do not). The `expectLedger` assertion is PRESERVED and STRENGTHENED — it still asserts the
full chain ending `… order.payment_pending → order.closed` (the money commands append no order events, so the
single close still walks `SERVED → PAYMENT_PENDING → CLOSED` in one shot), matching the intended/documented
M5-L2 guard (C12 note above). VE modified no `src/**` or `tests/**` — this doc is the only write.

**Fresh evidence (re-reproduced at `9d62f6a`, same 0-skip recipe):**

- **Full suite** (fresh unprivileged `devfathom_test`-owned DB, `TEST_DATABASE_URL` = that role) =
  **1 failed | 1749 passed | 0 skipped** (138 files: 137 passed, 1 failed). The single failure is the
  sanctioned baseline `src/lib/tenancy/explicit-host.test.ts`; the previously-NEW `restaurant-m4-acceptance`
  failure is resolved (1748 → 1749 passed, 2 → 1 failed). **Zero NEW failures vs baseline `1|1534|0`.**
- **RLS:** all 12 M5 tables `relrowsecurity=t AND relforcerowsecurity=t` (pg_class); `test:rls`
  (`verify-tenant-isolation.ts`, privileged seed URL) GREEN — explicitly confirms restaurant-money
  bill/line/payment/event/tender/refund/drawer/close/receipt-sequence isolation **+ DB-enforced append-only
  ledgers (UPDATE/DELETE denied even to the owner)**; the 6 append-only ledgers carry SELECT+INSERT policies
  ONLY (pg_policies).
- **Migration/governance:** `migrate diff` shows no `restaurant_` drift; `tests/restaurant-m3-governance.test.ts`
  `M5_TABLES` allowlist = exactly the 12 shipped tables.
- **Money discipline / PCI:** no `toBeCloseTo` on any money path (the only matches are comments asserting its
  absence); no float money arithmetic (`Number(`/`.toNumber()` hits are integer-cent, business-date, or
  version-count, never money values — money math is `Prisma.Decimal` via `money.ts`); information_schema probe
  finds NO PAN/CVV/CVC/track/card-number/expiry column on any `restaurant_%` table.
- **Read contract:** neither console tree (`src/components/restaurant/pos/**` + `(terminal)/pos`, L7a;
  `src/components/restaurant/money/**`, L7b) issues any direct `prisma`/`withTenantDb`/`@/lib/db` query — they
  consume only their named server-lane reads.
- **Code quality:** `typecheck` exit 0, `lint` exit 0, `build` exit 0. (`format:check` note unchanged: the
  pre-existing dirty files are disjoint from the M5 change set — environmental drift, zero M5-authored files
  format-dirty.)

**Per-AC after recheck:** **AC1 — PASS** (was FAIL); **AC2–AC13 — PASS** (unchanged — the correction delta
touches no `src/**`, schema, money path, governance allowlist, or read contract). AC5/AC10 carry the same
documented nits (both PASS).

**Final consolidated verdict: PASS.** All 13 acceptance criteria met at milestone tip `9d62f6a`; the single
remaining suite failure is the sanctioned explicit-host baseline. The correction pass (WHA-65) is complete and
independently re-verified. M5 rollup verification closed.

## M8-L1 accepted D08/D22 defaults

### D08 — customers, consent, privacy and loyalty

- Canonical customers are organization-scoped and independent of agency `Client`. EMAIL is trim+lowercase
  normalized; PHONE is stored in canonical international form supplied/validated at the boundary. A unique
  `(organization, kind, normalized value)` key is the local dedupe authority; no external identity/dedupe
  provider.
- Tags are the segment seam only. No dynamic segment rule engine in M8.
- Consent is channel-level, append-only, timestamped, actor-attributed, source-attributed, and
  policy-versioned. Current consent is the latest event; missing consent means denied.
- Export returns one customer-scoped JSON bundle. Anonymization is explicit and idempotent: remove
  identifiers, clear profile PII/tag assignments, mark the canonical surrogate anonymized, deactivate
  loyalty, and retain de-identified financial/order/consent/loyalty history where legal or accounting
  retention applies. Audit payloads contain IDs/actions, never copied PII. No automatic retention purge until
  D08 receives jurisdiction-specific policy.
- One organization-wide loyalty program version is effective at an instant. Effective versions are immutable;
  changes create a new version. Earn rate is Decimal points-per-currency-unit; redemption value is Decimal
  currency-per-point; `expiryDays = null` means no expiry.
- Whole points only. Earn occurs exactly once per settled bill when its order closes, using the bill grand total
  after comps/loyalty discount and excluding tips, rounded down. Cancelled orders therefore earn zero.
- Redemption requires an OPEN bill, `loyalty:redeem`, sufficient positive derived balance, and a value no
  greater than the outstanding bill; it appends a negative ledger entry and changes bill `discountTotal` /
  `grandTotal` in the same transaction.
- Refunds append a REVERSAL against the original earned lot in the same M5 refund transaction, using the pinned
  program version and capping cumulative reversal to original earn. A reversal may make a previously spent
  account negative; further redemption is denied until the balance recovers. Expiry consumes remaining earn
  lots FIFO and is idempotent.
- Program configuration and manual adjustments require `restaurant:configure`; adjustments require actor and
  reason. `loyalty.activeCustomers.max` is enforced.

### D22 — insight rollups and restricted labour facts

- Reuse the M7 Postgres scheduler and job-handler registry. Daily-close cut/correction enqueues an idempotent
  `insights.rollupDay` job; a strict backfill command enqueues bounded 90-day chunks. No queue, warehouse, or
  streaming infrastructure.
- Daily rollups are deterministic upserts keyed `(organization, branch, businessDate)`; item-mix rows
  additionally key product. Rebuild replaces derived rows only.
- Gross/net sales, comps, refunds, voids, and drawer variance reconcile to the authoritative latest daily-close
  chain tip and independently to raw bills/refunds/drawer ledgers; covers/item mix derive from closed orders and
  non-voided item snapshots; loyalty liability derives from positive read-time ledger balances multiplied by
  the effective redemption value at cutoff. All money is Decimal.
- Standard operational/financial report responses never contain labour cost. An append-only imported daily
  labour-cost fact is the minimal source seam; its list/read/export contract requires `reports:financial` **and**
  `workforce:rates`. No rate calculation, payroll, time clock, tip payout, or workforce module is built.
- Branch scope fails closed: a user with an ACTIVE restaurant staff profile and `primaryBranchId` may read only
  that branch; cross-branch/consolidated access requires `restaurant:configure`. A report-capable user with
  neither proof is denied.
- `customers:read`, `loyalty:redeem`, `reports:financial`, `workforce:rates`, and `restaurant:configure` use the
  existing org-role custom-decision path with empty static policies, so absent grants deny by default.
  `vertical-catalog.ts` already contains the module/capability keys and remains untouched.

# Camera gateway assumptions (CAM-L1)

- A gateway is one registered, branch-bound device; individual cameras are sources behind it.
- V1 transport is HLS and storage is gateway-local. No cloud storage or second WebRTC stack is assumed.
- Preset values are editable starting hints, not verified hardware facts; ONVIF Profile S discovery is authoritative.
- Gateway health becomes stale after five one-minute heartbeat intervals. Audio and clip export default off.
- The app reaches the gateway over an owner-provided private network path; no inbound port-forward is requested.
