# ADR-004: Authentication Identity Plane

Status: **Proposed**, 2026-08-03. Not implemented. No code depends on this document yet.

This is the record the identity-plane work will be built from. It supersedes decision **D1
("No global identity table")** of the proposed ADR-003, *Standard Shared-Host Login*, which
remains unmerged on the deferred `codex/shared-host-login` branch.

## Context

### What D1 decided, and why it is being reopened

ADR-003 D1 kept identity uniqueness tenant-local. `email` is unique per organization
(`20260728102000_tenant_user_email`), a person who belongs to two organizations has two `User`
rows with two independent password hashes, and shared-host login therefore verified a submitted
password against **each candidate row in turn**.

That is not a detail of the implementation; it is forced by D1. With no global identity there is
no single credential to check, so the server must perform N password comparisons before it can
say whether anyone was authenticated.

Independent review of the shared-host login found two production blockers, and the first is a
direct consequence:

1. **Workspace-count disclosure through login timing.** The comparisons are sequential bcrypt
   verifications at roughly **80 ms each, measured**. Response latency is therefore
   approximately linear in the number of workspaces the submitted address belongs to. An
   unauthenticated caller who knows only an email address learns how many organizations it
   belongs to. That is precisely the account-enumeration property D1's own decision 3 set out to
   prevent — the dummy-hash compare equalises *zero versus one* candidate, but nothing equalises
   *one versus five*.
2. **Rate limiting on a spoofable key.** The limiter is in-process (per server instance) and
   keyed on the first `x-forwarded-for` entry, which any client can set. This is not caused by
   D1 and is being fixed separately in PR C; it is recorded here because it removes the
   mitigation one would otherwise reach for.

Constant-time mitigations for (1) were considered and are not adequate. Padding every login to a
fixed worst-case budget means either capping the candidate set — which silently locks people out
of their Nth workspace — or paying the worst case on every login for every user. Running the
comparisons concurrently narrows the signal but does not remove it, because total CPU still
scales with N. The disclosure is structural: it exists because authentication has to consult N
secrets. The fix is for authentication to consult **one**.

Shared-host login is therefore deferred until this ADR is accepted and implemented.
`findLoginCandidates`, `LOGIN_CANDIDATE_CAP`, `PendingLoginIntent.candidates` and most of
`shared-login.ts` are expected to be **deleted** rather than repaired.

### What D1 got right and must be preserved

D1 was correct that merging N `User` rows carrying different password hashes cannot be done
silently. Two rows for one address may legitimately hold different passwords set by different
people at different times, and one of them may be the only credential a person still remembers.
Any migration that picks a winner destroys a credential; any migration that keeps both
reintroduces the N-secret problem. This ADR does not resolve that by fiat — see
*Prerequisite: collision report*.

## Decision

### 1. A global `AuthenticationIdentity`, separate from tenant `User`

Introduce a global, cross-tenant record of **who a person is to the authentication system**:

- `AuthenticationIdentity` — one row per human. Holds the canonical `lower(email)`, the single
  password hash (nullable — SSO-only identities have none), MFA enrolment, and identity-wide
  session state. Globally unique on `lower(email)`.
- `OrganizationMembership` — one row per (identity, organization). Holds the tenant-facing
  membership: role, status, and the link to the tenant `User` row that carries department,
  title, profile and every other business attribute.

`User` remains the tenant-scoped record under tenant RLS and keeps its organization scoping.
What moves out of it is only the *credential*: the password hash, and the claim to an email
address. Authentication becomes one lookup and **one** password comparison whose cost is
independent of how many organizations the address belongs to, which closes the timing channel by
construction rather than by padding.

### 2. The identity table is a new shared security boundary, outside tenant RLS

This is the significant cost of the decision and must be stated plainly rather than discovered
later.

ADR-001 established forced row-level security with `app.current_organization_id` as the single
mechanism that keeps tenants apart. `AuthenticationIdentity` **cannot** be protected that way: it
is consulted precisely when the organization is not yet known, so there is no tenant id to
compare against. It is the second such table after the control plane (ADR-002), and unlike the
control plane it is reachable, indirectly, by unauthenticated traffic.

Compensating controls, all of which are part of the implementation and none of which are
optional. The first four are structural and hold even when application code is wrong; the rest
assume application code and exist for when it is wrong anyway.

