# Executive brief

**Internal · Confidential · 2026-07-12**

## What DevFathom Hub is

**Verified:** DevFathom Hub is a single-company internal operations platform. It combines project delivery, client management, finance, people operations, meetings, realtime chat, notes, internal automation, and an AI operator in one permission-aware system.

Its strategic value is consolidation: a user can move from a client contract to a project, board, task, time entry, invoice, payment, team workflow, note, or meeting without re-keying the same operating context across separate tools.

## What is materially differentiated

- **One operating graph:** the PostgreSQL model connects users, clients, contracts, projects, tasks, time, invoices, meetings, notes, and messages.
- **Three operating surfaces:** browser UI, scoped REST API, and a 96-tool AI operator all work over the same underlying records.
- **Permission awareness:** JWT-backed sessions, coarse ABAC capabilities, object-level guards, API scopes, channel membership, note sharing, and audit capture are layered rather than relying on UI hiding.
- **Internal workflow depth:** the system goes beyond a generic dashboard into recurring expenses, partial invoice payments, leave balances, resignations, reviews, message history, note revisions, meeting attendance, webhooks, and API attribution.
- **Managed realtime:** Ably capability-scoped tokens replace a self-hosted WebSocket relay for browser realtime traffic.

## Current maturity assessment

The product is feature-rich and deployable, but the delivery and operations system is materially less mature than the application feature set.

| Dimension                | Maturity                  | Executive interpretation                                                                      |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------- |
| Product capability       | Established               | Broad internal operating workflows are implemented.                                           |
| Application architecture | Established               | Coherent modular monolith with clear application, service, and data layers.                   |
| Security design          | Developing-to-established | Strong access-control intent and audit coverage, with specific unresolved gaps.               |
| Quality engineering      | Initial                   | Typecheck passes, but lint is red and automated tests/CI are absent.                          |
| Data operations          | Initial                   | Rich schema, but no checked-in migration history, backup contract, or restore drill.          |
| Platform operations      | Initial                   | Vercel deployment works; durable uploads, monitoring, SLOs, and incident process are missing. |
| Documentation/governance | Established/unapproved    | The atlas is complete; proposed policies still require named owner acceptance.                |

## Decisions required now

### P0 — before relying on the Hub as a system of record

1. **Move uploads to durable private object storage.** The current local filesystem path is unsuitable for Vercel and creates data-loss behavior after instance replacement.
2. **Establish versioned database migrations and backup/restore evidence.** A 60-model production schema without migration history is not safely reproducible.
3. **Fix the chat attachment contract.** The upload endpoint returns `/api/files/...`, while chat validation currently accepts only `/uploads/...`; chat and voice attachments are therefore rejected.
4. **Close mailbox OAuth validation.** Email OAuth creates a state nonce but does not persist/consume it, and Microsoft ID-token claims are decoded without cryptographic/claim verification.
5. **Restrict outbound webhook destinations.** Current validation accepts private, loopback, and redirecting HTTP(S) targets, which creates an SSRF path for an administrator or compromised admin session.
6. **Make revocation and audit consistent across direct routes.** Assistant, Ably, upload, and file routes need the current account-status guard; consequential audit writes need durable persistence.

### P1 — before scaling team reliance or external diligence

1. Add CI, a test harness, and a protected production branch.
2. Clear the lint baseline and prevent regression.
3. Add distributed rate limiting for REST, authentication, and assistant traffic.
4. Add application error tracking, structured logs, health checks, metrics, alerts, and a release dashboard.
5. Remove the second stale lockfile and standardize on Bun.
6. Resolve dependency advisories, starting with the critical `shell-quote` advisory inherited through `concurrently`.
7. Enforce Vercel environment parity/name validation and remove legacy deployed variable names; the tracked local template is now aligned.
8. Record whether the canonical production alias is intentionally held on the older Ready deployment or should move to a newer validated build.

## Business impact of the current risks

- **Data loss:** uploaded files are not durable in production.
- **Unrecoverable schema drift:** production can diverge from the repository without an auditable migration chain.
- **Silent outages:** failures may exist until a user reports them because there are no alerts or health checks.
- **Security exposure:** OAuth CSRF, webhook SSRF, and per-instance throttling weaken otherwise strong application controls.
- **Delivery uncertainty:** no automated regression suite or CI gate means release confidence depends on manual verification.
- **Onboarding friction reduced:** a sanitized `.env.example` and corrected root README now exist, but deployed Preview/Development environments still lack required names.

## Recommended 30/60/90-day program

### Days 0–30: make the system safe to operate

- Durable private Blob storage with authenticated delivery and ownership checks.
- Prisma migration baseline, automated `migrate deploy`, and verified database backup ownership.
- Fix attachment URL contract, OAuth state verification, and webhook SSRF controls.
- Clear dependency advisories and remove the stale lockfile.
- Add CI with typecheck, lint, build, security audit, and an initial critical-path test suite.

### Days 31–60: make the system observable and recoverable

- Error tracking, structured request logs, service health endpoints, and alerts.
- Restore drill with measured RPO/RTO.
- Distributed rate limits and assistant payload/cost controls.
- Production and Preview environment parity audit.
- Automated contract, invoice-overdue, recurring-expense, and resignation-offboarding jobs.

### Days 61–90: make the system governable and optimizable

- Expand integration, authorization, finance, and AI-tool tests.
- Establish data retention/privacy policies and vendor register ownership.
- Add product adoption and workflow-outcome metrics.
- Break the highest-complexity assistant tool factories into smaller domain services.
- Run an ASVS-aligned security verification and an incident tabletop.

## Explicit boundary

This report is a repository and platform-readiness assessment, not a financial audit, legal opinion, penetration test, privacy certification, or availability guarantee. Unsupported claims are marked as proposals or open questions throughout the atlas.
