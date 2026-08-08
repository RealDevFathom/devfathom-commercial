# ADR-005: Self-Hosted Meetings

Status: **Proposed**, 2026-08-03. Not implemented. No code depends on this document yet.

This ADR records the decision to run DevFathom's meeting media on infrastructure DevFathom controls,
and pins the policies that decision forces. It follows ADR-001 (forced tenant RLS) and ADR-002 (the
separate seller control plane), and is deliberately compatible with ADR-004 (the authentication
identity plane), which is itself **Proposed** and currently unmerged on the
`codex/adr-004-draft` branch. There is no ADR-003 on `main` yet: the number is reserved for the
_Standard Shared-Host Login_ record, which lands with the shared-host-login branch and is described
in ADR-004's own context until then.

Supporting documents, in `docs/meetings/`: `000-product-scope.md`, `001-threat-model.md`,
`002-provider-adapter-contract.md`, `003-webhook-contract.md`, `004-join-flow.md`.

Statements are marked **CODE-VERIFIED** (cites a file and line range read at commit `417ff97`),
**RESEARCH-RECOMMENDATION** (from the external self-hosted-media research report, which is **not in
this repository**), or **DECISION**.

## Context

**CODE-VERIFIED.** DevFathom already has meetings, and already has video. A `meetings` licensed
module is seeded for every organization (`prisma/seed.ts:17`), mapped to the tRPC namespace, the REST
scope domain, and the `/meetings` route (`src/lib/module-catalog.ts:28`, `:40-51`, `:57`), and
rendered as a gated sidebar entry (`src/components/layout/sidebar.tsx:81-87`). Scheduling and
attendance live in `Meeting`, `MeetingAttendee`, and `MeetingAttendanceLog`
(`prisma/schema.prisma:1427-1492`), driven by `meetingsRouter`
(`src/server/routers/meetings.ts:10-552`).

Video is **JaaS — 8x8-hosted Jitsi**. The server mints an RS256 JaaS JWT scoped to
`meeting-${meetingId}` with a two-hour expiry (`src/server/routers/meetings.ts:337-395`,
`:369`, `:372`); the browser loads `https://8x8.vc/${appId}/external_api.js` and constructs the embed
against `8x8.vc` (`src/components/meetings/meeting-call.tsx:32-62`, `:138`); credentials are
`NEXT_PUBLIC_JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY` (`.env.example:66-68`,
`docs/admin-platform/operations.md:87`); and the Content-Security-Policy hard-codes the 8x8 origins,
with `Permissions-Policy` delegating `camera`, `microphone`, and `display-capture` to `https://8x8.vc`
(`next.config.ts:20-22`, `:40-41`, `:89`).

So this is a **replacement of a working third-party embed**, not a greenfield build, and the honest
framing of the decision is: what do we gain that is worth giving up somebody else's operational
burden.

## Decision

### 1. Why self-hosted — and explicitly not to save money

**DECISION.** DevFathom runs its own media infrastructure for four reasons:

- **Control of the product surface.** With a hosted embed, the call _is_ the vendor's product inside
  our frame. Prejoin, roster, permissions, layout, and branding are theirs. Meetings is a workspace
  feature that must look and behave like DevFathom Studio, not like a guest window.
- **Vendor independence.** A hosted provider's pricing, feature gating, and terms can change under
  us, and a deep embed is expensive to leave. The current integration reaches into the CSP, the
  Permissions-Policy, the token endpoint, and the call component
  (`next.config.ts:20-22`, `:40-41`, `:89`; `src/server/routers/meetings.ts:337-395`;
  `src/components/meetings/meeting-call.tsx`) — it is exactly as entangled as this bullet describes.
- **Data residency and data control.** DevFathom already deploys to **UAE North**
  (`infra/deploy-staging.sh:4`, `infra/staging.bicepparam:4`, `infra/production.bicepparam:4`). Media
  transiting a third party's global infrastructure is a claim we cannot make on our customers'
  behalf. Self-hosting makes "where does the media go" a question with our answer.
