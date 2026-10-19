# Technical due diligence

**Assessment date:** 2026-07-12  
**Scope:** application source, schema, configuration, linked Vercel project metadata, deployment/environment inventory, and local quality/security checks  
**Method:** codebase knowledge graph, targeted source review, live CLI checks, dependency audit, and comparison against official platform guidance

## Executive conclusion

DevFathom Hub is a substantial modular monolith with unusually broad internal-operations coverage. The architecture is coherent and modern: Next.js App Router, tRPC, Prisma/PostgreSQL, NextAuth, Ably, an AI SDK operator, and explicit authorization/audit layers.

The primary diligence concern is not feature completeness. It is the mismatch between application ambition and production discipline. Tests, CI, migrations, durable uploads, backups, monitoring, and incident ownership are absent or incomplete. Several high-impact integration and security defects are also confirmed.

**Overall posture:** suitable for controlled internal use with active owner involvement; not yet suitable to be treated as a low-touch, compliance-reliant, or externally assured system of record.

## Scope and evidence

### Verified repository facts

- 69,221 TypeScript/TSX/Prisma lines excluding generated Prisma client output.
- 60 Prisma models and 23 enums.
- 20 tRPC domains composed in `src/server/routers/_app.ts`; 229 procedure declarations.
- 16 REST API route files under `src/app/api/v1`.
- 96 AI tools across 10 domain factories; exactly 60 tool definitions declare `needsApproval: true` (anchored property count, excluding comments/usages).
- No test files matching conventional test/spec names.
- No `test` package script.
- No GitHub Actions workflows.
- No checked-in `prisma/migrations` history.
- Two tracked lockfiles: current `bun.lock` and a stale `package-lock.json`.

### Live evidence on 2026-07-12

- `bunx tsc --noEmit`: passed.
- `bun run build`: passed; Prisma 7.8.0 generated successfully and Next.js 16.2.10 completed the production build.
- `bun run lint`: failed with 14 errors and 6 warnings.
- `bun run format:check`: failed; Prettier reported 70 source files.
- `bun audit`: 3 advisories — 1 critical (`shell-quote`) and 2 moderate (`@hono/node-server`, `postcss`).
- Linked Vercel project: `dev-fathom-hub`, Node.js 24.x, Next.js preset, region `sin1`.
- Recent Production and Preview deployments: Ready; historical Production errors also exist.
- Vercel Development environment: no variables configured.
- Production and Preview environment inventories are not equivalent.
- The canonical production alias resolves to a Ready deployment created 2026-06-24, while newer Ready production-target deployments exist; release intent is undocumented.

## Architecture assessment

### Strengths

1. **Appropriate modular-monolith shape.** A single deployment and database match the current single-company scope while domain routers preserve separation.
2. **End-to-end type flow.** tRPC and SuperJSON provide typed UI-to-server calls; Prisma provides typed persistence.
3. **Clear security layers.** Authentication, account status, ABAC, object-level authorization, REST scopes, and audit middleware are separately represented.
4. **Managed realtime design.** Ably client tokens carry a verified `clientId` and narrow channel capabilities.
5. **Extensible automation model.** REST tokens, webhooks, and assistant tools enable three controlled automation channels.
6. **Server/client performance intent.** Heavy assistant/command components are dynamically loaded, dashboards issue parallel queries, and virtualized long lists exist.

### Concerns

1. **Large domain files and tool factories.** `buildTasksTools` is roughly 1,015 lines with high cognitive/cyclomatic complexity; several routers/components are similarly large.
2. **Mixed current and legacy dependencies.** Socket.IO, Express, `jsonwebtoken`, and `concurrently` remain installed despite Ably/Next.js being the current path.
3. **No formal service boundary tests.** The same database and codebase simplify delivery but increase blast radius without regression tests.
4. **Documentation drift.** Root README/environment/security documents describe behaviors that no longer match current code or platform configuration.

## Application security assessment

### Verified controls

- Credentials authentication through NextAuth with bcrypt password verification.
- JWT session claims periodically refreshed from the database; `tokenVersion` supports global session revocation.
- Active statuses explicitly allow `ACTIVE` and `ON_LEAVE`.
- 2FA enrollment, confirmation, recovery codes, and disable flow.
- API tokens are random, prefixed, bcrypt-hashed, scope-bound, user-bound, expirable, and activity-tracked.
- Finance REST routes require both scope and an admin-bound token.
- ABAC policies default-deny and are combined with object-level guards.
- Audit records cover tRPC mutations, sensitive reads, REST calls, and authentication events, with sensitive-field redaction.
- Security headers include CSP, HSTS, frame denial, nosniff, referrer policy, and permissions policy.
- Upload types/extensions are allowlisted; file names are normalized; chat downloads re-check channel membership.
- Email refresh tokens are designed for AES-256-GCM encryption at rest.
- Ably tokens are short-lived and membership-scoped; clients cannot publish persisted chat events.

