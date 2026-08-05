# MEET-001: Meetings Threat Model

Status: **Proposed**, 2026-08-03. Documentation only.

Markings — **CODE-VERIFIED**, **RESEARCH-RECOMMENDATION**, **DECISION** — are defined in
`000-product-scope.md`. Every current-behaviour claim cites a file and line range read at commit
`417ff97` (`origin/main`).

## Scope of this model

The join surface is the first part of DevFathom that is **reachable without a session, on a shared
host, by anyone who holds a string**. That combination does not exist anywhere else in the product
today: the only session-less tRPC procedures are an exact five-item allowlist for invitation and
password-reset recovery (`src/lib/auth/anonymous-access.ts:27-44`), and every meeting route that
exists today sits behind the authenticated `(app)` group and object-level authorization
(`src/lib/authz.ts:146-162`).

The model covers: the public link, the guest credential and the guest/identity boundary, cross-tenant
access, webhook trust, entitlement interaction, deployment/host confusion, and the operational
exposure of a self-hosted media node.

## Assets

| Asset                   | Why it matters                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live media              | Real-time audio, video, and screen content. Disclosure is unrecoverable — there is no revoking what was heard.                                                                                                                             |
| Join tokens             | The provider credential that admits a browser to a room.                                                                                                                                                                                   |
| Guest credentials       | The secret behind an occurrence-scoped access grant.                                                                                                                                                                                       |
| Attendance evidence     | `MeetingAttendanceLog` rows (`prisma/schema.prisma:1471-1492`) are used for reporting (`src/server/routers/meetings.ts:517-551`) and feed team statistics (`src/server/routers/team-stats.ts:84`, `:309`). They are a record about people. |
| Tenant identity mapping | "Which organization owns this occurrence" — resolved before any session exists.                                                                                                                                                            |
| Media infrastructure    | The SFU and TURN hosts, their configuration, and their credentials.                                                                                                                                                                        |

## Trust boundaries

1. **Unauthenticated internet → public join route.** No session, shared host, attacker-controlled
   `Host` header. Nothing may be trusted here.
2. **Guest → tenant.** A guest is inside one occurrence and outside everything else.
3. **Provider (LiveKit) → application.** Webhooks arrive over the internet and claim to be the
   provider.
4. **Application → provider.** The application holds an API key that can create rooms and mint
   tokens for any room.
5. **Operator → media host.** SSH, configuration, restart.

---

## Threats

### T1 — The public link is treated as authorization

**Threat.** A link is forwarded, posted in a shared channel, indexed, or leaked in a screenshot, and
whoever holds it is admitted to the call.

**DECISION.** The public ID is a **locator only**. Holding it grants nothing. Resolution of a public
ID returns an organization id and, in tenant scope, an occurrence — never a token, never media
access, never participant names. Admission is a separate act requiring either a session with meeting
access, or a valid unexpired unrevoked guest credential.

**Why this needs saying:** the current call path derives the room name from the meeting id —
`meeting-${input.meetingId}` (`src/server/routers/meetings.ts:369`) — so anyone who learns a meeting
id learns the room name. Under the new model the provider room name is separately random per
occurrence (MEET-004, MEET-002), so a public link discloses no provider-side identifier at all.

**Residual risk.** A locator still discloses that _an occurrence exists_. Accepted: the join page
reveals nothing beyond that until a credential is presented.

### T2 — Guest secret handling

**Threat.** The guest credential is logged, mailed in plaintext, embedded in a calendar invite,
persisted to `localStorage`, kept in browser history via the URL, or stored in a form a database dump
would expose.

**DECISION.**

- The guest credential is stored **hashed**, never in plaintext, on the occurrence-scoped grant.
  The existing invitation and password-reset tokens set this precedent: they are stored as
  `tokenHash` and looked up by hash only (`src/lib/auth/anonymous-tenant.ts:30-43`).
- **Tokens never appear in URLs.** This is a stricter rule than the product currently follows —
  invitation and reset links carry their token in the path (`src/app/invite/[token]`,
  `src/app/reset-password/[token]`), which is acceptable for a single-use recovery link mailed to one
  address and unacceptable for a credential that admits someone to live media.
