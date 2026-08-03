# MEET-003: Webhook and Reconciliation Contract

Status: **Proposed**, 2026-08-03. Documentation only.

Markings — **CODE-VERIFIED**, **RESEARCH-RECOMMENDATION**, **DECISION** — are defined in
`000-product-scope.md`.

## The premise

**DECISION.** Signed, idempotent webhooks are the **primary near-real-time source** of what happened
in a room. They are **not infallible**. Periodic reconciliation and room-end reconciliation against
the provider are **mandatory**. Durable attendance derives from **reconciled server-side events**.
Client join/leave calls are **UX hints only, never authoritative**.

This is the same statement as ADR-005 decision 6 and MEET-001 T8. It is repeated here because it is
the single assumption every other rule in this document depends on, and because the failure it
guards against is silent: a lost webhook produces no error, no alert, and no gap anyone notices —
just an attendance record that is quietly wrong.

## Two things called "webhooks" — do not confuse them

**CODE-VERIFIED.** A `webhooks` module key already exists — seeded as a platform module
(`prisma/seed.ts:23`) and mapped to the tRPC namespace of the same name
(`src/lib/module-catalog.ts:33`). It is **outbound tenant delivery**: an organization administrator
registers an HTTPS endpoint and a write-once signing secret, and DevFathom POSTs product events to
them (`src/server/routers/webhooks.ts:1-25`; every procedure is built on `adminProcedure`, imported
at `:3`).

**DECISION.** LiveKit webhooks are **inbound, provider-to-DevFathom**, and share nothing with that
module — not the key, not the secret store, not the delivery record, not the entitlement. Reusing
the `webhooks` entitlement would gate provider ingestion behind a tenant's outbound-webhooks licence,
which is exactly the evidence-destroying coupling ADR-005 decision 7 forbids.

**CODE-VERIFIED:** there is no inbound webhook route in the repository today — no
`src/app/api/**/webhook*` path exists.

## Endpoint

**DECISION.**

- A single **platform-level** REST route, not a tRPC procedure. Two reasons, both binding:
  1. The licensed-module middleware keys on the first segment of the tRPC path
     (`src/lib/module-catalog.ts:36-38`) and rejects the whole call
     (`src/server/trpc.ts:160-169`). A `meetings.*` procedure would be gated by the `meetings`
     entitlement — and ingestion must **never** be gated (ADR-005 decision 7).
  2. The tRPC context refuses to build without an organization id
     (`src/server/trpc.ts:44-46`). A provider webhook names a room, not a tenant. The tenant is
     _derived_ from the room, after verification.
- The route is not host-routed. The provider posts to one fixed URL per environment.
- The route reads the **raw body bytes** before any parsing, because signature verification is over
  the bytes.

## Processing order

**DECISION.** Strictly this order. Every step before step 5 is cheap and side-effect-free.

1. **Method and content bound.** Reject anything but `POST`; reject a body above a small fixed cap.
2. **Verify the signature** over the raw bytes against the provider signing key
   (`verifyAndNormalizeWebhook`, MEET-002 §7). Failure → discard, no side effect, no distinguishing
   response.
3. **Check freshness.** Reject an event whose provider timestamp is outside an acceptance window
   (see below). This is the anti-replay control.
4. **Normalize** to the DevFathom event vocabulary. Provider types do not leave the adapter.
5. **Resolve the room to an occurrence**, in platform scope, returning nothing but the occurrence
   reference and its organization id. An unknown room is discarded — a valid signature over a room we
   never created is either a stale environment or an attack, and neither deserves a write.
6. **Record the event idempotently** and apply its effect, **inside that tenant's RLS scope**.
7. **Respond 2xx** as soon as the event is durably recorded. Effects that can be deferred are
   deferred; the provider's retry budget is not spent on our downstream work.

## Idempotency

**DECISION.**

- Every event carries a **provider event identity**. That identity is the idempotency key, stored
  with a uniqueness constraint. A duplicate insert is a **no-op**, not a second write and not an
  error.
- The response to a duplicate is the same 2xx as the first delivery. A provider that retries because
  it missed our response must not be told anything different the second time.
- Where a provider event identity is absent or not trustworthy, the key is the tuple
  `(event type, room, participant, provider timestamp)` — deterministic from the payload, so a replay
  of the same bytes collides.

**CODE-VERIFIED precedent for the shape.** The existing attendance writes already use race-safe
idempotent inserts — `createMany` with `skipDuplicates`, then a read-back when `count === 0`
(`src/server/routers/meetings.ts:276-298`, `:433-450`) — introduced because
`findUnique`-then-`create` threw `P2002` on a genuine concurrent double-join. Webhook ingestion
inherits that pattern rather than inventing one.

## Replay window

**DECISION.** An event older than a bounded acceptance window is rejected at step 3, before any
lookup. The window must be wide enough to absorb the provider's full retry schedule and clock skew,
and narrow enough that a captured request cannot be replayed indefinitely. Idempotency (above)
already makes a replay of a _processed_ event harmless; the window bounds replay of an event we never
saw — for example one captured in flight during an outage and injected days later.

**Open:** the exact window depends on the provider's retry schedule, which is unverified here. Listed
below.

## Loss

**CODE-VERIFIED.** Loss is not hypothetical in the current infrastructure. The container app is
configured `scale: { minReplicas: 0, maxReplicas: 1 }` (`infra/environment.bicep:431`). At zero
replicas nothing is listening, and a webhook delivered into a cold window reaches nobody. Cold-start
latency also risks the provider timing out a delivery that _would_ have been accepted.

**DECISION.**

