# Decision register

**Snapshot:** 2026-07-12

Statuses: **Accepted** — implemented and observable in current code/config; **Superseded** — replaced by a later decision; **Proposed** — target-state decision awaiting owner acceptance and implementation; **Open Decision** — a fork the business has not chosen yet.

Older decisions were reconstructed from code, comments, and history; they had no ADR at the time. New material decisions must use the template at the end.

## Accepted decisions (evidenced in code)

### D-001 · Modular monolith on Next.js App Router

- **Decision:** one Next.js 16 application holds UI, tRPC API, REST API, AI operator, and integrations; domain separation lives in routers/modules, not services.
- **Context:** single company, one team, broad feature surface.
- **Consequences:** minimal operational overhead; blast radius of a defect is the whole app; no service-level scaling.
- **Evidence:** `src/server/routers/_app.ts` (20 domains), [system architecture](../architecture/SYSTEM-ARCHITECTURE.md).

### D-002 · Single-tenant, single-company data model

- **Decision:** no organization/tenant key anywhere in the 60-model schema.
- **Consequences:** simpler queries and authorization; commercialization as SaaS would require a tenant boundary in every record, policy, channel, and token — effectively a re-architecture. See the strategic fork in [metrics and roadmap](../business/METRICS-ROADMAP.md).
- **Evidence:** `prisma/schema.prisma`.

### D-003 · tRPC for the browser, scoped REST for automation

- **Decision:** the authenticated UI uses typed tRPC (229 procedures); scripts and agents use a deliberately smaller token-authenticated REST surface (`/api/v1`, 16 route files) with its own scopes, throttles, and audit attribution.
- **Consequences:** end-to-end types internally; a stable, documentable external contract; two surfaces to keep authorized consistently.
- **Evidence:** `src/server/trpc.ts`, `src/lib/api-auth.ts`, [API and automation reference](../engineering/API-AUTOMATION-REFERENCE.md).

### D-004 · Managed realtime on Ably (supersedes self-hosted Socket.IO)

- **Decision:** browser realtime uses Ably capability-scoped 30-minute tokens; the server publishes after database writes; the earlier self-hosted Socket.IO relay was removed.
- **Consequences:** fits serverless hosting; vendor dependency; cleanup debt remains because `socket.io`, `socket.io-client`, `express`, and `cors` are still installed, and legacy socket variables remain in deployed Vercel environments. The sanitized local template and root README now describe Ably correctly.
- **Evidence:** `src/app/api/ably-token/route.ts`, `src/lib/realtime-emit.ts`; no `socket-server/` directory exists.

### D-005 · JWT sessions with `tokenVersion` revocation

- **Decision:** NextAuth JWT sessions (8-hour max age); claims refreshed from the database roughly every minute; `tokenVersion` bump revokes all sessions.
- **Consequences:** no session table to operate; revocation latency up to the refresh window; refresh currently **fails open** on database errors (risk R-020); direct routes (`/api/assistant`, `/api/ably-token`, `/api/upload`, `/api/files/[name]`) check session identity but not current account status (R-026).
- **Evidence:** `src/lib/auth.ts`.

### D-006 · Layered authorization: ABAC capabilities + object-level guards

- **Decision:** coarse default-deny capability policies (`src/lib/abac`) answer "may this class of user do this class of action"; separate relationship checks (`src/lib/authz.ts`, `src/server/authz.ts`, per-router checks) answer "may this user touch this record". Adding a capability never replaces the object check.
- **Consequences:** defense in depth across tRPC, REST, and assistant tools (all call the same `can()` decision point); rules are spread across large routers until services are extracted (R-019).
- **Evidence:** `src/lib/abac/policies.ts`, `src/server/trpc.ts`.

### D-007 · AI operator on Google Gemini via AI SDK 6 (supersedes Groq)

- **Decision:** `/api/assistant` streams Gemini (`GEMINI_MODEL`, default `gemini-2.5-flash`) with 96 domain tools selected by prompt hints, a 6-step limit, approval-gated writes, and mandatory re-authorization inside every tool `execute`. The approval card is explicitly UX, not a security boundary (invariant AI-04).
- **Consequences:** one provider dependency; Groq remains as a dead dependency and in two eval scripts; request/cost controls are absent (R-010).
- **Evidence:** `src/app/api/assistant/route.ts`, `src/lib/ai/tools.ts`.

### D-008 · Brevo for transactional email; provider-neutral mailbox adapters