- **Control of the pricing model.** Not the price — the _model_. Per-seat or per-minute vendor
  pricing means the cost of the meetings module scales with customer usage in a shape we do not set,
  which constrains how the module can be packaged and sold.

**Self-hosting can cost MORE than the hosted service, and at low utilisation it very likely will.**
This is recorded as a decision consequence, not a footnote, because it is the thing a future reader
will discover from an invoice and try to "fix":

> A mostly-idle virtual machine bills 24 hours a day whether or not anyone joins a call. Egress bills
> per gigabyte leaving the network. A hosted per-minute service bills nothing when nobody is meeting.
> Below some utilisation threshold, the self-hosted bill is strictly higher, and there is no
> configuration change that alters that — it is the shape of the two pricing models.

**Cost reduction is not a reason for this decision and must never be cited as one.** If a future
reader is reading an Azure bill and considering reverting: the bill being higher was **expected**.
The reasons above are the reasons. Revert only if one of them has stopped being true, or if a trigger
in decision 9 has fired.

### 2. Launch media policy — a cost control, not a quality setting

**DECISION.** At launch, media is constrained as follows. These are **platform configuration**, not
user-facing quality controls; there are no arbitrary user controls initially.

| Setting               | Launch value                                         |
| --------------------- | ---------------------------------------------------- |
| Max resolution        | 1280×720                                             |
| Max bitrate           | 1 Mbps                                               |
| Max frame rate        | 24 fps                                               |
| Simulcast ladder      | 720p @ ~1 Mbps / 360p @ ~300 kbps / 180p @ ~100 kbps |
| Adaptive Stream       | Enabled                                              |
| Dynacast              | Enabled                                              |
| Active speaker        | One, at the highest appropriate layer                |
| Visible remote tiles  | Maximum 8 thumbnails                                 |
| Offscreen / paginated | Paused or unsubscribed                               |
| Screen share          | Separate preset, optimised for readability           |

**The resolution cap alone saves nothing.** This is the part that gets misremembered. A 720p cap
without a bitrate cap simply produces a 720p stream at whatever bitrate the encoder chooses; capping
the pixel count does not cap the bytes. **The bitrate cap and the subscription policy are what reduce
egress.** Specifically:

- The **bitrate cap** bounds what each publisher sends, which bounds what the SFU must forward.
- The **subscription policy** — adaptive stream, dynacast, one active speaker at the highest layer, a
  maximum of eight visible thumbnails, and offscreen or paginated tracks paused or unsubscribed —
  bounds the _fan-out_, and fan-out is where egress actually lives. In an N-participant call the SFU
  sends roughly N× what it receives unless something limits subscriptions. Limiting subscriptions is
  therefore worth more than limiting resolution, by a wide margin.

The screen share gets its own preset because the trade-off inverts: text legibility needs resolution
and tolerates a low frame rate, which is the opposite of a talking head.

These are recorded as a **cost control** so that a future request to "raise the quality" is understood
as a request to raise the bill, and is priced before it is granted.

### 3. Region — UAE North for staging and pilot, and a benchmark before production

**DECISION.**

- Staging and the controlled pilot run in **UAE North**. This is consistent with the existing
  deployment: **CODE-VERIFIED** at `infra/deploy-staging.sh:4` (`location=uaenorth`) and the shared
  resource group `rg-devfathom-shared-uaenorth` in both parameter files
  (`infra/staging.bicepparam:4`, `infra/production.bicepparam:4`).
- **Microsoft Premium routing**, not the cheaper commodity egress tier. Media quality is latency and
  jitter, and the routing tier is one of the few levers that changes both.
- **LiveKit and TURN sit in the same region and the same network.** A TURN relay in another region
  adds a round trip to every relayed path and pays inter-region egress on every relayed byte.
