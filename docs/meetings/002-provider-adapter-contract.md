# MEET-002: Provider Adapter Contract

Status: **Proposed**, 2026-08-03. Documentation only. No code implements this contract yet.

Markings — **CODE-VERIFIED**, **RESEARCH-RECOMMENDATION**, **DECISION** — are defined in
`000-product-scope.md`.

## What this is, and what it deliberately is not

**DECISION.** This is a **thin boundary**, not a framework. It exists for exactly two reasons:

1. To keep provider SDK types, room-name conventions, and token-minting details out of routers,
   components, and the scheduling model — so that "what does the application know about LiveKit" is a
   question with a one-directory answer.
2. To make the capability gaps of a self-hosted deployment **explicit and typed**, rather than
   discovered at incident time. The capability map below is the single most important thing in this
   document.

It is **not** a portability layer, and no second provider is being accommodated.

### The union is `"livekit"`, and only `"livekit"`

**DECISION.**

```ts
export type MeetingProviderKind = 'livekit';
```

The research report keeps Jitsi as a documented fallback and types the adapter
`"livekit" | "jitsi"`. **We do not.** A two-value union is an invitation to implement the second
value: it makes every switch statement look incomplete, it justifies a second code path in review,
and it converts a decision that should be reopened deliberately into an ambient option.

The report's **fallback triggers are kept** — as a decision-reopening checklist in ADR-005 decision 9,
prose that a human reads and acts on. They are never a type.

**This matters more than it looks, because Jitsi is not hypothetical here.** **CODE-VERIFIED:**
DevFathom's _current_ production video provider is JaaS — 8x8-hosted Jitsi. The server mints a JaaS
RS256 JWT (`src/server/routers/meetings.ts:337-395`), the client loads
`https://8x8.vc/${appId}/external_api.js` and constructs the embed against `8x8.vc`
(`src/components/meetings/meeting-call.tsx:32-62`, `:138`), the credentials are three environment
variables (`.env.example:66-68`, `docs/admin-platform/operations.md:87`), and the CSP hard-codes the
8x8 origins (`next.config.ts:20-22`, `:40-41`, `:89`). So "Jitsi as a fallback" would not be
speculative dead code — it would be **retained live code**, which is worse. The JaaS path is
**retired**, not kept warm.

## Capability map

**DECISION.** The adapter exposes a static capability record, and the application reads it rather
than assuming. It is a contract about what the _deployment_ can do, not about what the vendor's
documentation describes.

```ts
export type MeetingProviderCapabilities = {
  /**
   * Whether an already-issued join token can be invalidated before it expires.
   *
   * "none" for self-hosted LiveKit. Removing a participant ends the SESSION; it
   * does not invalidate the TOKEN, which stays cryptographically valid until it
   * expires. THIS VALUE IS WHY THE SHORT-TTL POLICY EXISTS. See MEET-001 T5.
   */
  tokenRevocation: 'none';
  /** Server-side recording/export. Not deployed at launch. */
  egress: false;
  /** Multi-node room distribution. A single room lives on exactly one node. */
  roomDistribution: false;
  /** Simulcast layer selection and server-side subscription control. */
  selectiveSubscription: true;
  /** Signed webhook delivery, at-least-once, not guaranteed. */
  webhooks: 'signed-at-least-once';
};
```

`tokenRevocation: 'none'` is recorded **RESEARCH-RECOMMENDATION** — it is a property of the
self-hosted deployment reported by the external research, and it cannot be verified against this
repository because no LiveKit code exists here. It must be re-verified against the deployed build
before the pilot, because every mitigation in MEET-001 T5 rests on it.

## Operations

**DECISION.** The adapter surface is the following operations and nothing else. Each is described by
intent, inputs, outputs, and failure mode. Signatures are illustrative; the binding part is the
**set** of operations and the invariants beneath them.

### 1. `createRoom`

Create or idempotently ensure a provider room for one occurrence, applying the launch media policy
(ADR-005 decision 2) as server-side configuration.

- **In:** occurrence reference, the occurrence's random room name, media policy.
- **Out:** provider room handle.
- **Invariant:** the room name is supplied by the caller from the occurrence record and is
  **separately random per occurrence**. The adapter never derives a room name from a meeting id, a
  public ID, or anything else a link holder can see. Today's derivation
  `meeting-${input.meetingId}` (`src/server/routers/meetings.ts:369`) is exactly what this forbids.
- **Failure:** provider unreachable → the caller surfaces "the call could not be started", never a
  provider error string.

### 2. `configureRoom`

Apply or update room-level policy on an existing room — the bitrate ceiling, the simulcast ladder,
adaptive-stream and dynacast settings, participant limits.

- **Invariant:** policy is **platform configuration**, not a per-user control. No arbitrary user
  controls at launch (ADR-005 decision 2).

### 3. `issueJoinCredential`

Mint a short-lived join token for one participant of one occurrence.

- **In:** room handle, participant identity (member `User` id, or an occurrence-scoped guest grant
  id), display name, meeting role, permission set.
- **Out:** token string, expiry, and the media server URL to connect to.
- **Invariants:**
  - **Short TTL**, sized for a join plus a reconnect. Not the meeting's duration. The current JaaS
    two-hour expiry (`src/server/routers/meetings.ts:372`) is not carried forward.
  - The room is re-derived from the occurrence loaded in tenant scope. **The client never supplies a
    room name.**
  - The call refuses if the participant's grant is revoked or expired, or if the participant was
    removed from this occurrence. Refusal-to-reissue is the load-bearing half of MEET-001 T5.
  - The token never reaches web storage; it is returned to a call surface that holds it in memory.

