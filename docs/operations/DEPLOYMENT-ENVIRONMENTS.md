# Deployment and environments

**Snapshot:** 2026-07-12 · Vercel project `dev-fathom-hub`

## Topology (Verified)

- One Vercel project, Next.js preset, **Node.js 24.x**, single region **`sin1`** (`vercel.json` contains only `$schema` and `regions`).
- Build: `prisma generate && next build`; `postinstall` also runs `prisma generate`. No CI runs before Vercel builds — Vercel _is_ the pipeline today.
- Runtime: Vercel Functions (Fluid Compute era) — instances are recycled and multiplied at will, which is exactly why local disk (R-001), in-memory rate limits (R-011), and detached audit/webhook promises are unreliable here.
- Database: external PostgreSQL via `DATABASE_URL`; `pg.Pool` `max: 10` per instance. The aggregate connection budget across concurrent instances vs the provider cap is **unverified** — treat as an open item.
- Recent Production and Preview deployments were **Ready** on 2026-07-12; historical Production errors exist in the deployment list.

## Environments and variable parity

Inventory as inspected on 2026-07-12 — **names only, never values**. Full per-variable behavior in the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md).

| Variable group                                                             | Production       | Preview          | Development    | Consequence of the gap                                                                               |
| -------------------------------------------------------------------------- | ---------------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `AUTH_SECRET`                                              | ✅               | ✅               | ❌ (env empty) | Development env in Vercel is unusable as configured; local `.env` carries dev values                 |
| `ABLY_API_KEY`                                                             | ✅               | ✅               | ❌             | —                                                                                                    |
| Brevo (`BREVO_API_KEY`, sender vars)                                       | ✅               | ✅               | ❌             | —                                                                                                    |
| Gemini (`GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_MODEL`)                    | ✅               | ❌               | ❌             | **Assistant cannot be validated on Preview**                                                         |
| JaaS (`NEXT_PUBLIC_JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY`)           | ✅               | ❌               | ❌             | **Video cannot be validated on Preview**; note `NEXT_PUBLIC_JAAS_APP_ID` is inlined at build time    |
| Mailbox OAuth (`GOOGLE_OAUTH_*`, `MS_OAUTH_*`) + `EMAIL_TOKEN_ENC_KEY`     | ❌               | ❌               | ❌             | Connected-mailbox feature is configuration-disabled everywhere (intentional until R-005/R-025 close) |
| Legacy Socket.IO (`NEXT_PUBLIC_SOCKET_URL`, `FRONTEND_URL`, `SOCKET_PORT`) | present (legacy) | present (legacy) | ❌             | Dead — no code reads them; delete after D-004 cleanup                                                |
| Legacy Groq (`GROQ_API_KEY`, `GROQ_MODEL`)                                 | present (legacy) | present (legacy) | ❌             | App route does not read them; only local eval scripts do                                             |

**Verified inconsistency:** Production and Preview are not equivalent, and the Development environment has no variables at all. **Proposed:** make Preview a faithful copy of Production (separate credentials, same names), and add a CI/name-presence check so a missing variable fails before deploy rather than at runtime.

## Local development setup

1. `bun install`
2. `cp .env.example .env`, then fill real local values. The tracked example is sanitized and aligned with the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md); `.env` remains ignored. Minimum to boot: `DATABASE_URL`; add `AUTH_SECRET` for production-like auth, `ABLY_API_KEY` for realtime, and the Google AI key for the assistant.
3. `bun run db:generate && bun run db:push` (until migrations exist), optionally `bun run db:seed`.
4. `bun dev` → http://localhost:3000. There is no socket server to start, despite what the pre-atlas root README said.

Full setup detail: [engineering handbook](../engineering/ENGINEERING-HANDBOOK.md).

## Database changes across environments

**Current (Verified, unsafe):** schema changes reach databases via `prisma db push` from a developer machine. There is no migration history (`prisma.config.ts` points to `prisma/migrations`, which does not exist), no review artifact, and no gate between "worked locally" and "changed production."

**Target (Proposed — D-013, R-002):**

1. Baseline production once: `prisma migrate diff` → initial migration committed.
2. Every change thereafter: `prisma migrate dev` locally → SQL reviewed in the PR → applied to a staging/Preview database → `prisma migrate deploy` runs in CI **before** the app deploy promotes.
3. Expand/contract for anything destructive, so the previous app version stays compatible (this is what makes rollback safe).