- **No cross-region media.** One room's media stays in one region.
- **A UAE North versus West Europe latency and cost benchmark is REQUIRED before the
  production-region decision.** Not after. The variables that matter — real client round-trip times
  from the actual customer population, relay ratio, and egress rate — are measurable and are currently
  guessed.

**Cheaper North American egress is not, on its own, a reason to move.** Egress rate is one term in an
expression whose other terms are latency to the people actually in the calls and the data-residency
claim in decision 1. A region that halves the egress rate and doubles the round-trip time is a worse
product at a lower price, and the data-residency argument may make it not an option at any price.

### 4. The guest boundary

**DECISION.** A meeting guest is **never** an `AuthenticationIdentity` and **never** an
`OrganizationMembership`. It is an **occurrence-scoped access grant** carrying an opaque credential,
an expiry, a revocation state, and a meeting role.

A guest **cannot**: create a global password, reach the organization picker, or touch any other
workspace surface. Converting a guest into a registered user is a **separate, explicit flow** that
starts from the ordinary invitation path — never an implicit upgrade at the end of a call.

**Nothing credential-bearing may span a recurring series.** Series-level participant records hold
**invitee and contact metadata only**. The credential hash, the expiry, the revocation state, and the
meeting role live on the **occurrence-scoped** record.

**CODE-VERIFIED that this is not currently satisfiable, which makes it a prerequisite rather than a
guideline.** There is no occurrence table: a recurring meeting is one `Meeting` row whose occurrences
are computed on read (`prisma/schema.prisma:1435`; `src/lib/meeting-occurrence.ts:75-128`;
`src/server/routers/meetings.ts:609-646`), the recurrence has no end date, and the nearest existing
shape — `MeetingAttendee` — is unique on `(meetingId, userId)`, i.e. **series-scoped**
(`prisma/schema.prisma:1461`). A credential stored there would be an indefinitely reusable one.

**Compatibility with ADR-004, stated explicitly.** ADR-004 decision 1 makes `AuthenticationIdentity`
the single global credential record, precisely so authentication consults exactly one secret; adding
guests to it would re-open the property that ADR is written to close. ADR-004 decision 5 establishes
that entry into an organization is an explicit **grant** per membership, never inferred from the
existence of a credential. **A guest grant is that same principle one level down**: it authorizes
exactly one occurrence, is not evidence about any other occurrence, and is certainly not evidence
about a membership. ADR-004 decision 2's containment argument also applies in the opposite direction —
the identity plane is a narrow, separately-scoped boundary, and guest grants stay firmly outside it,
in ordinary tenant-scoped storage under RLS.

### 5. Web only

**DECISION.** No native mobile application, no mobile SDK, no app-store deliverable.

**In scope:** responsive browser joining on supported iOS Safari and Android Chrome, as part of the
web product. A phone is a first-class join surface and is covered by the existing visual QA release
gate — 375px portrait is a required viewport and "no desktop-only implementation" is already
prohibited (`docs/design-system/DEVFATHOM-STUDIO.md`, sections 10 and 12).

**Out of scope, prominently:** native background calling and native screen sharing, and with them the
Swift and Android SDKs, the ReplayKit Broadcast Extension, and the `MediaProjection` foreground
service. **Roughly a quarter of the external research report covers this ground. None of it is being
built.** It is called out here, at the top level of the ADR rather than in a footnote, because the
most likely way it gets started is somebody reading the report and assuming it describes the plan.

### 6. Webhooks and availability

**DECISION.**