### Confirmed gaps

1. **Email OAuth state is not verified.** `connectStart` creates and returns a nonce, but callback input contains only provider/code and no stored expected state. Risk: login CSRF/account-linking confusion when email is enabled.
2. **Webhook SSRF controls are insufficient.** Admin URLs accept any HTTP(S) host, redirects are followed by default, and private/loopback/link-local targets are not blocked.
3. **Rate limiting is process-local.** An in-memory map does not enforce a global limit across Vercel instances or regions.
4. **Assistant endpoint has no explicit request schema, size limit, rate limit, or user cost quota.** It reads arbitrary JSON and may run up to six model/tool steps.
5. **Session role/status refresh fails open on database errors.** This supports availability, but temporarily preserves stale privileges during a database outage.
6. **No CSP nonce.** Production still permits inline scripts; comments identify this as temporary.
7. **No independent penetration-test evidence.** Historical `SECURITY.md` is a remediation report, not a current external assurance.
8. **Microsoft mailbox ID tokens are decoded, not verified.** Signature, issuer, audience, expiry, and nonce are not validated before claims are trusted.
9. **Direct session routes do not enforce current active status.** Assistant, Ably-token, upload, and file routes require a session identity but do not run the tRPC `assertActive` gate.
10. **Audit evidence is not durable.** REST and other audit writes include detached promises that may be lost when serverless execution ends.

Reference baseline: [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/).

## Data and persistence assessment

### Strengths

- Relational model captures key business links and uses cascade/set-null behavior intentionally.
- Money uses database decimal types; supported currencies are explicit (`USD`, `PKR`).
- API tokens, invitation tokens, reset tokens, and recovery codes are stored as hashes.
- Note revisions, message edit history, meeting attendance occurrences, activity, and granular audit records preserve operational history.
- Key query fields have indexes across audit, messages, tasks, meetings, finance, notifications, and memberships.

### High-risk gaps

1. **No migration history.** `prisma.config.ts` points to `prisma/migrations`, but none is checked in; repository scripts encourage `db push`. Production schema changes are not reproducible or reviewable.
2. **No documented backup/restore contract.** Database-provider backups, retention, ownership, encryption, and restore tests are not captured.
3. **Local file storage is nondurable on Vercel.** `private-uploads` is outside the database and has no replication/backup lifecycle.
4. **No data classification or retention policy.** The system stores personnel, performance, finance, email, chat, meeting, client, and audit data without a formal lifecycle.
5. **Single-tenant by design.** There is no organization/tenant key. This is appropriate for internal use, but material if commercial multi-tenancy is contemplated.