- **Decision:** outbound product email goes through one Brevo sender/template layer; the connected-inbox feature has Gmail and Microsoft Graph adapters behind a common interface but is **disabled pending OAuth hardening** (state validation R-005, Microsoft ID-token verification R-025, and Vercel variables).
- **Evidence:** `src/lib/email/send.ts`, `src/lib/email/oauth.ts`, `src/lib/email/providers/`.

### D-009 · 8x8 JaaS for in-app video

- **Decision:** meetings are records in PostgreSQL; calls are JaaS rooms joined with server-signed 2-hour RS256 JWTs; attendance is logged per occurrence.
- **Evidence:** `src/server/routers/meetings.ts`, `src/components/meetings/meeting-call.tsx`.

### D-010 · Bun as package manager and script runner

- **Decision:** `bun.lock` is authoritative; scripts run through `bun`/`bunx`.
- **Consequences:** a stale `package-lock.json` remains tracked (R-013) and no `engines`/`packageManager` field pins versions — both pending cleanup.
- **Evidence:** `bun.lock`, `package.json`.

### D-011 · Vercel, single region `sin1`

- **Decision:** one Vercel project (`dev-fathom-hub`), Node 24.x, region `sin1`; `vercel.json` carries only the region.
- **Consequences:** compute near the team; single-region availability; serverless lifecycle makes local disk, in-memory throttles, and detached promises unreliable (R-001, R-011, R-029). The canonical alias currently points to an older Ready deployment while newer production-target builds exist (R-030; intent unresolved).
- **Evidence:** `vercel.json`, linked project inspection 2026-07-12.

## Proposed decisions (targets, not yet implemented)

| ID    | Decision                                                                                                                                               | Replaces                                               | Acceptance evidence                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| D-012 | Private object storage (Vercel Blob private or equivalent) for all uploads, with persisted ownership/ACL metadata                                      | Local `private-uploads/` filesystem                    | Upload→restart→download test passes in Preview; R-001 closed              |
| D-013 | Versioned Prisma migrations with `prisma migrate deploy` as the only production schema mechanism                                                       | `db push`                                              | Baseline migration committed; CI gate green; R-002 closed                 |
| D-014 | CI pipeline (typecheck, lint, tests, build, audit, migration check) required on a protected `main`                                                     | Manual releases                                        | First blocked-then-fixed PR demonstrates the gate; R-007 closed           |
| D-015 | Minimum observability stack: error tracking, structured logs, health endpoint, metrics, alerts                                                         | Log spelunking                                         | Synthetic failure alerts within 5 minutes; R-008 closed                   |
| D-016 | Durable queue/workflow for webhooks, audit writes, and scheduled jobs (overdue invoices, recurring expenses, contract expiry, resignation offboarding) | Fire-and-forget promises and operator-triggered sweeps | Delivery retries and scheduled runs evidenced; R-015, R-023, R-029 closed |
| D-017 | Distributed rate limiting (shared store or platform WAF) for REST, auth, and assistant                                                                 | Per-instance in-memory Map                             | Multi-instance test enforces one global policy; R-011 closed              |

## Open decisions

| ID     | Question                                                   | Fork                                                                                                                                    | Decision needed by                                                                                  |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OD-001 | Internal tool vs commercial SaaS                           | Staying internal keeps D-002; going commercial triggers tenant-boundary re-architecture, compliance program, and pricing/packaging work | Before any external-customer commitment — see [metrics and roadmap](../business/METRICS-ROADMAP.md) |
| OD-002 | Finance policy: base currency, FX source, budget semantics | Static `PKR 280/USD` display conversion and currency-mixed client revenue vs a signed accounting policy with a live FX source           | Before finance reports drive real decisions                                                         |
| OD-003 | Data retention and privacy program                         | Keep-everything status quo vs classified retention schedule with deletion/export                                                        | Before external diligence or headcount growth                                                       |
| OD-004 | MFA policy for privileged roles                            | Optional TOTP (current) vs mandatory MFA for ADMIN/HR with encrypted secrets                                                            | Security owner, near-term                                                                           |

## ADR template

```markdown
# ADR-NNN: <title>

- Status: Proposed | Accepted | Superseded by ADR-NNN
- Date: YYYY-MM-DD
- Deciders: <names>

## Context

<forces, constraints, and the problem — with evidence links>

## Decision

<the choice, stated as a full sentence>

## Alternatives considered

<options with the reason each was not chosen>

## Consequences

<positive, negative, and neutral outcomes; new risks and their register IDs>

## Evidence

<files, PRs, measurements, or deployment records that prove the decision is real>
```

Process: any change to an Accepted decision above, any new vendor, any authorization-model change, and any schema-lifecycle change requires an ADR in this file within the same PR ([maintenance contract](../README.md#documentation-maintenance-contract)).