- **Tokens never appear in emails, calendar invites, or `.ics` attachments.** The existing meeting
  templates already take a `joinUrl` and render it as a button and as plain text
  (`src/lib/email/templates.ts:429`, `:448`, `:458`, `:480`, `:486`); that URL carries the **public
  ID only**.
- **Tokens never go to `localStorage` or `sessionStorage`.** Provider join tokens live in memory for
  the lifetime of the call surface and nowhere else.
- Guest credentials are never written to application logs. Log the grant id, never the secret.

**Residual risk.** A guest who is themselves careless — sharing their screen while the join page is
open, forwarding their own credential — cannot be defended against. Short TTL bounds the damage.

### T3 — The guest / identity boundary

**Threat.** A guest access path becomes a backdoor into the identity plane: a guest that
accidentally creates an account, reaches a workspace surface, appears in a member list, or can be
escalated by an authorization check that only asks "is there a session?".

**DECISION.** A guest is **never** an `AuthenticationIdentity` and **never** an
`OrganizationMembership`. It is an occurrence-scoped access grant carrying an opaque credential, an
expiry, a revocation state, and a meeting role. It cannot set a global password, cannot reach the
organization picker, and cannot reach any workspace surface. Converting a guest into a registered
user is a separate, explicit flow that starts from the ordinary invitation path.

This is deliberately compatible with **ADR-004** (`docs/admin-platform/adr/004-authentication-identity-plane.md`,
currently **Proposed** and unmerged on `origin/codex/adr-004-draft`). ADR-004 decision 5 establishes
that entry into an organization is an explicit per-membership _grant_, never inferred from the
existence of a credential. A guest grant is the same principle one level down: it authorizes exactly
one occurrence and is not evidence about anything else. ADR-004 decision 1 makes
`AuthenticationIdentity` the single global credential record; adding guests to it would re-open
exactly the property ADR-004 exists to close.

**CODE-VERIFIED enforcement seam that already helps:** the tRPC context refuses to build without an
organization id (`src/server/trpc.ts:44-46`), and every protected, admin, HR, and capability
procedure independently rejects a null session in its own middleware
(`src/server/trpc.ts:149-158`, `:176-199`). The anonymous transport builds context with an explicit
`session: null` (`src/app/api/trpc/[trpc]/route.ts:53-59`), so an allowlisted procedure is the only
thing that can run on that path. Guest procedures inherit that shape.

**Residual risk.** The allowlist is the whole defence. Adding a procedure to
`ANONYMOUS_PROCEDURES` (`src/lib/auth/anonymous-access.ts:41-44`) without review would widen it. The
allowlist is small and explicit precisely so this stays reviewable.

### T4 — Nothing credential-bearing spans a series

**Threat.** A guest credential is attached to the series, so one link works forever, across every
future occurrence, and revoking it for one occurrence revokes it for all — or, worse, revoking it for
one occurrence revokes nothing.

**DECISION.** **No credential-bearing field may exist on a series-level record.** Series-level
participant records hold invitee and contact metadata only — who is expected, what address to mail.
The credential hash, the expiry, the revocation state, and the meeting role live on the
**occurrence-scoped** record.

**CODE-VERIFIED that this is currently impossible to satisfy:** there is no occurrence table. A
recurring meeting is a single `Meeting` row whose occurrences are computed on read
(`src/lib/meeting-occurrence.ts:75-128`, `src/server/routers/meetings.ts:609-646`). The nearest
existing shape, `MeetingAttendee`, is unique on `(meetingId, userId)` —
**series-scoped** (`prisma/schema.prisma:1461`). Storing a credential there would produce precisely
the indefinitely-reusable link this decision forbids. Introducing an occurrence record is therefore a
hard prerequisite for guests, not an optimization.

Note also that the recurrence model has **no end date** (`prisma/schema.prisma:1435`) — the walkers
stop only at an iteration cap (`src/lib/meeting-occurrence.ts:41`, `:89`, `:150`;
`src/server/routers/meetings.ts:621`). A series-level credential on an unbounded series is a
permanent credential.

### T5 — A removed participant re-enters

**Threat.** A host removes someone from a call. That person still holds a valid join token and
rejoins.