Prisma documents migration history as the mechanism for versioning and deploying schema changes; production adoption should use automated `prisma migrate deploy`, not ad-hoc local `db push`: [Prisma Migrate](https://docs.prisma.io/docs/orm/prisma-migrate).

## Reliability and operations assessment

### Current state

- Vercel deploys a Next.js modular monolith in `sin1` with Node 24.x.
- PostgreSQL is reached through `pg.Pool` and Prisma's PostgreSQL adapter, with a per-instance maximum pool size of 10.
- The app has graceful feature degradation for missing Ably or email providers in some paths.
- Webhook delivery has a five-second timeout and delivery-history rows.
- There is no application health endpoint, readiness probe, external uptime monitor, error tracker, metric pipeline, alert routing, on-call schedule, incident template, or SLO.
- Contract expiry, invoice overdue, recurring expense posting, and resignation offboarding have operator-triggered or unwired scheduled-job paths rather than a deployed automation schedule.

### Live production observations

- Recent Production and Preview deployments were Ready.
- Production runtime inspection surfaced repeated PostgreSQL SSL-mode warnings and an Ably timeout group; these are signals, not a full availability assessment.
- A historical production deployment failed, but later Ready deployments demonstrate recovery rather than root-cause closure.

### Recommendation

Adopt a minimum operational stack: structured logs with request IDs, error tracking, route/service metrics, database saturation metrics, external uptime checks, alert policies, deployment annotations, health endpoints, and quarterly restore/incident drills.

## SDLC and quality assessment

### Verified baseline

| Control                      | Current state         |
| ---------------------------- | --------------------- |
| TypeScript                   | Passing               |
| ESLint                       | 14 errors, 6 warnings |
| Prettier source check        | 70 files red          |
| Unit tests                   | None found            |
| Integration tests            | None found            |
| End-to-end tests             | None found            |
| CI                           | None found            |
| Migration gate               | None                  |
| Dependency audit             | Manual; currently red |
| Branch protections           | Not assessed          |
| Automated preview smoke test | None found            |

### Lint failure groups

- synchronous state updates inside effects;
- impure `Date.now()` during render;
- React Compiler memoization/dependency conflicts;
- ref access during render;
- a missing hook dependency;
- an unescaped entity and smaller unused/no-expression warnings.

### Recommendation

Make lint/typecheck/build/tests/audit mandatory in CI. Establish a small critical-path suite first: login/session revocation, authorization/IDOR, project-task lifecycle, invoice-payment integrity, leave approval, note visibility, chat membership, assistant write authorization, REST scopes, and webhook validation.

## Dependency and supply-chain assessment

### Confirmed advisories from `bun audit`

| Severity | Package/path                                    | Advisory              |
| -------- | ----------------------------------------------- | --------------------- |
| Critical | `concurrently` → `shell-quote`                  | `GHSA-w7jw-789q-3m8p` |
| Moderate | `shadcn`/`prisma` tooling → `@hono/node-server` | `GHSA-92pp-h63x-v22m` |
| Moderate | Next/Tailwind/shadcn toolchain → `postcss`      | `GHSA-qx2v-qp2m-jg93` |

The critical path is through a dev dependency that appears unnecessary now that `dev` runs only `next dev`; remove or upgrade it. Re-run the audit after lockfile consolidation.

### Lockfile risk

`bun.lock` reflects the current package manifest. `package-lock.json` remains tracked with older Next/React versions and a different Prisma version. This makes installation behavior package-manager-dependent and confuses automated scanners. Standardize on Bun and remove/regenerate the alternate lockfile deliberately.

## Vendor and integration assessment

| Vendor/system              | Purpose                        | Data/control sensitivity                              | Current concern                                            |
| -------------------------- | ------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------- |
| Vercel                     | Hosting/functions/deployments  | Application code, runtime logs, environment variables | Monitoring and durable storage incomplete                  |
| PostgreSQL provider        | Primary system of record       | All operational data                                  | Backup/restore and migration contract undocumented         |
| Ably                       | Realtime events/presence       | User IDs, channel events, presence                    | Preview/production configured; monitor timeouts            |
| Google AI                  | Assistant model                | User prompts and selected business data               | No explicit cost/rate/retention governance in repo         |
| Groq                       | Legacy/alternate AI dependency | Potential prompt/business data                        | Installed/configured but not the active route              |
| Brevo                      | Transactional email            | Names, email addresses, business events               | Delivery/bounce monitoring not documented                  |
| Google Gmail API           | Connected inbox                | Mail metadata/content and refresh tokens              | Not configured in Vercel; OAuth state gap                  |
| Microsoft Graph            | Connected inbox                | Mail metadata/content and refresh tokens              | Not configured; OAuth state and ID-token verification gaps |
| 8x8 JaaS                   | In-app video                   | Meeting identity, media session metadata              | Preview environment lacks variables                        |
| Outbound webhook receivers | Internal automation            | Selected event payloads                               | SSRF, retry, and delivery-governance gaps                  |

Vendor DPAs, subprocessors, retention, data residency, breach notification, key ownership, and offboarding are **not evidenced** in the repository.

## Production blockers and remediation order

1. Durable private upload storage and attachment contract fix.
2. Database migration baseline plus backup/restore ownership.
3. OAuth state and Microsoft ID-token verification, webhook SSRF protection, and direct-route status enforcement.
4. Durable audit/outbound work plus CI/test foundation and lint cleanup.
5. Distributed throttling and assistant request/cost controls.
6. Observability, alerts, health checks, incident ownership, and a recorded canonical-alias decision.
7. Dependency/lockfile cleanup.
8. Vercel environment parity and legacy-variable removal (the tracked local template is aligned).
9. Approved data classification, retention, privacy, and vendor governance.
10. Scheduled operational jobs and documented finance/operational reconciliation.

## External references used

- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Vercel private Blob storage](https://vercel.com/docs/vercel-blob/private-storage)
- [Prisma Migrate](https://docs.prisma.io/docs/orm/prisma-migrate)
- [Ably token authentication](https://ably.com/docs/auth/token?lang=javascript)
- [Ably capabilities](https://ably.com/docs/auth/capabilities)
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)
- [NIST Secure Software Development Framework](https://csrc.nist.gov/pubs/sp/800/218/final)
- [NIST Privacy Framework](https://www.nist.gov/privacy-framework/privacy-framework)

## Related documents

- [Project status](PROJECT-STATUS.md) · [Diligence data-room index](DILIGENCE-DATA-ROOM-INDEX.md) · [Risk register](RISK-REGISTER.md) · [Threat model](../architecture/THREAT-MODEL.md) · [Ownership RACI](../governance/OWNERSHIP-RACI.md)
