# MEET-000: Meetings Product Scope

Status: **Proposed**, 2026-08-03. Documentation only. No code, schema, or infrastructure in this
phase depends on this document.

## How to read the markings

Every substantive statement in this document set carries one of three markings, and they are never
blurred:

- **CODE-VERIFIED** — a claim about what the repository does today. It cites a file and a line
  range that was actually read at commit `417ff97` (`origin/main`).
- **RESEARCH-RECOMMENDATION** — a claim originating in the external self-hosted-media research
  report. The report is **not in this repository** — nothing under `docs/` mentions LiveKit — so
  these statements cannot be cited to a file and are recorded as external input, not as fact.
- **DECISION** — a choice made for DevFathom Meetings in this phase. Binding until a later ADR
  supersedes it.

## Context

### What exists today

**CODE-VERIFIED.** DevFathom already ships a meetings feature. It is not a greenfield build.

- A `meetings` licensed module already exists and is seeded for every organization
  (`prisma/seed.ts:17`), mapped to the tRPC namespace, the REST scope domain, and the `/meetings`
  route (`src/lib/module-catalog.ts:28`, `:40-51`, `:57`), and rendered as a sidebar entry gated on
  that key (`src/components/layout/sidebar.tsx:81-87`).
- Persistence is three models: `Meeting`, `MeetingAttendee`, and `MeetingAttendanceLog`
  (`prisma/schema.prisma:1427-1492`).
- Scheduling, attendance, and reporting run through `meetingsRouter`
  (`src/server/routers/meetings.ts:10-552`), object-level authorization through
  `canAccessMeeting` / `canManageMeeting` (`src/lib/authz.ts:131-162`), a REST surface at
  `/api/v1/meetings` (`src/app/api/v1/meetings/route.ts:6-59`), an AI tool set
  (`src/lib/ai/tools/meetings.ts:51-618`), and two email templates carrying an optional `joinUrl`
  (`src/lib/email/templates.ts:422-491`).
- **Video calling today is JaaS — 8x8-hosted Jitsi — not self-hosted.** The server mints an RS256
  JaaS JWT scoped to `meeting-${meetingId}` with a two-hour expiry
  (`src/server/routers/meetings.ts:337-395`, room name at `:369`, `exp` at `:372`), the client
  loads `https://8x8.vc/${appId}/external_api.js` and constructs the embed against `8x8.vc`
  (`src/components/meetings/meeting-call.tsx:38`, `:138`), credentials are three environment
  variables (`.env.example:66-68`, documented at `docs/admin-platform/operations.md:87`), and the
  Content-Security-Policy hard-codes the 8x8 origins for `script-src`, `connect-src`, and
  `frame-src`, with `Permissions-Policy` delegating `camera`, `microphone`, and `display-capture`
  to `https://8x8.vc` (`next.config.ts:20-22`, `:40-41`, `:89`).

### What does not exist today

**CODE-VERIFIED.**

- **No occurrence table.** A recurring meeting is one `Meeting` row whose `recurrence` is one of
  four strings (`prisma/schema.prisma:1435`, enumerated at `src/server/routers/meetings.ts:115`).
  Every occurrence is _computed at read time_ by walking the pattern forward under an iteration cap
  (`src/lib/meeting-occurrence.ts:28-64`, `:75-128`, `:136-174`;
  `src/server/routers/meetings.ts:609-646`). There is no `MeetingOccurrence` model anywhere in
  `prisma/schema.prisma`, and therefore no row on which anything occurrence-scoped could be stored.
- **No guest.** Every attendance path is keyed on a `User` foreign key
  (`prisma/schema.prisma:1475`, `:1485`), so a person without a tenant `User` row cannot appear in
  attendance at all. There is no public join route: the only meeting routes are under the
  authenticated `(app)` group (`src/app/(app)/meetings/…`).
- **No inbound webhook surface.** The existing `webhooks` module is _outbound_ tenant delivery with
  a write-once signing secret (`src/server/routers/webhooks.ts:1-25`); there is no
  `src/app/api/**/webhook*` route in the repository.
- **No LiveKit anything.** No dependency, no environment variable, no infrastructure resource.
- **No request middleware.** There is no `src/middleware.ts`; host classification happens inside
  each route handler.

## Decisions

### D1 — Meetings becomes a first-class DevFathom product surface, not an embed

**DECISION.** DevFathom Meetings is a scheduled-meeting product with a browser join experience the
product owns end to end: the schedule, the link, the lobby, the in-call surface, the participant
roster, attendance evidence, and the record afterwards. The current JaaS embed is a hosted
third-party iframe; it is replaced, not wrapped. See ADR-005 decision 1 for why.

### D2 — Web only

**DECISION.** No native mobile application, no native mobile SDK, no app-store deliverable, in this
phase or in the phases this document scopes.

**In scope, explicitly, as part of the web product:** responsive browser joining on supported iOS
Safari and Android Chrome. A phone is a first-class join surface. The mobile browser layout is
subject to the same visual QA release gate as every other screen — 375px portrait among the required
viewports (`docs/design-system/DEVFATHOM-STUDIO.md`, section 12), and "no desktop-only
implementation" is already an explicit prohibition (section 10).

**Out of scope:** native background calling, native screen sharing, ReplayKit broadcast extensions,
Android `MediaProjection` foreground services, push-based call wake-up, and every platform-specific
capability that requires shipping a binary. Roughly a quarter of the external research report covers
this ground. **None of it is being built.** It is recorded here so that nobody reads the report and
starts on it.

### D3 — Two public URL shapes, both occurrence-scoped

