# Project status

**Internal · Confidential · Snapshot: 2026-07-12**  
**Branch:** `Design-1`  
**Purpose:** one current status page for leadership, engineering, product, operations, and diligence reviewers.

## Executive status

DevFathom Hub is a broad, functioning internal operations product with a coherent modular-monolith architecture and meaningful security controls. It is deployed and recent Production and Preview builds are Ready. It is appropriate for controlled internal use with hands-on ownership.

It is **not yet ready to be treated as a low-touch system of record or an externally assured SaaS product**. The primary gap is operating discipline rather than feature breadth: durable files, database migrations, restore evidence, automated tests, CI, monitoring, distributed limits, and several integration security controls remain incomplete.

The documentation program is now a complete decision atlas rather than a collection of historical notes. Proposals remain proposals until owners accept them and implementation evidence exists.

## Status legend

| State             | Meaning                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **Green**         | Implemented and verified, with no known release-blocking gap in the assessed scope         |
| **Amber**         | Useful and operating, but requires active ownership, limitations, or near-term remediation |
| **Red**           | Production blocker, material trust gap, or control that does not exist                     |
| **Open decision** | Leadership or a named owner must choose a policy; code cannot decide it                    |

## Current scorecard

| Area                             | Status               | Verified current state                                                                                                                 | Required next evidence                                                                |
| -------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Product breadth                  | **Green**            | Projects, clients, finance, people/HR, meetings, notes, chat, audit, REST, webhooks, and a 96-tool AI operator exist                   | Adoption and outcome evidence from a real pilot                                       |
| Architecture                     | **Amber/Green**      | Appropriate single-company modular monolith; 20 tRPC domains, 60 Prisma models                                                         | Reduce high-complexity hotspots after tests exist                                     |
| Authentication and authorization | **Amber**            | NextAuth JWT sessions, status gate in tRPC, ABAC, object-level guards, scoped API tokens, recovery codes                               | Close direct-route status gap, require privileged MFA, verify OAuth tokens/state      |
| Data integrity                   | **Red**              | Server-calculated invoice totals and Decimal money are strengths; no migration history or restore drill exists                         | Rebuild from migrations; dated restore report; signed finance semantics               |
| File handling                    | **Red**              | Authenticated local upload/download exists                                                                                             | Durable private object storage; ownership metadata; restart test                      |
| Realtime                         | **Amber/Green**      | Ably capability-scoped 30-minute tokens and server-only canonical publishing                                                           | Timeout monitoring and membership revocation tests                                    |
| AI operator                      | **Amber**            | Gemini, tool-domain selection, 6-step cap, 60 approval-gated tools, authorization inside writes                                        | Schema/body limit, distributed rate/cost controls, model evaluation and vendor policy |
| Email integration                | **Red/Disabled**     | Gmail and Graph adapters plus encrypted refresh-token design exist; variables intentionally absent                                     | Persist/consume OAuth state; verify Microsoft ID token; provider test suite           |
| Webhooks                         | **Red**              | Admin management, HMAC signing, timeout, and delivery records exist                                                                    | SSRF controls, durable queue, retries, replay, payload contract                       |
| Quality engineering              | **Red**              | TypeScript passes; lint currently fails; no automated tests or CI                                                                      | Green CI required by branch protection; critical-path test suite                      |
| Observability                    | **Red**              | Console/application logs and database audit rows only                                                                                  | Health/readiness, error tracking, metrics, alerts, SLOs, on-call ownership            |
| Deployment                       | **Amber**            | Vercel project in `sin1`, Node 24.x; recent Preview and Production builds Ready                                                        | Resolve canonical alias drift; Preview environment parity; release evidence           |
| Documentation                    | **Green/Developing** | Current atlas covers architecture, diligence, engineering, business, operations, governance, security, product, and reference material | Owners accept policies; quarterly evidence refresh                                    |

## Verified repository baseline

| Measure                     |   Result | Method                                                                    |
| --------------------------- | -------: | ------------------------------------------------------------------------- |
| TypeScript/TSX/Prisma lines |   69,221 | `wc -l` across `src`, `prisma`, and `scripts`, excluding generated Prisma |
| Prisma models / enums       |  60 / 23 | Exact declaration count in `prisma/schema.prisma`                         |
| tRPC domains / procedures   | 20 / 229 | `_app.ts` composition and `.query()`/`.mutation()` terminal count         |
| REST v1 route files         |       16 | `src/app/api/v1/**/route.ts`                                              |
| Assistant tools / factories |  96 / 10 | `tool({` declarations under `src/lib/ai/tools`                            |
| Approval-gated tools        |       60 | `needsApproval: true` properties in tool definitions                      |
| Automated test files        |        0 | Conventional test/spec filename scan                                      |
| CI workflows                |        0 | No `.github/workflows` or alternative CI configuration                    |
| Prisma migrations           |        0 | No checked-in `prisma/migrations` directory                               |