**CODE-VERIFIED / RESEARCH-RECOMMENDATION.** Self-hosted LiveKit has **no Cloud-style token
revocation**. Removing a participant disconnects the _session_; it does not invalidate the _token_.
The token remains cryptographically valid until it expires. (This is a property of the self-hosted
deployment, recorded from the research report; it is why MEET-002 records
`tokenRevocation: "none"` in the capability map. It cannot be verified against this repository
because no LiveKit code exists here.)

**DECISION.** The mitigation is **short TTL plus refusal to reissue**, and this is stated plainly
because a future reader will look for a revocation switch and not find one:

- Join tokens are minted with a **short** time-to-live — minutes, sized to cover a join and a
  reconnect, not the length of the meeting. The current JaaS token's two-hour expiry
  (`src/server/routers/meetings.ts:372`) is the wrong shape for this and is not carried forward.
- Removal writes a **server-side removal record on the occurrence-scoped grant**, and the token
  endpoint refuses to mint again for that grant. Removal is durable state in our database, not a
  message to the provider.
- Removal also calls the provider's remove-participant operation to end the current session
  immediately (MEET-002).
- The exposure window is therefore bounded by the remaining TTL of the token already in the removed
  participant's browser, and closes with no further action.

**Residual risk, accepted and stated.** A removed participant can rejoin for up to the remaining
token lifetime. Shortening the TTL shrinks this window and increases token-refresh traffic; that
trade-off is the entire control. It is not a switch, and no amount of application logic makes it one.

### T6 — Webhook forgery

**Threat.** An attacker POSTs a fabricated `room_finished` or `participant_joined` to the webhook
endpoint and corrupts attendance, ends a call, or drives whatever logic the endpoint feeds.

**DECISION.** Every webhook is verified before it is parsed for meaning: signature checked against
the provider key, and the payload's own identifiers cross-checked against a room the application
actually created. An unverified body is discarded without side effects and without a distinguishing
error. MEET-003 specifies this.

**Residual risk.** The verification key is a shared secret. Its compromise is equivalent to the API
key's compromise (T14).

### T7 — Webhook replay

**Threat.** A captured, validly-signed webhook is replayed — to double-count attendance, to
resurrect an ended room's state, or simply to flood.

**DECISION.** Webhook processing is **idempotent by event identity**, and stale events are rejected
by timestamp. Replaying a processed event is a no-op, not a second write. MEET-003 specifies the key
and the window.

### T8 — Webhook **loss**

**Threat.** The subtler failure, and the one that actually happens: the webhook never arrives.
The application scaled to zero, the network dropped it, the process restarted mid-delivery, the
provider gave up after its retries. Attendance is then silently incomplete, and nothing reports an
error.

**CODE-VERIFIED that this is a live risk today:** the container app is configured
`scale: { minReplicas: 0, maxReplicas: 1 }` (`infra/environment.bicep:431`). At zero replicas there
is nothing listening. A webhook arriving during a cold window is delivered to nobody.

**DECISION.** Signed idempotent webhooks are the **primary near-real-time source and are not
infallible**. Periodic reconciliation and room-end reconciliation against the provider are
**mandatory**, not a nice-to-have. Durable attendance derives from **reconciled server-side events**.
Client-reported join and leave calls are **UX hints only, never authoritative**. ADR-005 decision 6
and MEET-003 carry this.

**CODE-VERIFIED that today's attendance is exactly the untrustworthy kind:** `logJoin` and `logLeave`
are client-invoked mutations (`src/server/routers/meetings.ts:402-473`, `:481-512`) fired from the
browser on Jitsi events, including a `keepalive: true` beacon on `pagehide`
(`src/components/meetings/meeting-call.tsx:102-114`, `:157-163`). A closed laptop, a killed tab, or a
network drop produces no `leftAt` at all. That is acceptable for a hint and unacceptable as evidence.

### T9 — Cross-tenant room access

**Threat.** A token minted for organization A's occurrence admits its holder to organization B's
room; or a public ID belonging to A is used to reach B's data.

**DECISION.**

- The provider room name is **separately random per occurrence** and never derived from any
  tenant-visible identifier, so room names cannot be guessed by enumerating meeting ids — which is
  possible today, since the room is `meeting-${meetingId}` (`src/server/routers/meetings.ts:369`).
