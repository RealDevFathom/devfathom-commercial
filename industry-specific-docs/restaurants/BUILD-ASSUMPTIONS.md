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