- **A dedicated schema and database role.** The identity plane lives in its own schema
  (`identity`), owned by a role that is not the application role. The application's ordinary
  connection holds no rights there, so a query that has no business reading credentials cannot
  reach them even by accident.
- **No access through generic repositories.** No Prisma model exposed to shared repository
  helpers, no inclusion in generic `findMany`/`count` utilities, and no relation traversal from
  `User`. The only way in is a named function in the authentication module, so reviewing "what
  can read credentials" means reviewing one file.
- **No access through `withPlatformDb`.** The control-plane escape hatch is already the widest
  scope in the product; widening it to cover credentials would put every platform-admin path one
  mistake away from a credential dump. The identity plane gets its own narrow scope
  (`withIdentityDb`), used only by authentication. `scripts/verify-tenant-isolation.ts` gains
  cases asserting both that a tenant scope cannot read `AuthenticationIdentity` and that
  `withPlatformDb` cannot either, so the boundary is checked by the same gate as every other
  isolation property.
- **Direct table access is revoked.** `REVOKE ALL` on the identity tables, with access granted
  only to `SECURITY DEFINER` functions that take one identifier and return one fixed, minimal
  result. There is no ambient `SELECT *` over the identity tables for any application role.
- **Narrow, column-explicit authentication queries.** Every query names its columns, is bounded
  by a hard row cap, and is predicated on a single normalized address or a single identity id.
  No `select: *`, no dynamic `where`, no caller-supplied filters. Nothing outside the
  authentication path may select the password hash, and no query returns the set of
  organizations an identity belongs to before authentication succeeds.
- **Envelope-encrypted MFA secrets.** TOTP secrets stop being stored as plaintext base32, as
  `users.twoFactorSecret` is today. A per-identity data key is encrypted under a root key held
  in a key-management service, and the row stores the ciphertext and the wrapped key. A database
  dump alone then yields no working second factor, and rotating the root key does not mean
  re-encrypting every row.
- **A separate identity audit ledger.** Credential changes, MFA enrolment and reset, grant issue
  and revocation, session-version bumps, and every read of a credential column are appended to a
  ledger that is neither the tenant `AuditLog` nor `PlatformAuditLog`. Neither existing ledger
  can hold these: one is tenant-scoped for events that span tenants, and the other is readable
  by every platform operator role.
- **Bulk access raises an alert.** Identity reads are counted per actor per window. The normal
  shape of this traffic is one row per authentication attempt, so a caller reading many
  identities in a short window is either a feature nobody reviewed or an incident in progress.
  It alerts either way, at a threshold low enough to fire before the second case finishes.
- **No tenant business data.** The table holds credentials and identity-wide session state only.
  Anything an organization owns stays in `User` under RLS.
- **Enumeration parity.** Every unauthenticated outcome — unknown address, wrong password, no
  eligible membership — returns one identical body in one indistinguishable time.

### 3. Dual session versions: identity-wide and membership-scoped

Revocation has two natural scopes and one counter cannot express both.

- `AuthenticationIdentity.sessionVersion` — **identity-wide**. Bumped by a password change, an
  MFA change, or "sign out everywhere". Invalidates every session in every organization.
- `OrganizationMembership.sessionVersion` — **membership-scoped**. Bumped by a role change, a
  status change, removal from the organization, or an administrator ending that person's access
  to that workspace. Invalidates only sessions acting in that organization, and must not sign a
  person out of unrelated workspaces.

A session carries a snapshot of both. Revalidation compares both, and a mismatch in either
invalidates. This extends the mechanism PR A introduces — `sessionRevoked` /
`sessionInvalidReason` as claims distinct from account `status`, evaluated by one shared verdict
function — from one counter to two, and PR A's `session-state.ts` is the intended home for the
combined rule. PR A deliberately does not pre-build it.

### 4. `ExternalIdentityBinding` is membership-scoped, and sessions carry a scope

An external identity binding — an OIDC or SAML issuer plus subject — belongs to a
**(identity, organization)** pair, never to an identity globally. Two organizations may federate
the same person from different IdPs, and one organization's IdP must never be able to assert
anything about another organization's membership. The binding is on the issuer's **immutable
subject**, not on an email address.

Every session therefore carries an explicit scope:

- **`GLOBAL`** — established by an identity-wide credential (password, plus MFA where enrolled).
  The holder proved possession of the identity itself.