- **`minReplicas: 1` for every deployed environment that receives real LiveKit webhooks.**

  **CODE-VERIFIED** that this is a change: the container app is currently
  `scale: { minReplicas: 0, maxReplicas: 1 }` (`infra/environment.bicep:431`) with container
  resources `cpu: 0.5, memory: 1Gi` (`:418`), on a Consumption workload profile (`:289-292`). At zero
  replicas there is nothing listening, so a webhook arriving in a cold window is delivered to nobody —
  and cold-start latency can also cause the provider to time out a delivery that would otherwise have
  succeeded. **At `minReplicas: 0` the webhook contract cannot be honoured.** This is correctness, not
  tuning.

  **Pricing it.** Azure Container Apps on the Consumption profile bills active vCPU-seconds and
  GiB-seconds plus requests; an idle replica is billed at the idle rate rather than the active one,
  but it is billed. Moving from 0 to 1 converts a bursty bill into a continuous one of, per
  environment, **0.5 vCPU × ~730 h/month and 1 GiB × ~730 h/month**, multiplied by the number of
  environments that receive real webhooks. Those quantities are CODE-VERIFIED
  (`infra/environment.bicep:418`); the rates are not verifiable from this repository and must be taken
  from a current Azure quote for UAE North before the pilot budget is signed off. The point of pricing
  it here is that the number is **small, continuous, and not optional** — it must not be discovered
  later and "optimised" back to zero.

- **Signed idempotent webhooks are the primary near-real-time source, and are NOT infallible.**
- **Periodic reconciliation and room-end reconciliation against LiveKit are MANDATORY.**
- **Durable attendance derives from reconciled server-side events.**
- **Client join/leave calls are UX hints only, never authoritative.**

  **CODE-VERIFIED that today's attendance is precisely the untrustworthy kind:** `logJoin` and
  `logLeave` are client-invoked mutations (`src/server/routers/meetings.ts:402-473`, `:481-512`)
  fired from browser events, with a `keepalive: true` beacon on `pagehide` as a best-effort backstop
  (`src/components/meetings/meeting-call.tsx:102-114`, `:157-163`). A closed laptop produces no
  `leftAt` at all. These calls stay, because they make the interface responsive; they are demoted.
  Where a hint and a reconciled event disagree, the reconciled event wins.

`docs/meetings/003-webhook-contract.md` specifies verification order, idempotency key, replay window,
event vocabulary, and failure responses.

### 7. Entitlement semantics

**DECISION.** The **`meetings` module already exists** and is **reused**. No second gate is created.

**CODE-VERIFIED** that it exists and is wired end to end: seeded module row (`prisma/seed.ts:17`),
procedure/scope/route mapping (`src/lib/module-catalog.ts:28`, `:40-51`, `:57`), sidebar entry
(`src/components/layout/sidebar.tsx:81-87`), and the licensed-module middleware that enforces it
(`src/server/trpc.ts:160-169`, resolving the key at `src/lib/module-catalog.ts:36-38` and testing it
with `hasModule` at `src/lib/entitlements.ts:206-208`).

**Requiring the entitlement:**

- creating new scheduled meetings;
- opening future occurrences;
- issuing join tokens.

**Not gated, ever:**

- webhook ingestion;
- reconciliation;
- historical records.

**Disabling the module must never discard evidence.** A licence lapse is a commercial event; the
record of who attended what is not a licensed feature, it is a record about people, and it feeds
reporting (`src/server/routers/meetings.ts:517-551`) and team statistics
(`src/server/routers/team-stats.ts:84`, `:309`).

**An already-active occurrence may finish**, including reconnection by already-admitted participants.
Cutting a live call because a billing flag changed is a bad outcome for a customer and an
indistinguishable one from an outage. **Immediate termination is a separate, explicit platform
action**, audited as such.

**CODE-VERIFIED implementation constraint, which shapes where code may live.** Two separate
mechanisms, and conflating them gets the constraint wrong.

**Selection is namespace-based.** The module key is the first dot-separated segment of the tRPC path
(`src/lib/module-catalog.ts:36-38`), so every `meetings.*` path selects the `meetings` key, and the
middleware rejects the entire call when that key is not licensed (`src/server/trpc.ts:160-169`).

**Enforcement is procedure-builder-scoped.** `requireLicensedModule` is a middleware, and it runs
only where a builder composes it: `protectedProcedure` (`src/server/trpc.ts:202-205`),
`adminProcedure` (`:210-213`), `hrProcedure` (`:216-219`) and `capabilityProcedure` (`:226`).
`publicProcedure` is bare `t.procedure` with no middleware at all (`:77`). A `meetings.*` procedure
built on `publicProcedure` is therefore **not** gated — so "must survive a disabled module" does not
by itself force code out of the `meetings` namespace.