**DECISION.** The join surface is:

- `https://www.devfathom.com/meet/<publicId>` — the shared platform host.
- `https://<company>.devfathom.com/meet/<publicId>` — an enterprise tenant host.

`<publicId>` identifies **one occurrence**, is globally unique, and is a locator rather than an
authorization. `MEET-004` specifies the resolution algorithm and why the identifier cannot live on
the series. The research report's `app.devfathom.com/m/{id}` shape is **not** adopted.

**CODE-VERIFIED** that these hosts are the real ones: production `tenantHost` is
`www.devfathom.com` (`infra/production.bicepparam:7`), staging is `staging.devfathom.com`
(`infra/staging.bicepparam:7`).

### D4 — The `meetings` entitlement key is reused, never duplicated

**DECISION.** The existing `meetings` module key gates the new product. No second gate, no
`meetings-video`, no `meetings-v2`. ADR-005 decision 7 states what the entitlement does and does not
control.

**CODE-VERIFIED constraint that shapes the implementation.** Module **selection** is namespace-based:
the licensed-module middleware derives its key from the _first dot-separated segment of the tRPC
path_ (`src/lib/module-catalog.ts:36-38`) and then rejects the whole call
(`src/server/trpc.ts:160-169`). **Enforcement**, though, is **procedure-builder-scoped**: that
middleware runs only where a builder composes it — `protectedProcedure`
(`src/server/trpc.ts:202-205`), `adminProcedure` (`:210-213`), `hrProcedure` (`:216-219`) and
`capabilityProcedure` (`:226`) — while `publicProcedure` is bare `t.procedure` with no middleware
(`:77`).

So the rule is **not** "anything that must survive a disabled module leaves the `meetings`
namespace". It is that **webhook ingestion is not a tRPC procedure at all**: the anonymous tRPC
transport admits an exact five-procedure allowlist routed by a `token` field
(`src/lib/auth/anonymous-access.ts:27-44`, `:103-135`) and cannot carry a signed provider event that
names a room, and raw-body signature verification has to happen before any body parsing. Ingestion is
a dedicated raw-body route handler; reconciliation is a platform job. See MEET-003 and ADR-005
decision 7.

### D5 — Launch topology is deliberately small

**DECISION.** Launch is: one LiveKit SFU, one TURN service, the existing application, and Postgres.
Deferred, with no work in this phase: Redis, the Egress worker, recording, transcription,
livestreaming, and any multi-node SFU. Both Redis and Egress appear in the research report's MVP
topology; both are **RESEARCH-RECOMMENDATION** and both are deferred.

### D6 — A permanent, reusable meeting room is a separate future feature

**DECISION.** Not in scope. Every link this product issues points at one occurrence with a bounded
lifetime. "Here is my permanent room" is a different product with a different threat model and needs
its own decision record.

## Glossary

Used consistently across all six documents. Where a term does not yet correspond to a table, that is
stated.

| Term            | Meaning                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Series**      | The scheduled thing a person creates. Today: a `Meeting` row (`prisma/schema.prisma:1427-1446`).                                                                                                   |
| **Occurrence**  | One dated instance of a series. Today: **computed, not stored** (`src/lib/meeting-occurrence.ts:75-128`). The proposed occurrence record is future work; ADR-005 decision 4 pins what it must own. |
| **Participant** | Anyone in the call, member or guest.                                                                                                                                                               |
| **Member**      | A participant holding a tenant `User` row and a session.                                                                                                                                           |
| **Guest**       | A participant with no `AuthenticationIdentity` and no `OrganizationMembership`, holding an occurrence-scoped access grant. ADR-005 decision 4.                                                     |
| **Public ID**   | The globally unique, occurrence-scoped locator in the join URL. Grants nothing. MEET-004.                                                                                                          |
| **Room name**   | The provider-side room identifier. Separately random per occurrence, never derivable from the public ID. Today it is `meeting-${meetingId}` — derivable — at `src/server/routers/meetings.ts:369`. |
| **Join token**  | The short-lived provider credential that actually admits a browser to media.                                                                                                                       |

## Non-goals for this phase

- No application code, schema change, migration, or infrastructure change. This phase writes
  documentation.
- No provider procurement, no Azure resource, no DNS, no federated credential.
- No commitment to a production region. ADR-005 decision 3 requires a benchmark first.

## Open Questions

1. **What happens to the existing JaaS integration during the transition?** The product cannot be
   without video between deleting the 8x8 embed and shipping the self-hosted one. Options: a
   feature-flagged cutover per organization; a hard cutover at a release boundary; or running both
   for one release. This is a delivery-plan decision and needs a human answer before MEET-01.
2. **Does an occurrence record get introduced by the meetings work, or by a separate scheduling
   change?** ADR-005 decision 4 makes an occurrence record a hard prerequisite for guests, and there
   is none today. The recurrence model is also thin — four fixed intervals, no end date, no
   exceptions, no per-occurrence overrides (`prisma/schema.prisma:1435`) — so materializing
   occurrences is a scheduling redesign, not a table addition. Needs sizing.
3. **Which browsers are "supported"?** D2 names iOS Safari and Android Chrome. The exact minimum
   versions, and what a user on an unsupported browser is shown, are unanswered.
4. **Is guest joining permitted at all for a given organization, or is it a per-tenant policy?** The
   entitlement gates the module; it does not currently express "members only". Product decision.
5. **Who owns the meetings surface operationally once it is self-hosted?** A dropped call has no
   retry (ADR-005 decision 8) and the pilot has no SLA. The on-call expectation is unstated.