- **`MEMBERSHIP`** — established by an organization-scoped authentication, i.e. SSO through one
  organization's IdP. The holder proved only that *that* organization's IdP vouches for them.

A `MEMBERSHIP` session is authoritative for exactly one organization. It is never silently
widened, and it can never be treated as evidence about any other membership.

### 5. The authentication grant model

A membership records **how** its holder is permitted to enter that organization. A grant is
explicit, per membership, and never inferred.

- **A `GLOBAL` session may enter only those memberships explicitly granted `PASSWORD`.** Holding
  the identity credential is not, by itself, authority over every organization the identity
  happens to belong to.
- **Accepting organization B's invitation grants `PASSWORD` for organization B only.** It does
  not grant password access to organization A, and it does not retroactively change how A may be
  entered. This is the rule that makes a global credential safe: joining a new workspace can
  never escalate access to an existing one.
- **SSO / JIT provisioning creates an `SSO` grant for its exact membership and its exact
  issuer/subject binding, and nothing else.** A JIT-provisioned membership is entered by that
  IdP. It does not gain a password grant, and it does not confer one anywhere else.
- **SCIM provisions a membership; it does not imply SSO enforcement.** Directory-driven
  provisioning answers "does this person have a membership", which is a separate question from
  "how may this person authenticate". Conflating them would let a directory sync silently change
  an organization's authentication policy.
- **`SSO_ENFORCED` remains an explicit organization policy, and it rejects password grants.**
  When an organization enforces SSO, a `GLOBAL` password session may not enter it regardless of
  any grant that predates the policy. The policy is the outer gate; the grant is the inner one,
  and both must permit entry.

### 6. The organization switcher is grant-aware

The switcher shows what a person has, and is honest about what each option costs:

- A `GLOBAL` session may switch directly into any membership granted `PASSWORD` and not covered
  by `SSO_ENFORCED`.
- A membership requiring SSO, or not granted `PASSWORD`, is **offered** rather than hidden, and
  selecting it starts a reauthentication through that organization's IdP with an explanation of
  why reauthentication is required.
- A `MEMBERSHIP`-scoped session offers other organizations only as reauthentication, and says
  why: it proved one organization's IdP, which is not evidence about any other.

**The switcher must never silently hop between organizations, and must never upgrade a
`MEMBERSHIP` session to `GLOBAL` scope.** A scope upgrade requires presenting the identity
credential. Anything else would let one organization's IdP mint authority over another's data —
the exact substitution risk the SSO threat model exists to prevent.

Hiding memberships instead of offering them was rejected: it produces a workspace a person knows
they belong to and cannot reach, with no stated reason, and it does not improve secrecy — the
holder has already authenticated as this identity.

### 7. Removing administrator-set passwords is an intentional breaking capability change

Today an administrator can set another person's password directly. Under a global identity that
capability would let an administrator of **one** organization overwrite a credential that opens
**every** organization the identity belongs to. It is therefore removed, not migrated.

This is a **deliberate reduction in capability and a breaking change**, recorded as such rather
than presented as a refactor. The replacement path is the administrator triggering a reset that
the identity holder completes — the flow PR B restores to working order. Operational runbooks,
the identity-and-access handbook, and any support procedure that depends on setting a password on
someone's behalf must be updated before this ships. Support access to a tenant continues to use
time-boxed, reasoned, audited support sessions (ADR-002), which are unaffected.

### 8. Prerequisite: a global `lower(email)` collision report before any migration is designed

No migration may be designed, and this ADR may not move beyond Proposed, until a global
`lower(email)` collision report has been run against production and staging.

`scripts/report-global-email-collisions.ts`, added alongside this ADR, is that report. It is
strictly read-only — one `READ ONLY` transaction, SELECT statements only, `ROLLBACK` at the end —
and it reports, per duplicate `lower(btrim(email))` group:

- how many organizations the address spans, and how many accounts exist;
- which account statuses those accounts hold;
- how many are SSO-managed or SCIM-managed;
- how many have MFA enabled;
- whether the group exceeds the ten-candidate discovery cap;
- whether the group is demo/seed data or a real customer population.