- Public-ID resolution returns **only an organization id** from a narrow platform-scope lookup; the
  occurrence itself is then loaded **inside that tenant's RLS scope**. This is the shape already used
  for anonymous token flows: `organizationForAnonymousToken` returns nothing but an
  `organizationId` (`src/lib/auth/anonymous-tenant.ts:24-45`), and the transport then runs the
  procedure inside `withTenantDb(organization.id, …)`
  (`src/app/api/trpc/[trpc]/route.ts:44-64`).
- Every token mint re-derives the room from the occurrence loaded in tenant scope. The client never
  supplies a room name.

**CODE-VERIFIED backstop.** Tenant data is under forced row-level security keyed on
`app.current_organization_id`, and the platform escape hatch is a distinct, explicit scope
(`src/lib/tenancy/scoped-db.ts:107-124`) — ADR-001 and ADR-002. A tenant-scoped query cannot read
another tenant's occurrence even if the application logic is wrong.

### T10 — Enterprise-host vs public-ID mismatch

**Threat.** A public ID belonging to organization A is opened at `b.devfathom.com`. If the
application redirects to the correct host, it has just confirmed to B's visitor that the occurrence
belongs to A. If it serves the page anyway, it has served A's content on B's host.

**DECISION.** On a tenant host, the host's organization is **cross-checked** against the public ID's
organization. A mismatch is a **404 — never a redirect**, never a distinguishing error message. The
404 is identical to the one an unknown public ID produces.

This mirrors an existing pattern: `requireOrganizationForRequest` answers a session/host mismatch
with a distinct 409 (`src/lib/tenancy/host.ts:299-312`) because there the caller has already
authenticated. On the anonymous join path the caller has proved nothing, so the answer must
disclose nothing.

### T11 — Entitlement disabled mid-call

**Threat.** An operator disables the `meetings` module while a call is running. Either the call
drops mid-sentence, or — worse — the disable is treated as a reason to stop recording attendance and
evidence is destroyed.

**DECISION.** See ADR-005 decision 7 for the full semantics. For this model:

- **Webhook ingestion, reconciliation, and historical records are never gated.** Disabling a module
  is a commercial action; it must never discard evidence.
- An already-active occurrence may **finish**, including reconnection by already-admitted
  participants.
- Immediate termination is a **separate, explicit platform action** with its own audit trail — not a
  side effect of a billing change.

**CODE-VERIFIED constraint.** Module **selection** is namespace-based — the module key comes from the
first segment of the tRPC path (`src/lib/module-catalog.ts:36-38`) and the middleware rejects the
whole call (`src/server/trpc.ts:160-169`). **Enforcement is procedure-builder-scoped**: only
`protectedProcedure` (`src/server/trpc.ts:202-205`), `adminProcedure` (`:210-213`), `hrProcedure`
(`:216-219`) and `capabilityProcedure` (`:226`) compose `requireLicensedModule`; `publicProcedure` is
bare `t.procedure` (`:77`) and composes nothing. A `meetings.*` procedure built on `publicProcedure`
would not be gated — so this constraint does not read "not a `meetings.*` procedure".

What it does force is stronger: **ingestion is not a tRPC procedure at all.** The anonymous tRPC
transport admits an exact allowlist of five recovery procedures
(`src/lib/auth/anonymous-access.ts:27-44`, enforced at `:82-94`) and derives the tenant from a
`token` field in the parsed input (`:103-135`); a signed provider event names a room, not a token,
and its signature is over raw bytes that a body-parsing adapter has already consumed. Ingestion is
therefore a dedicated raw-body route handler and reconciliation a platform job — neither is reachable
by the entitlement middleware in the first place. Entitlements are also resolved once per request at
context construction (`src/server/trpc.ts:48`), so a mid-call disable takes effect on the _next_
request, not the current one.

### T12 — Forged deployment assignment

**Threat.** An attacker registers or influences a deployment URL so that a host they control
resolves to a tenant they do not own, and then reaches that tenant's occurrences.

**CODE-VERIFIED current state.** There are two resolvers, and they behave differently:

- `resolveOrganizationByHost` matches deployments by **substring** — `url: { contains: host }`
  (`src/lib/tenancy/host.ts:130-134`) — and falls back to `DEFAULT_ORGANIZATION_ID` for
  `localhost`, `127.0.0.1`, and every configured default host (`:136-145`).
- `resolveExplicitOrganizationByHost` is the hardened sibling: it restricts the host to the DNS
  character set before building any candidate (`src/lib/tenancy/host.ts:79`, `:224`), enumerates
  exact URL forms and re-checks matched rows in application code
  (`:58-67`, `:226-247`), **fails closed on ambiguity** by returning null and emitting a structured
  warning when two organizations claim one host (`:257-267`), and stops before the deployment lookup
  for shared and default hosts (`:207-213`).

**DECISION.** The join path uses a **narrow platform-scope lookup keyed on the public ID**, not host
resolution, to determine the organization (MEET-004). Host resolution on a tenant host is used only
for the **cross-check** in T10. Where the join path does classify a host, it uses the strict resolver
semantics, never the permissive one.

**Open risk.** `resolveOrganizationByHost` retains both the substring match and the default-tenant
fallback, and is the resolver used by `requireOrganizationForRequest`
(`src/lib/tenancy/host.ts:151-155`, `:299-312`) on the authenticated path. That is outside this
phase's scope but is recorded as an observation, not silently inherited.

### T13 — Reserved host labels

**The brief states that `meet` and `turn` are not yet in `RESERVED_HOST_LABELS`. This is out of
date.**

**CODE-VERIFIED.** `meet`, `meet-staging`, `turn`, and `turn-staging` are **already reserved**
(`src/lib/tenancy/host-routing.ts:7-17`, entries at `:13-16`), enforced against organization slugs at
`src/lib/platform/commands.ts:53-55` via `isReservedHostLabel`
(`src/lib/tenancy/host-routing.ts:19-21`). The reservation landed in `417ff97`,
_"fix: reserve meeting infrastructure hosts (#21)"_, which is the current `origin/main`.

**Residual risk.** Reservation blocks _new_ slugs. It does not retroactively remove an existing
organization whose slug is one of these labels, and it does not reserve the corresponding DNS names
at the registrar. Both are operational, not code, concerns.

### T14 — Media infrastructure exposure

**Threat.** The SFU host is a long-lived VM with a public address. Permanent SSH exposure, a stale
image, a leaked API key, or an unauthenticated admin port turns one host into full access to every
room on it.

**DECISION.**

- **No permanent SSH exposure.** Management access is closed by default and opened deliberately,
  time-boxed, and closed again. A permanently open port 22 on a media host is not acceptable, for
  the pilot or after it.
- The provider API key is a server-side secret, never shipped to a browser, never in
  `NEXT_PUBLIC_*`. Note that today's JaaS app id _is_ public by design
  (`.env.example:66`, read client-side at `src/components/meetings/meeting-call.tsx:10`) while the
  signing key is server-only (`src/server/routers/meetings.ts:346`). The self-hosted key is
  server-only in full.
- **RESEARCH-RECOMMENDATION, adopted:** a single room cannot be split across SFU nodes. Scaling out
  distributes _rooms_, not participants within a room. Therefore **losing one node kills every room
  on that node** — a blast radius that is a security-relevant availability property, not only a
  capacity one. ADR-005 decision 8.
- **RESEARCH-RECOMMENDATION, adopted:** UDP mux — one UDP port for media rather than a wide ephemeral
  range — because a narrow published surface is both easier to firewall and easier to reason about.

### T15 — Denial of service against the public join route

**Threat.** The join route is unauthenticated and does a database lookup. It is a free amplification
target.

**CODE-VERIFIED precedent to follow.** The anonymous tRPC transport throttles **before** any database
work, explicitly so that neither the platform-scope lookup nor the tenant transaction can be driven
by an unauthenticated flood (`src/app/api/trpc/[trpc]/route.ts:100-108`), and it bounds input
length before hashing a token (`src/lib/auth/anonymous-tenant.ts:29`).

**DECISION.** The join route adopts both: rate-limit before the lookup, and validate the public ID's
shape before touching the database. A malformed identifier costs a regular-expression test, not a
query.