Until then: treat every schema change as a small incident — take a backup point first, apply during low usage, and note it in the release record.

## Release flow

### Preview validation

Every push gets a Preview deployment. Before promoting: deployment **Ready**, smoke pass (login → dashboard → board → task move → chat message → invoice view), and — once parity is fixed — assistant and video checks. Checklist: [release checklist §2](../governance/RELEASE-CHECKLIST.md#2-preview-validation).

### Immutable promotion (Proposed discipline)

Promote the exact build you validated: `vercel promote <deployment-url>` (or dashboard → deployment → Promote to Production). Do **not** merge-and-rebuild between validation and production — a rebuild is a different artifact (new dependency resolution, new env snapshot).

### Canonical alias verification — confirmed drift, intent open

**Verified 2026-07-12:** `vercel inspect dev-fathom-hub.vercel.app` resolves the canonical alias to the Ready deployment created 2026-06-24. `vercel ls` lists newer Ready production-target deployments from 2026-07-10. This may be an intentional rollback, but no release record in the repository explains it. Do not change the alias without confirming intent.

After **every** promotion, verify:

```bash
vercel ls dev-fathom-hub          # newest production deployment
vercel inspect <canonical-alias>  # which deployment the alias serves
```

The two should match unless an explicit rollback/hold decision says otherwise. If they do not, record the reason and either retain the rollback target or deliberately use `vercel alias set <deployment-url> <canonical-alias>` after validation. Risk R-030 remains open until the current intent is recorded.

### Rollback / roll-forward

- **Rollback:** `vercel rollback` to the recorded previous deployment ID — instant, no rebuild. Only safe when the database schema still matches the older app (see runbook 2 for the `db push` caveat).
- **Roll-forward:** default stance for anything involving schema or data: fix, validate on Preview, promote.

## Durable storage and background work

The serverless lifecycle constraints that shape all target work here (all Verified as current gaps):

| Concern                                                                                         | Current mechanism                                                                                                                                                                                  | Why it fails on Vercel                                        | Target (Proposed)                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Uploads                                                                                         | Function-local `private-uploads/`                                                                                                                                                                  | Instance disk is ephemeral                                    | Private object storage (Vercel Blob private) with persisted ownership metadata — D-012    |
| Audit + webhook writes                                                                          | Detached fire-and-forget promises                                                                                                                                                                  | Instance may terminate after the response, dropping the write | Await critical writes in-request, or hand to a durable queue — D-016                      |
| Webhook delivery                                                                                | Single attempt, 5 s timeout                                                                                                                                                                        | No retry, no replay                                           | Queue with retries/dead-letter — D-016, R-023                                             |
| Scheduled jobs (overdue invoices, recurring expenses, contract expiry, resignation offboarding) | Operator-triggered tRPC procedures (`finance.markOverdueInvoices`, `finance.postDueRecurringExpenses`, `clients.sweepExpiredContracts`; future-dated resignation offboarding has **no** procedure) | Nothing schedules them; `vercel.json` has no `crons`          | Vercel Cron → thin authenticated route → existing procedures, idempotent, audited — R-015 |
| Rate limiting                                                                                   | In-memory Map per instance                                                                                                                                                                         | Resets per instance/deploy; not shared                        | Shared store (Redis/Upstash) or platform WAF rules — D-017, R-011                         |

## Secret rotation

Procedure and per-variable notes live in [runbooks §5](RUNBOOKS.md#5-secrets-rotation). Environment-management rules:

- Vercel environment variables are the store of record; values never enter the repository, documentation, or chat.
- Redeploy after any change — env is snapshotted per deployment (and `NEXT_PUBLIC_*` values are baked at build time).
- Rotation owner and cadence per variable: placeholders in the [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md) until assigned.

## Related documents

- [Runbooks](RUNBOOKS.md) · [Business continuity](BUSINESS-CONTINUITY.md) · [Release checklist](../governance/RELEASE-CHECKLIST.md) · [Environment catalogue](../reference/ENVIRONMENT-VARIABLES.md) · [Risk register](../executive/RISK-REGISTER.md)
