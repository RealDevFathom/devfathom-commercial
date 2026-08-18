# Restaurant vertical — Build Assumptions (`restaurant/v1`)

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