**The real constraint is stronger, and it is about transport, not namespace: ingestion is not a tRPC
procedure at all.**

- **The tRPC transport does not admit a provider payload.** `/api/trpc` is the only tRPC transport
  (`src/app/api/trpc/[trpc]/route.ts:162`). A session-less caller reaches it only by the anonymous
  path, which admits an exact allowlist of five recovery procedures
  (`src/lib/auth/anonymous-access.ts:27-44`, enforced at `:82-94`) and names the tenant from a
  `token` field parsed out of the tRPC input (`:103-135`). A LiveKit webhook carries a signed
  provider event naming a **room**, not a token naming a tenant. Reaching it through that transport
  would mean widening the anonymous allowlist and inventing a second tenant-routing rule inside it —
  which is the review-visible list that `src/lib/auth/anonymous-access.ts:18-23` exists to keep
  narrow.
- **Raw-body signature verification belongs in a route handler.** Verification is over the exact
  received bytes, and a tRPC adapter's job is to parse the body before the procedure sees it — the
  anonymous path already has to `request.clone().json()` to look at input at all
  (`src/lib/auth/anonymous-access.ts:131`). A route handler reads the bytes before anything parses
  them; a procedure behind a body-parsing adapter cannot.
- **The tRPC context refuses to build without an organization id** (`src/server/trpc.ts:44-46`). A
  provider webhook names a room; the tenant is _derived_ from the room, after verification.

So **LiveKit ingestion is a dedicated raw-body route handler**, and **reconciliation is a platform
job**. Entitlements are also resolved once per request at context construction
(`src/server/trpc.ts:48`), so a disable takes effect on the next request, not the current one — which
is consistent with "an active occurrence may finish" but is a consequence of the existing design, not
a control we implemented for this purpose.

**Historical reads are a third case, and today there is nowhere to put them.** "Not gated, ever"
above includes historical records: after the `meetings` licence lapses, the tenant's own users must
still be able to read who attended what, and the reporting and team-statistics paths that consume it
(`src/server/routers/meetings.ts:517-551`, `src/server/routers/team-stats.ts:84`, `:309`) must keep
answering. Unlike ingestion and reconciliation, these are ordinary in-app tenant reads — they belong
on the tRPC transport, made by a signed-in member of the organization. Every authenticated builder in
`src/server/trpc.ts` composes `requireLicensedModule`, so such a read fails with FORBIDDEN the moment
the module is disabled.

**`publicProcedure` is not the escape hatch.** It is bare `t.procedure` (`src/server/trpc.ts:77`):
no `requireActiveUser`, no audit middleware, no capability check. Serving attendance history from it
would exchange a billing gate for no authentication at all, on precisely the records this decision
exists to preserve — the same loss of evidence by a different route. Historical meeting reads
**must not** use `publicProcedure`.

**What closing this needs, recorded here so it is not discovered during implementation:** an
authenticated, audited, tenant-scoped procedure builder that omits **only** `requireLicensedModule`
— the shape of `protectedProcedure` (`src/server/trpc.ts:202-205`) with its third middleware
dropped, and composing the read-auditing middleware the sensitive-read builders already use
(`auditAll`, `:146`, as `adminProcedure` `:210-213` and `hrProcedure` `:216-219` do) rather than
`auditMutations`, since these are reads. Tenant scoping is unchanged and comes from the context, not
the builder: it still refuses to construct without an organization id (`:44-46`) and still hands the
resolver an RLS-scoped client (`:47`). **This ADR does not add that builder** — it records the
requirement. Whichever phase first ships a historical meeting read introduces it. Nothing above
changes: ingestion stays a raw-body route handler, reconciliation stays a platform job.

### 8. Pilot reliability