Resolved installed versions on this snapshot: Next.js `16.2.10`, React `19.2.7`, Prisma `7.8.0`, tRPC `11.17.0`, AI SDK `6.0.207`, and Base UI `1.5.0`. `package.json` uses compatible ranges for several of these; `bun.lock` is the resolved source.

Current quality result: `bunx tsc --noEmit` and `bun run build` pass; `bun run lint` remains red with 14 errors/6 warnings; `bun run format:check` reports 70 source files; `bun audit` remains red with 1 critical/2 moderate advisories.

## Live deployment status

Verified with the linked Vercel project on 2026-07-12; names only, never environment values:

- Project `dev-fathom-hub`, region `sin1`, Node.js 24.x.
- Latest listed Preview deployment: Ready.
- Two newer production-target deployments are Ready.
- The canonical `dev-fathom-hub.vercel.app` alias currently resolves to a Ready deployment created 2026-06-24, not the newest Ready production-target deployment.
- This may represent an intentional rollback, but no release record explains it. Do not move the alias automatically; leadership/platform must verify intent and record the decision.
- Production has Gemini and JaaS variables that Preview lacks.
- Mailbox OAuth and encryption variables are absent everywhere, so the connected-inbox feature remains configuration-disabled.
- Legacy Socket.IO and Groq variable names remain in deployed environments even though the application path uses Ably and Gemini.

## Workstream status

### Documentation and diligence

**Status: Green/closeout.** The atlas exists, links resolve, and secret-like values are excluded. Remaining work is owner acceptance, evidence refresh cadence, and keeping the atlas synchronized with implementation.

### UI redesign

**Status: Active, uncommitted.** The `Design-1` branch contains user-owned redesign changes in the dashboard, layout, navigation, brand, global styles, and cards. Documentation work must not overwrite or normalize those files. The redesign should be validated against [experience and accessibility](../product/EXPERIENCE-ACCESSIBILITY.md) before release.

### Production stabilization

**Status: Red/not started as a formal program.** The prioritized remediation order is durable storage, migrations/restore, OAuth and webhook security, CI/tests, observability, distributed limits, finance semantics, and durable scheduled work.

### Product validation

**Status: Open.** There is no repository evidence of a measured internal pilot, adoption funnel, time-to-value, coordination-time baseline, or signed product success metric. The recommended wedge and pilot are documented in [product strategy](../product/PRODUCT-STRATEGY.md).

## Release blockers

No external customer or system-of-record claim should be made while any of these remain open:

1. R-001 durable uploads.
2. R-002/R-003 migrations and tested recovery.
3. R-005/R-025 email OAuth callback and Microsoft token validation before enabling email.
4. R-006 webhook SSRF.
5. R-007/R-009 automated test/CI foundation and red lint gate.
6. R-008 observability and alerting.
7. R-010/R-011 assistant and distributed abuse/cost controls.
8. R-029 durable audit evidence for consequential operations.

## Immediate next program

| Window     | Objective                                 | Required exit evidence                                                                                          |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Days 0-30  | Make the system safe to rely on           | Durable files; migration baseline; backup owner; OAuth/webhook fixes; green CI; no critical dependency advisory |
| Days 31-60 | Make failure visible and recoverable      | Health/error/metric stack; alert test; restore drill; durable scheduled work and webhooks; distributed limits   |
| Days 61-90 | Make the system governable and measurable | Signed finance/data/MFA policies; product pilot results; security verification; owner-approved RACI and SLOs    |

## Decisions required from leadership

1. Confirm **internal-first** as the current product boundary or explicitly fund commercial multi-tenancy.
2. Name the accountable product, engineering, platform, security/privacy, finance, and people owners.
3. Select one internal team for the six-week delivery-attention pilot.
4. Approve the P0 stabilization sequence and capacity.
5. Decide whether the canonical production alias is intentionally rolled back or should be promoted to a newer validated build.
6. Approve or amend the proposed risk, privacy, continuity, MFA, and release policies.

## Integrity of this status

- **Verified** statements are tied to repository code/configuration or the 2026-07-12 linked-platform inspection.
- **Proposed** targets are not claims that controls exist.
- No commit or push is implied by this document.
- This is not a legal opinion, financial audit, penetration test, compliance certification, or uptime guarantee.

## Related documents

- [Executive brief](EXECUTIVE-BRIEF.md) · [Technical due diligence](TECHNICAL-DUE-DILIGENCE.md) · [Risk register](RISK-REGISTER.md) · [Diligence data-room index](DILIGENCE-DATA-ROOM-INDEX.md) · [Product strategy](../product/PRODUCT-STRATEGY.md) · [Ownership RACI](../governance/OWNERSHIP-RACI.md)