- **`minReplicas: 1` for every deployed environment that receives real LiveKit webhooks.** Priced in
  ADR-005 decision 6. This is a correctness requirement, not a performance tuning: at
  `minReplicas: 0` the webhook contract cannot be honoured at all.
- **Reconciliation is mandatory and has two triggers:**
  - **Room-end reconciliation.** When a room ends — by event, by scheduled end, or by any other
    signal — the application reads the provider's view of that room (`getRoomState`, MEET-002 §8) and
    closes out attendance from it. This is the reconciliation that matters most, because it is the
    last chance to get one occurrence right.
  - **Periodic reconciliation.** A scheduled sweep over occurrences that are active or recently
    ended, comparing our recorded state against the provider's. It catches rooms whose end event was
    itself lost — the case room-end reconciliation cannot catch, because it is triggered by the thing
    that went missing.
- Reconciliation writes are **idempotent against webhook writes**: both converge on the same event
  identity, so a reconciled event and a late-arriving webhook for the same fact do not double-count.
- **A reconciliation that finds a discrepancy is a logged, countable event.** Silent repair hides a
  broken delivery path. The existing structured-warning convention applies — a labelled console
  warning with a JSON payload, as used for ambiguous host resolution
  (`src/lib/tenancy/host.ts:100-102`, `:257-267`).

**CODE-VERIFIED on why client calls cannot substitute.** Today's attendance is client-driven:
`logJoin` and `logLeave` are mutations the browser fires on Jitsi events
(`src/server/routers/meetings.ts:402-473`, `:481-512`;
`src/components/meetings/meeting-call.tsx:157-163`), with a `keepalive: true` beacon on `pagehide`
as a best-effort backstop (`:102-114`). A closed laptop, a killed process, or a lost network produces
**no `leftAt` at all**. These calls stay — they make the UI responsive — and they are demoted to
hints. Where a client hint and a reconciled event disagree, **the reconciled event wins**.

## Event vocabulary

**DECISION.** The application's normalized vocabulary, minimal at launch:

| Event                | Meaning                          | Effect                                                      |
| -------------------- | -------------------------------- | ----------------------------------------------------------- |
| `room.started`       | The provider room became active. | Mark the occurrence live.                                   |
| `room.finished`      | The provider room ended.         | Mark the occurrence ended; trigger room-end reconciliation. |
| `participant.joined` | A participant connected.         | Open an attendance interval for that participant.           |
| `participant.left`   | A participant disconnected.      | Close the open attendance interval.                         |

Provider event types map into this set inside the adapter (MEET-002 §7). Events with no mapping are
recorded for observability and have **no effect** — an unmapped event must never be interpreted by
guessing.

## Entitlement

**DECISION.** Restating ADR-005 decision 7 in the terms of this document, because this is the
endpoint where getting it wrong destroys data:

- **Never gated:** webhook ingestion, reconciliation, and every historical record. Disabling a
  module is commercial; it must not discard evidence.
- **Gated:** new scheduling, opening future occurrences, and join-token issuance.
- An **already-active occurrence may finish**, including reconnection by participants who were
  already admitted.
- Immediate termination is a **separate, explicit platform action**, audited as such — never a side
  effect of a billing change.

**CODE-VERIFIED consequence.** Because the gate is namespace-wide
(`src/lib/module-catalog.ts:36-38`, `src/server/trpc.ts:160-169`), reconciliation cannot be a
`meetings.*` tRPC procedure. It is a scheduled job or a platform-scope route. There is already a
`CRON_SECRET` convention for scheduled work (`.env.example:13`).

## Failure responses

**DECISION.**

| Condition                | Response | Rationale                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| Bad signature            | 4xx      | Not retryable. Discard silently; no detail in the body.               |
| Stale timestamp          | 4xx      | Not retryable.                                                        |
| Unknown room             | 2xx      | Nothing to do, and a retry would not help. Counted for observability. |
| Duplicate event identity | 2xx      | Already handled; identical to the first response.                     |
| Database unavailable     | 5xx      | Retryable — we _want_ the provider to retry this one.                 |

The distinction that matters: **only conditions we can recover from by retrying return 5xx.**
Returning 5xx for a bad signature invites a retry storm from a forged sender.

## Open Questions

1. **What is the provider's actual retry schedule and its delivery guarantee?**
   **RESEARCH-RECOMMENDATION** says at-least-once. The replay window, the acceptance window, and the
   periodic reconciliation interval all depend on the real numbers, and none of them can be verified
   from this repository.
2. **How often does periodic reconciliation run, and over what horizon?** Too frequent is provider
   load and cost; too sparse leaves attendance wrong for hours. Needs the cost of `getRoomState` (see
   MEET-002 open question 4).
3. **Does a lost `participant.left` close an interval by inference?** If a room finished and a
   participant interval is still open, the close time could be the room-end time, or the interval
   could be marked incomplete. The first is friendlier, the second is more honest. Needs a decision,
   because it changes what "attended" means in a report.
4. **Where do webhook events live?** A dedicated durable event table under tenant RLS, keyed for
   idempotency, is the obvious answer — but the occurrence record it would reference does not exist
   yet (`000-product-scope.md` open question 2).
5. **Are guest participants ingested into attendance at all?** Blocked on MEET-001 open question 1 —
   `MeetingAttendanceLog` requires a `User` foreign key (`prisma/schema.prisma:1475`, `:1485`).
6. **Is `minReplicas: 1` applied to staging as well as production?** ADR-005 decision 6 says every
   environment receiving **real** LiveKit webhooks. Whether staging receives real ones is an
   environment decision with a monthly cost attached.