**DECISION.** A **single LiveKit VM is acceptable for staging and a controlled pilot only, explicitly
with no high availability and no SLA.** This is stated as a limitation of the pilot, not a property of
the product.

**A dropped call has no retry.** Unlike an HTTP request, a failed conference is not something the
client can transparently repeat; the meeting is simply over, in front of everyone who was in it. That
asymmetry is why the operational procedures below are part of the decision rather than a runbook
detail.

Required before the pilot:

- **A maintenance window.** A published window outside working hours for the customer population the
  pilot serves, during which restarts and upgrades may happen. Outside it, they may not.
- **A drain-aware deallocation procedure.** **Never deallocate while LiveKit reports an active room.**
  The check is `getRoomState` (`docs/meetings/002-provider-adapter-contract.md` §8), and it runs
  immediately before deallocation, not at the start of a maintenance script. "It was empty when I
  started" is not the same statement as "it is empty now".
- **A recovery procedure.** What is done when the node is lost: how a replacement is brought up, how
  long it takes, what is communicated to affected organizations, and who decides. Written before it is
  needed.
- **Configuration backup.** The node's configuration — keys, ports, TURN credentials, media policy —
  is reproducible from a stored source, not from the running machine. A lost node must not also mean a
  lost configuration.
- **A scale-out threshold.** The concurrent-room and concurrent-participant numbers at which one node
  stops being acceptable, decided in advance and monitored, so scale-out is a scheduled action rather
  than an incident.

**RESEARCH-RECOMMENDATION, adopted, and the reason the above is not paranoia:** a single room cannot
be split across SFU nodes. Scaling out distributes **rooms**, not participants within a room —
so scale-out does not make any individual meeting more robust, and **losing a node kills every room on
it**.

### 9. Reconciliation with the research report

The external research report is a genuine input and is **not in this repository** — nothing under
`docs/` mentions LiveKit — so its claims are **RESEARCH-RECOMMENDATION** throughout. Where it
disagrees with this ADR, this ADR governs.

| #   | Report position                                                                    | Decision here                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Keep Jitsi as a documented fallback; type the adapter `"livekit" \| "jitsi"`.      | **Rejected.** The union is `"livekit"` only. A two-value union is an invitation to implement the second: it makes every switch look incomplete and turns a decision into an ambient option. The report's fallback **triggers** are kept as the decision-reopening checklist below — prose, never a type.                 |
| 2   | Extensive native mobile coverage (Swift/Android SDKs, ReplayKit, MediaProjection). | **Out of scope**, prominently. Decision 5.                                                                                                                                                                                                                                                                               |
| 3   | MVP topology includes Redis and an Egress worker.                                  | **Both deferred.** Neither is needed to hold a call. Recording and export are a separate product decision with their own storage, retention, and consent questions.                                                                                                                                                      |
| 4   | Public URL `app.devfathom.com/m/{id}`.                                             | **Rejected.** The target is `www.devfathom.com/meet/<id>` and `company.devfathom.com/meet/<id>` — matching configured host policy (`infra/production.bicepparam:7`), not a claim that production or media endpoints are live. See `docs/meetings/004-join-flow.md`.                                                                                                                    |
| 5   | Sample schema has no occurrence concept and cannot represent a recurring series.   | **Rejected, and the gap is load-bearing.** Our Meeting/occurrence split is better and must not be diluted: decision 4's "nothing credential-bearing spans a series" is unimplementable without it. Note the split is currently a _plan_ — occurrences are computed, not stored (`src/lib/meeting-occurrence.ts:75-128`). |
| 6   | 8-vCPU SFU estimate.                                                               | **Rejected as a starting point.** It predates our selective-subscription policy (decision 2), which changes the fan-out the SFU must serve. **We start at four vCPUs and earn eight with measurement.**                                                                                                                  |
| 7   | UDP mux.                                                                           | **Adopted.** One UDP port for media rather than a wide ephemeral range: a narrower published surface, easier to firewall and easier to reason about.                                                                                                                                                                     |
| 8   | A single room cannot be split across SFU nodes.                                    | **Adopted, and treated as a first-class constraint.** Scaling out distributes rooms, not participants; losing a node kills every room on it. Decision 8.                                                                                                                                                                 |

