# MEET-004: Join Flow and the Shared-Host Resolution Problem

Status: **Proposed**, 2026-08-03. Documentation only.

Markings — **CODE-VERIFIED**, **RESEARCH-RECOMMENDATION**, **DECISION** — are defined in
`000-product-scope.md`.

## The problem this document exists to solve

`https://www.devfathom.com/meet/<publicId>` is served on a host that **names no tenant**. Every
tenant-scoped query in DevFathom needs an organization id first — row-level security is keyed on
`app.current_organization_id` (ADR-001, `src/lib/tenancy/scoped-db.ts:107-124`) — and on the shared
host there is nothing in the request that supplies one. No session, no slug, no verified domain.

### Precisely what the code does, because the brief states it slightly wrong

The brief says _"`resolveOrganizationByHost` returns null by design"_ on `www.devfathom.com`. **It
does not.** There are two resolvers and only one of them returns null.

**CODE-VERIFIED — `resolveOrganizationByHost` (`src/lib/tenancy/host.ts:104-149`)** on
`www.devfathom.com`:

1. `classifyHost` finds `PLATFORM_BASE_DOMAIN` as a suffix and returns
   `{ kind: 'tenant', host: 'www.devfathom.com', slug: 'www' }`
   (`src/lib/tenancy/host-routing.ts:76-78`).
2. The slug lookup for `www` finds nothing — `www` is a reserved host label
   (`src/lib/tenancy/host-routing.ts:7-17`) and organization slugs are refused if reserved
   (`src/lib/platform/commands.ts:53-55`).
3. The verified-domain lookup misses (`src/lib/tenancy/host.ts:121-128`).
4. The deployment lookup is a **substring** match — `url: { contains: classified.host }`
   (`:130-134`).
5. It then **falls back to `DEFAULT_ORGANIZATION_ID`**, because `www.devfathom.com` is in
   `configuredDefaultHosts()` (`:136-145`). **CODE-VERIFIED** that it is: production `tenantHost` is
   `www.devfathom.com` (`infra/production.bicepparam:7`) and `NEXT_PUBLIC_APP_URL` is set to
   `https://${tenantHost}` (`infra/environment.bicep:368`), which
   `configuredDefaultHosts()` parses into that set (`src/lib/tenancy/host-routing.ts:39-61`).

So the permissive resolver does not fail — **it silently names one particular tenant**. That is worse
than returning null, because a route that trusted it would serve one organization's data to every
visitor on the shared host.

**CODE-VERIFIED — `resolveExplicitOrganizationByHost` (`src/lib/tenancy/host.ts:190-271`)** is the
resolver that returns null by design: after an exact slug match fails, a configured default or shared
host **stops there** (`:207-213`), specifically so the deployment lookup below cannot hand a shared
host to an arbitrary organization. Its deployment lookup is exact rather than substring
(`:58-67`, `:224-247`) and it **fails closed on ambiguity**, returning null and emitting a structured
warning when two organizations claim one host (`:249-267`). Its own documentation states the rule
callers must follow: _treat null as "no organization was named"_
(`src/lib/tenancy/host.ts:186-188`).

**The shared-host problem is therefore real, and it is what MEET-004 must solve.** The brief's
conclusion stands; only the function name was wrong, and the correct function's fallback is more
dangerous than "null", which is why the distinction is worth recording.

## Decisions

### D1 — The public ID lives on the occurrence, never on the series

**DECISION.** The identifier in a join URL identifies **one occurrence**.

Two independent reasons, either sufficient:

1. **A series-level identifier is an indefinitely reusable link.** **CODE-VERIFIED:** a recurring
   meeting has no end date — `recurrence` is one of four interval strings
   (`prisma/schema.prisma:1435`) and the occurrence walkers stop only at an iteration cap
   (`src/lib/meeting-occurrence.ts:41`, `:89`, `:150`; `src/server/routers/meetings.ts:621`). A link
   bound to the series is a link that works forever.
2. **A series-level identifier forces the application to guess.** **CODE-VERIFIED:** resolving "which
   occurrence does this person mean" is already a heuristic. `findRelevantOccurrence` returns the live
   occurrence if there is one, and otherwise deliberately keeps returning the most recent _past_
   occurrence until the next one begins (`src/lib/meeting-occurrence.ts:98-105`) — a documented
   correction (RT-10) for the list view jumping to the wrong instance. That heuristic is acceptable
   for a display label. It is not acceptable for deciding **which room to admit a guest to**.

This is also what makes MEET-001 T4 satisfiable: the occurrence record is the only place an
occurrence-scoped credential can live.

### D2 — Globally unique, and a random UUIDv4 is sufficient

**DECISION.** The public ID is **globally unique across all tenants**, because uniqueness is exactly
what lets the shared host resolve a tenant from the identifier alone. This is the same property the
existing anonymous flows rely on: `Invitation.tokenHash` and `PasswordResetToken.tokenHash` are
globally unique, so the token alone identifies exactly one row and therefore exactly one organization
(`src/lib/auth/anonymous-tenant.ts:6-23`).