Each of those changes the migration, which is why the report comes first. Two `ACTIVE` accounts
holding different password hashes is a merge decision a human must make; one `ACTIVE` and one
`INVITED` is not. SSO- and SCIM-managed accounts have no password to reconcile and can be
attached mechanically. MFA-enabled accounts are the ones where a wrong merge locks a real person
out of a real workspace. A group above ten already exceeds what shared-host discovery would
process, so it needs an answer in the migration rather than at login. Demo and seed rows are
noise, and counting them as customer impact would size the change wrongly in both directions.

`lower(btrim(email))` is the right key because `20260802120000_user_email_lowercase` already
normalized stored addresses, so the report and any future unique index agree on one canonical
form. The cross-organization read requires the control-plane escape hatch, since `users` is
`FORCE ROW LEVEL SECURITY`; the script sets `app.is_platform_admin` transaction-locally and
Postgres discards it at `ROLLBACK`.

The migration strategy depends entirely on the distribution the report finds. A long tail of
identical-hash duplicates merges mechanically; a population of different-hash collisions requires
a per-person reset or an explicit claim flow, and that changes the delivery plan, the
communication plan, and the rollback plan. Designing the schema before the data is known would be
guessing.

**The report's output is customer data.** It is never committed, never attached to a pull
request, and never pasted into an issue — not even masked, which is why the script masks by
default and requires `--reveal`. Counts and classifications are what travel; rows do not.

`scripts/report-email-collisions.ts` remains the per-organization companion to the email
normalization migration and answers a different question — case collisions *within* one
organization, against a tenant-local unique index. It is not a substitute for this report.

## Consequences

Benefits:

- authentication consults exactly one secret, so login cost and timing are independent of how
  many organizations an address belongs to, closing the disclosure structurally;
- revocation gains the two scopes it always needed, so removing someone from one workspace stops
  signing them out of unrelated ones;
- "how may this person enter this organization" becomes an explicit, auditable grant rather than
  an emergent property of which rows happen to exist;
- SSO, SCIM and password access stop being conflated, so a directory sync cannot change an
  authentication policy;
- one credential per person, which is what people already expect.

Costs:

- a second table outside tenant RLS, reachable indirectly by unauthenticated traffic, requiring
  every compensating control in decision 2;
- a data migration over live credentials whose shape is not yet known;
- a removed administrator capability, with runbook and support-process changes;
- more session state and a more complex revalidation path;
- a switcher that must explain scope to users, which is a real design problem, not only an
  engineering one.

## Rejected alternatives

- **Keep D1 and pad login to constant time.** Requires either capping candidates — silently
  locking people out of a workspace — or paying the worst case on every login. Narrows the signal
  without removing it, because total CPU still scales with the candidate count.
- **Keep D1 and compare candidates concurrently.** Same objection: wall-clock improves, aggregate
  cost still scales, and the channel survives under load.
- **A global identity with implicit access to every membership.** Removes the timing channel but
  makes joining any workspace a potential escalation into every other one. Decision 5 exists
  precisely to prevent this.
- **Identity-wide `ExternalIdentityBinding`.** Would let one organization's IdP assert an
  identity used to enter another organization.
- **A single session version.** Cannot distinguish "this person's credential changed" from "this
  person's role in one workspace changed"; either over-revokes across unrelated workspaces or
  under-revokes within one.
- **Migrating administrator-set passwords forward.** Lets an administrator of one organization
  overwrite a credential that opens all of them.

## Evidence

Prior decisions: `docs/admin-platform/adr/001-tenant-rls.md` (forced tenant RLS),
`docs/admin-platform/adr/002-control-plane-separation.md` (the first table outside tenant RLS),
and proposed ADR-003 D1 on the deferred `codex/shared-host-login` branch.

Current implementation this replaces or builds on: `src/lib/auth.ts`,
`src/lib/auth/session-state.ts` (introduced by PR A, the intended home for the combined
revalidation rule), `src/lib/auth/shared-login.ts` and `src/lib/auth/login-candidates.ts` (both
expected to be deleted), `src/lib/sso.ts`, the SCIM routes under `src/app/api/scim/`, and
`prisma/migrations/20260728102000_tenant_user_email`.

Sequencing: PR A (session revocation) and PR B (anonymous auth transport) are independent of this
ADR and merge first. An Azure-only cleanup and PR C (auth hardening — distributed rate limiting,
trusted-proxy address extraction) follow. PR D implements this ADR together with shared-host
login, and may not begin until the collision report of decision 8 has been run.