### 4. `removeParticipant`

Disconnect one participant from a live room.

- **Invariant:** the adapter call is the _second_ half of removal. The _first_ half is the durable
  server-side removal record that makes `issueJoinCredential` refuse. Calling only the adapter leaves
  a participant who can immediately rejoin with the token they already hold.
- **Failure:** a failed provider call must not roll back the durable removal record. The durable
  record is the authority.

### 5. `updateParticipantPermissions`

Change what a participant may do in a live room — publish audio, publish video, publish screen share,
subscribe.

- **Use:** mute-others, promote/demote, stop a screen share. Preferred over remove-and-readmit,
  because readmission requires a fresh token and the TTL policy makes that user-visible.

### 6. `endRoom`

End a room for everyone.

- **Invariant:** ending a room is expected to emit a room-end event; the application does **not**
  rely on that event arriving. Room-end reconciliation (MEET-003) runs regardless.

### 7. `verifyAndNormalizeWebhook`

Verify a raw inbound request against the provider signing key and, only if valid, return a
normalized event.

- **In:** raw body bytes, headers.
- **Out:** either a normalized event `{ id, type, occurrenceRef, participantRef?, occurredAt }`, or a
  rejection.
- **Invariants:**
  - Verification happens on the **raw bytes**, before any parse that could be influenced by content.
  - The returned type is a **DevFathom** event vocabulary, not a LiveKit one. Routers and
    reconciliation never import provider types.
  - Rejection is indistinguishable in status, timing shape, and body from any other rejection.
- MEET-003 specifies the event vocabulary and the idempotency key.

### 8. `getRoomState`

Read the provider's current view of a room: does it exist, is it active, who is connected.

- **Use:** reconciliation (MEET-003), and the drain-aware deallocation check in ADR-005 decision 8 —
  _never deallocate while the provider reports an active room_. That procedure depends on this
  operation, so it is not optional.

### Deferred, named here so they are not reinvented

- `startEgress` / `stopEgress` — recording and export. Deferred with the Egress worker
  (`000-product-scope.md` D5). The signature is not designed in this phase; naming them prevents a
  parallel mechanism appearing later.

## Boundary rules

**DECISION.**

1. **No provider type escapes the adapter directory.** No router, component, job, or test outside it
   imports a LiveKit type. The compiler enforces the boundary by there being nothing to import.
2. **No provider identifier is user-supplied.** Room names, participant identities, and permissions
   are derived server-side from records loaded in tenant scope.
3. **Errors are normalized.** The adapter throws a small, closed set of DevFathom errors —
   unavailable, not-found, refused, invalid — never a provider error object and never a provider
   message forwarded to a client.
4. **The adapter is stateless.** Durable state — grants, removals, attendance, occurrences — is the
   application's, in Postgres, under RLS. The adapter is a client, not a store. This is what makes
   `tokenRevocation: 'none'` survivable: the authority for "may this person rejoin" is ours.
5. **The adapter is server-only.** Marked `import 'server-only'`, the convention already used for
   tenancy and identity code (`src/lib/tenancy/host.ts:1`, `src/lib/auth/anonymous-tenant.ts:1`).

## What the browser side needs, recorded here so it is not forgotten

**CODE-VERIFIED.** The current CSP is written for a third-party iframe and will not admit a
self-hosted SFU:

- `script-src`, `connect-src`, and `frame-src` name `https://8x8.vc` / `https://*.8x8.vc` and
  `wss://8x8.vc` / `wss://*.8x8.vc` (`next.config.ts:20-22`, `:40-41`).
- `Permissions-Policy` delegates `camera`, `microphone`, and `display-capture` to
  `https://8x8.vc` (`next.config.ts:89`).

Self-hosted LiveKit is a same-origin script talking to `wss://meet.<domain>`, not an iframe. So
`connect-src` gains the media host, `frame-src` for 8x8 goes away with the embed, and the
`Permissions-Policy` delegation collapses back to `self`. **DECISION:** this is part of the
implementing change, not a follow-up — a CSP that still names 8x8 after the embed is gone is stale
allowance.

## Open Questions

1. **Where does the adapter live?** `src/lib/meetings/provider/` is the obvious shape given
   `src/lib/tenancy/` and `src/lib/auth/`, but the directory does not exist and the choice affects the
   import-boundary rule above.
2. **Does `issueJoinCredential` take a permission set, or a meeting role that maps to one?** A role
   is fewer decisions at the call site and less room for an over-permissive token; a permission set is
   more expressive. Roles are the safer default; confirm before implementation.
3. **How does a long meeting refresh its token?** Short TTL implies refresh. Silent background
   refresh, or a visible reconnect? This is both a security parameter (MEET-001 open question 2) and a
   UX decision.
4. **Is `getRoomState` cheap enough to poll for reconciliation at the interval MEET-003 wants?**
   Unmeasured. If not, reconciliation needs a different shape.
5. **Does the adapter own the media policy constants, or does the platform configuration surface?**
   ADR-005 decision 2 requires them to be platform-configurable and not user-controllable; it does not
   say where they are stored.