**Residual risk.** The existing anonymous limiter is in-process and keyed on client address; ADR-004
records that a spoofable key and a per-instance limiter are being addressed separately. The join
route inherits whatever that work produces and should not build a third limiter.

### T16 — Attendance evidence integrity

**Threat.** A participant fabricates attendance, or an organization's attendance record is
retroactively altered.

**CODE-VERIFIED partial mitigation today.** Both attendance mutations refuse to stamp outside a
`[start − 5 min, end]` window and return a `skipped` reason instead
(`src/server/routers/meetings.ts:264-271`, `:426-428`), and inserts are race-safe via
`createMany` + `skipDuplicates` (`:276-281`, `:433-438`).

**DECISION.** Under the new model, attendance is derived from **reconciled provider events** (T8), so
the anti-backfill window stops being the primary control and becomes a secondary sanity check. The
authoritative question becomes "did the SFU see this participant in this room", which a client cannot
assert.

**Open risk.** Guest attendance has nowhere to go: `MeetingAttendanceLog` requires a `User` foreign
key (`prisma/schema.prisma:1475`, `:1485`). Either guests are absent from attendance, or the model
changes. Recorded as an open question below.

---

## Decisions summary

| ID  | Decision                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------- |
| T1  | The public ID is a locator, not authorization.                                                           |
| T2  | Guest credentials are hashed at rest and never appear in URLs, emails, calendar invites, or web storage. |
| T3  | A guest is never an identity and never a membership; conversion is a separate explicit flow.             |
| T4  | Nothing credential-bearing spans a series; credentials live on the occurrence-scoped record.             |
| T5  | Removal = short TTL + refusal to reissue + provider disconnect. There is no token revocation.            |
| T6  | Webhooks are verified before they are believed.                                                          |
| T7  | Webhook processing is idempotent by event identity, with a timestamp window.                             |
| T8  | Webhooks are primary but fallible; reconciliation is mandatory; client calls are hints only.             |
| T9  | Room names are separately random; tenant is resolved by a narrow platform lookup, then RLS.              |
| T10 | Host/ID mismatch is a 404, never a redirect.                                                             |
| T11 | Entitlement never gates ingestion, reconciliation, or history; active occurrences may finish.            |
| T12 | The join path resolves tenant by public ID, not by permissive host matching.                             |
| T13 | `meet` / `turn` are already reserved — the brief is out of date.                                         |
| T14 | No permanent SSH exposure; API key is server-only; node loss kills every room on it.                     |
| T15 | Rate-limit and shape-validate before any database work on the public route.                              |
| T16 | Attendance derives from reconciled provider events, not client claims.                                   |

## Open Questions

1. **How are guests recorded in attendance?** `MeetingAttendanceLog` is `User`-keyed
   (`prisma/schema.prisma:1475`). Options: guests are excluded from attendance entirely; a nullable
   guest-grant reference is added; or a separate guest-attendance record exists. This changes the
   reporting query (`src/server/routers/meetings.ts:517-551`) and team statistics
   (`src/server/routers/team-stats.ts:309`). Needs a product answer.
2. **What is the join-token TTL, in minutes?** T5's entire mitigation is this number. It trades
   re-entry exposure against refresh traffic and reconnect friction on a flaky mobile network. Needs
   a decision informed by measurement, not a guess.
3. **Is a guest's display name trusted input?** A guest types their own name. It appears to every
   member in the roster and, if attendance includes guests, in a durable record. Impersonation of a
   colleague by name is trivial. Needs a display treatment decision (e.g. an unambiguous "guest"
   marker that cannot be spoofed by the name itself).
4. **Does a host approve each guest, or does a valid credential admit automatically?** A lobby is a
   meaningful control against T1 and T5 residuals and a meaningful friction cost. Product decision.
5. **What is retained, and for how long?** No recording is in scope (`000-product-scope.md` D5), but
   attendance, grants, and webhook events are all durable. Retention interacts with the existing data
   controls module and is unanswered.
6. **Who may issue a guest link?** Any attendee, the organizer only, or an administrator? This
   determines how far the blast radius of one careless person extends.