**A cryptographically random UUIDv4 is sufficient. Do not introduce UUIDv7 or ULID infrastructure
solely for this.** Those formats buy index locality by encoding time in a sortable prefix; the join
identifier is looked up by equality, never scanned in order, and a time-ordered prefix would leak
creation time into a public URL. `crypto.randomUUID()` is in the standard library. Adding an id
library for one column is the kind of dependency ADR-005 decision 9 rejects elsewhere.

Note this is a **different** identifier from the record's primary key. Existing models use `cuid()`
(`prisma/schema.prisma:1427-1428`, `:1449`, `:1472`); primary keys stay as they are. The public ID is
an additional, uniquely-indexed column.

### D3 — It is a locator, not authorization

**DECISION.** Holding a public ID grants **nothing**. Resolution yields an organization id and,
inside that tenant's scope, an occurrence. It never yields a join token, never yields media access,
and never yields the participant roster. Admission is a separate act requiring either a session with
meeting access or a valid, unexpired, unrevoked guest credential. MEET-001 T1.

### D4 — Resolution is a narrow platform-scope lookup returning only an organization id

**DECISION.** Modelled directly on `organizationForAnonymousToken`
(`src/lib/auth/anonymous-tenant.ts:24-45`), which is the pattern this repository already reviewed and
accepted for exactly this problem. The properties that make it acceptable, all of which the join
lookup must reproduce:

- It runs in the platform scope **because the tenant is precisely what is being determined**
  (`:17-18`), not because the caller needs broad access.
- The **only predicate** is a value the caller must already hold.
- The **only column returned** is an organization id (`:35`, `:41`).
- Input is **bounded before the lookup** — a length check before hashing (`:29`). The join lookup's
  equivalent is a UUID-shape check before the query.
- **A caller without a valid value learns nothing.** The answer is null, and the response is
  identical to the one a real-but-unusable value produces (`:20-23`, and the fallback router at
  `src/server/routers/anonymous-fallback.ts:6-26`).

Everything after resolution runs inside `withTenantDb(organizationId, …)` under ordinary tenant RLS,
as the anonymous transport already does (`src/app/api/trpc/[trpc]/route.ts:44-64`). **The occurrence
is loaded in tenant scope, never in platform scope.**

The lifecycle rule applies too: a workspace that may not serve traffic is treated as **unroutable**
rather than as a distinct error, so its status stays unobservable without a session
(`src/app/api/trpc/[trpc]/route.ts:89-92`).

### D5 — The guest credential is separate, hashed, and occurrence-scoped

**DECISION.** The public ID is in the URL. The guest credential is **not**. It is presented
separately, stored hashed, scoped to the occurrence, and carries expiry, revocation, and a meeting
role. MEET-001 T2 and T4.

The consequence worth stating: **the join URL is safe to put in an email, a calendar invite, or a
chat message.** The existing meeting templates already carry a `joinUrl` into both HTML and plain
text (`src/lib/email/templates.ts:429`, `:448`, `:458`, `:480`, `:486`) — that field carries the
public ID only, and remains safe to render.

### D6 — The provider room name is separately random per occurrence

**DECISION.** A public link never reveals the room name. **CODE-VERIFIED** that today it would: the
room is `meeting-${input.meetingId}` (`src/server/routers/meetings.ts:369`), so anyone with a meeting
id has the room identifier. Under the new model the room name is generated independently per
occurrence and stored on the occurrence record; the adapter takes it from there and never derives it
(MEET-002 §1).

### D7 — On a tenant host, mismatch is a 404

**DECISION.** On `company.devfathom.com`, the host's organization is cross-checked against the public
ID's organization. **A mismatch is a 404 — never a redirect.** A redirect would confirm to a visitor
on company B's host that the occurrence belongs to some other named organization. The 404 is
byte-identical to the one an unknown public ID produces.

For the cross-check itself, the **strict** resolver is used
(`resolveExplicitOrganizationByHost`, `src/lib/tenancy/host.ts:190-271`) — never the permissive one,
whose default-tenant fallback (`:136-145`) would make the cross-check pass spuriously on any
configured default host.

### D8 — A permanent reusable room is a separate future feature

**DECISION.** Out of scope. Every link is occurrence-bound with a bounded lifetime.
(`000-product-scope.md` D6.)

## The flow