**Decision-reopening checklist (the report's fallback triggers, kept as prose).** Any of the following
is grounds to re-open this ADR — deliberately, in writing, with a successor record. None of them is
grounds to add a second value to a union:

- sustained media quality below target after the media policy and region decisions have been tuned;
- operational load from decision 8's procedures exceeding what the team can carry;
- a scale-out threshold reached materially sooner than the pilot projected;
- a security or availability property of the self-hosted stack proving unfixable at our size;
- the cost model in decision 1 inverting for a reason other than low utilisation — i.e. the _shape_
  changing, not the invoice being larger than a hosted alternative, which was expected.

## Consequences

Benefits:

- the call becomes part of the DevFathom product rather than a vendor's product in our frame;
- media path and data residency become claims we can make and defend;
- the pricing model of the meetings module is ours to set;
- the guest boundary is decided before any guest code exists, rather than retrofitted;
- attendance stops being a client assertion and becomes reconciled server-side evidence.

Costs:

- **a bill that is probably higher at low utilisation, permanently and by design** (decision 1);
- an operational burden with real procedures and a real on-call expectation (decision 8);
- no HA and no SLA during the pilot, for a failure mode that has no retry;
- an occurrence record and a scheduling redesign as a hard prerequisite for guests (decision 4), which
  today's computed-occurrence model cannot supply;
- retiring a working JaaS integration, including its CSP and Permissions-Policy allowances
  (`next.config.ts:20-22`, `:40-41`, `:89`);
- a mitigation for participant removal that is a TTL policy rather than a switch, because self-hosted
  LiveKit has no token revocation (`docs/meetings/001-threat-model.md` T5).

## Rejected alternatives

- **Stay on JaaS.** Cheapest and least work, and it fails decision 1 on all four counts: the call is
  the vendor's surface, the entanglement is already deep, media residency is not ours to claim, and
  the pricing model is not ours to set.
- **Self-host to reduce cost.** Rejected as a _rationale_, not as an outcome. At pilot utilisation it
  is false, and recording it as a reason guarantees a future reader reverts the decision on seeing an
  invoice.
- **Keep a Jitsi adapter branch alongside LiveKit.** Rejected: see decision 9 row 1. Worse here than
  in the abstract, because Jitsi is not hypothetical — it is the live integration, so a "fallback"
  would be retained production code rather than unused code.
- **A series-level public identifier and a series-level guest credential.** Simpler to build and
  produces an indefinitely reusable link on an unbounded recurrence, plus an occurrence the
  application must guess. `docs/meetings/004-join-flow.md` D1.
- **Guests as lightweight `User` rows.** Reuses existing attendance and authorization plumbing, and
  puts non-members inside the tenant identity model, where an authorization check that asks only "is
  there a session?" admits them. Directly contrary to ADR-004 decision 5.
- **A second entitlement key for self-hosted meetings.** Two gates for one product surface, guaranteed
  to diverge. Decision 7.
- **`minReplicas: 0` with a webhook queue in front.** Adds a component to preserve a saving smaller
  than the component costs, and the queue then needs its own availability story.
- **Multi-region media for latency.** Contrary to decision 3, and undermined by the report's own
  finding that a room lives on one node (decision 9 row 8).

## Open Questions

1. **The transition plan from JaaS.** Feature-flagged per organization, hard cutover at a release
   boundary, or both live for one release. Needs a human decision before implementation starts.
2. **Occurrence materialisation. — ANSWERED by MEET-01 (PR #23), pending merge.** Decision 4 required
   an occurrence record and there was none. `MeetingOccurrence` is now materialised per instance
   (`prisma/migrations/20260803120000_meeting_occurrences/`), identified within its series by an
   immutable `seriesSlotStart` RRULE instant, with per-occurrence exceptions on the row
   (`titleOverride`, `cancelledAt`/`cancelledById`/`cancellationReason`) and a reschedule moving
   `scheduledStart`/`scheduledEnd` away from the slot instead of rewriting it. The series carries
   `recurrenceRule` plus a validated IANA `timezone`; the four fixed intervals are migrated and the
   legacy `recurrence` column is deprecated, not read. The scheduling redesign this question called
   unsized is what MEET-01 shipped. What remains is the application work that reads these tables.
3. **The join-token TTL, in minutes.** The entire mitigation for participant re-entry
   (`docs/meetings/001-threat-model.md` T5). Needs a number, informed by reconnect behaviour on a
   flaky mobile network.
4. **Guest attendance. — ANSWERED by MEET-01 (PR #23), pending merge.** The model changed rather than
   excluding guests. `MeetingParticipant` holds series-level invitee metadata with exactly one contact
   reference by CHECK — internal user, client contact, or a bare email for an outsider — and no
   credential column. `MeetingOccurrenceParticipant` is the occurrence-scoped grant and the only place
   a guest credential lives. `MeetingParticipantSession` is the attendance evidence, with a nullable
   `userId`, the provider participant SID, and a `source` that keeps webhook-verified rows
   distinguishable from backfilled `LEGACY_CLIENT` ones. `MeetingAttendanceLog` is left in place. The
   consequence this question flagged is now a migration task, not a decision: reporting
   (`src/server/routers/meetings.ts:517-551`) and team statistics
   (`src/server/routers/team-stats.ts:84`, `:309`) still read the `User`-keyed log and must be moved.
5. **The benchmark itself.** Decision 3 requires UAE North versus West Europe before the production
   region is chosen. Who runs it, against which client population, and what result would actually
   change the decision.
6. **Current Azure rates for the `minReplicas: 1` line.** Decision 6 gives the quantities; the rates
   need a current UAE North quote.
7. **Which environments receive real webhooks.** Decision 6 applies `minReplicas: 1` to those; whether
   staging is one of them is an environment decision with a recurring cost.
8. **ADR-004's status.** This ADR cross-references a **Proposed**, unmerged document. If ADR-004
   changes materially before acceptance, decision 4's compatibility argument must be re-checked rather
   than assumed.

## Evidence

Prior decisions: `docs/admin-platform/adr/001-tenant-rls.md` (forced tenant RLS),
`docs/admin-platform/adr/002-control-plane-separation.md` (the first table outside tenant RLS), and
ADR-004 (`docs/admin-platform/adr/004-authentication-identity-plane.md`, **Proposed**, on
`codex/adr-004-draft` and not on `main`).

Supporting documents: `docs/meetings/000-product-scope.md`, `001-threat-model.md`,
`002-provider-adapter-contract.md`, `003-webhook-contract.md`, `004-join-flow.md`.

Current implementation this replaces or builds on: `src/server/routers/meetings.ts`,
`src/components/meetings/meeting-call.tsx`, `src/lib/meeting-occurrence.ts`, `src/lib/authz.ts`,
`src/app/api/v1/meetings/route.ts`, `src/lib/ai/tools/meetings.ts`, `src/lib/email/templates.ts`,
`prisma/schema.prisma` (`Meeting`, `MeetingAttendee`, `MeetingAttendanceLog`),
`src/lib/module-catalog.ts`, `src/server/trpc.ts`, `src/components/layout/sidebar.tsx`,
`src/lib/tenancy/host.ts`, `src/lib/tenancy/host-routing.ts`, `src/lib/auth/anonymous-tenant.ts`,
`src/lib/auth/anonymous-access.ts`, `src/app/api/trpc/[trpc]/route.ts`, `next.config.ts`,
`.env.example`, and `infra/` (`environment.bicep`, `staging.bicepparam`, `production.bicepparam`,
`deploy-staging.sh`).