```
GET https://www.devfathom.com/meet/<publicId>
 │
 ├─ 1. Rate-limit BEFORE any database work.
 │      Precedent: src/app/api/trpc/[trpc]/route.ts:100-108 throttles before both the
 │      platform-scope token lookup and the tenant transaction, explicitly so an
 │      unauthenticated flood cannot drive either.
 │
 ├─ 2. Shape-check <publicId> as a UUID. Malformed → 404. Costs a regex, not a query.
 │
 ├─ 3. PLATFORM SCOPE: publicId → organizationId, and nothing else.
 │      Not found → 404, identical to every other 404 on this route.
 │      (Shape: src/lib/auth/anonymous-tenant.ts:24-45)
 │
 ├─ 4. Lifecycle check. Organization not serving traffic → unroutable → same 404.
 │      (Shape: src/app/api/trpc/[trpc]/route.ts:89-92)
 │
 ├─ 5. HOST CROSS-CHECK.
 │      Shared host (www / staging): no host-derived tenant is expected; continue.
 │      Tenant host: resolveExplicitOrganizationByHost(host) must equal the
 │      organization from step 3. Mismatch or null → 404. Never a redirect. [D7]
 │
 ├─ 6. TENANT SCOPE (withTenantDb): load the occurrence by publicId.
 │      Render the join page: title, scheduled time, organization branding, and a
 │      name field. NO roster, NO token, NO room name. [D3]
 │
 └─ 7. ADMISSION — a separate request, and the only step that grants anything.
        ├─ Member with a session and meeting access
        │     → object-level check (src/lib/authz.ts:146-162)
        │     → issueJoinCredential (MEET-002 §3)
        └─ Guest presenting an occurrence-scoped credential
              → hash, compare, check expiry / revocation / removal
              → issueJoinCredential with a short TTL, guest role, guest permissions
        Refused, for any reason → one generic message. [MEET-001 T5]
```

## What has to be built that does not exist

**CODE-VERIFIED.** Recorded so the size of this is not underestimated:

| Needed                                | Current state                                                                                                                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An occurrence record with a public ID | No `MeetingOccurrence` model. Occurrences are computed on read (`src/lib/meeting-occurrence.ts:75-128`).                                                                                                                                                  |
| A public route outside `(app)`        | Every meeting route is inside the authenticated group (`src/app/(app)/meetings/…`). There is no `src/middleware.ts`.                                                                                                                                      |
| Session-less procedures for join      | The anonymous allowlist is exactly five recovery procedures (`src/lib/auth/anonymous-access.ts:27-44`), and the transport routes by a token field literally named `token` (`:103-116`). Join needs its own explicit entries and its own routing evidence. |
| A guest grant record                  | Nothing guest-shaped exists. `MeetingAttendee` is unique on `(meetingId, userId)` — series-scoped and `User`-keyed (`prisma/schema.prisma:1461`).                                                                                                         |
| A join surface that is not an iframe  | The call surface is a JaaS embed (`src/components/meetings/meeting-call.tsx:138`), and the CSP is written for it (`next.config.ts:20-22`, `:40-41`, `:89`).                                                                                               |

## Design-system note

The join page is an **unauthenticated, first-impression, frequently-mobile** surface, so
`docs/design-system/DEVFATHOM-STUDIO.md` applies in full and section 7's _Authentication_ recipe is
the closest existing composition: the desktop split of a fixed ink brand panel plus a calm paper form
panel, collapsing on mobile to the form without losing the logo, product context, or spacing. Reuse
the existing semantic tokens and shared components; do not create a parallel visual vocabulary for
the guest path. Section 12's visual QA matrix — 375px through 1440px, light and dark, reduced motion,
keyboard, no horizontal overflow, no console errors — is a release gate for this route, and section
10's "no desktop-only implementation" is binding given that guests join from phones.

## Open Questions

1. **Where in the URL does the guest credential go, if not the path?** D5 forbids the URL. A form
   field on the join page is the obvious answer; a one-time exchange that sets an occurrence-scoped
   cookie is another. This is unresolved and it is the main open design question in the flow.
2. **What does a member without meeting access see?** `canAccessMeeting` admits creator, attendee, or
   ADMIN (`src/lib/authz.ts:146-162`). A signed-in colleague who is not an attendee currently gets
   `FORBIDDEN` (`src/server/routers/meetings.ts:204-207`). Do they get the guest path, a request-access
   flow, or the same 404?
3. **Does the join page show the meeting title before admission?** D3 permits it, and a calendar
   invite already discloses it. But on a public link it is disclosure to whoever holds the string.
   Product decision.
4. **How long before an occurrence, and how long after, does a link work?** An unbounded window makes
   the "occurrence-scoped" property weaker than it reads. Needs a number.
5. **Is the shared host `www.devfathom.com` the right place, given that `meet` is already a reserved
   label?** `meet` and `meet-staging` are reserved (`src/lib/tenancy/host-routing.ts:13-14`) and
   currently earmarked for the SFU. `meet.devfathom.com/<id>` versus
   `www.devfathom.com/meet/<id>` is an unforced choice that should be made once, deliberately —
   D3 of `000-product-scope.md` records the current answer.
6. **Where does the public ID live until an occurrence record exists? — ANSWERED by MEET-01 (PR #23),
   pending merge.** On the occurrence. `MeetingOccurrence.publicId` is globally unique and
   database-defaulted to `gen_random_uuid()`, because the shared public join URL carries no tenant
   context and the id must resolve exactly one organization before tenant scope is entered — the same
   role `Invitation.tokenHash` and `PasswordResetToken.tokenHash` already play. It is a **locator, not
   authorization**: holding it proves nothing, the credential lives on
   `MeetingOccurrenceParticipant`, and the media room name (`providerRoomName`) is independently
   random so a link holder cannot address the room directly and skip the lobby. It is deliberately
   not on the series, which would be an indefinitely reusable link. Open question 1 above — where the
   guest credential travels — is unaffected and still open.
