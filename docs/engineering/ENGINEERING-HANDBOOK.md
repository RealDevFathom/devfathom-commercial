# Engineering handbook

**Snapshot:** 2026-07-12 · branch `Design-1`  
**Audience:** anyone writing or reviewing code in this repository.

> **Read `AGENTS.md` first.** This is not a stock Next.js app: it runs Next.js 16, React 19, and Prisma 7, whose APIs differ from older training data. The project instruction is to consult the relevant guide in `node_modules/next/dist/docs/` before writing framework code, and to heed deprecation notices.

## Local setup with Bun

**Verified** commands. Bun is the package manager and script runner.

```bash
bun install                         # installs deps; postinstall runs `prisma generate`
cp .env.example .env               # fill real local values; never commit .env
bun run db:generate                 # prisma generate (also part of build)
bun run db:push                     # sync schema to your database (no migrations exist — see below)
bun run db:seed                     # optional demo data (needs SEED_PASSWORD or ADMIN_PASSWORD)
bun dev                             # next dev on http://localhost:3000
```

There is **no socket server** to start — realtime is Ably. Any instruction (including the pre-atlas root README) to run a socket process is stale.

Minimum `.env` to boot: `DATABASE_URL`. Add `AUTH_SECRET` for production-like auth, `ABLY_API_KEY` for realtime, and the Gemini key for the assistant. The tracked `.env.example` contains placeholders only. Full variable list, consumers, and failure behavior: [environment catalogue](../reference/ENVIRONMENT-VARIABLES.md).

Useful scripts (`package.json`): `bun run lint`, `bun run format`, `bun run db:studio`, `bunx tsc --noEmit`, `bun run build`, `bun audit`.

## Repository structure

```
src/
  app/
    (app)/            authenticated workspace — one folder per module, each with a *-content.tsx client island
    api/
      trpc/[trpc]/    tRPC fetch handler
      v1/             REST API (token-authenticated) — see the API reference
      assistant/      AI operator route
      ably-token/     realtime token issuer
      upload/, files/[name]/   file upload + authenticated download
      auth/[...nextauth]/      NextAuth
    login/, invite/[token]/, forgot-password/, reset-password/[token]/, brand/   public routes
  components/         UI: brand, layout (shell/sidebar/topbar), chat, meetings, assistant, ui/ (shadcn on @base-ui/react)
  server/
    routers/          20 tRPC domains across 22 files (+ _app.ts composition, chat-helpers.ts)
    trpc.ts           context, procedure variants, middleware
    audit.ts          audit recorders (tRPC + REST)
    authz.ts          object-level authorization helpers
  lib/
    auth.ts           NextAuth config + JWT callbacks
    db.ts             pg.Pool + Prisma client
    abac/             capability policies (default-deny)
    authz.ts          resource authorization helpers
    api-auth.ts       REST token auth (withApiAuth), scopes, rate-limit application
    rate-limit.ts     in-memory fixed-window limiter (per instance)
    ai/               assistant prompt, tool selection, 10 tool-factory files
    email/            Brevo send, templates, OAuth adapters (Gmail/Graph), crypto
    webhooks.ts       emitEvent + delivery
    notifications.ts  in-app notification fan-out with per-user prefs
  generated/prisma/   generated Prisma client (git-ignored)
prisma/
  schema.prisma       60 models, 23 enums
  seed.ts, seed-demo.ts, bootstrap.ts, create-admin.ts, reset-admin-password.ts, backfill-attendance-log.ts
```

## Server / client boundaries

- **Route shells are Server Components.** Interactive screens are client islands named `*-content.tsx`, dynamically imported where heavy (assistant, command palette).
- **`src/proxy.ts` is a redirect gate only** — it checks for a session cookie's presence and nothing more. It is **not** a security boundary. The real gate is the authenticated layout (`src/app/(app)/layout.tsx`) and, for every data operation, the tRPC/REST middleware. Never rely on the proxy or on UI hiding for authorization.
- Secrets and vendor keys stay server-side. Only `NEXT_PUBLIC_*` values reach the browser (currently just the JaaS app id and the public app URL).

## Conventions

### tRPC

**Verified** (`src/server/trpc.ts`). Pick the procedure variant by the authorization it implies:

| Variant                       | Guarantees                                           | Use for                                  |
| ----------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `publicProcedure`             | none                                                 | login-adjacent, invitation/reset lookups |
| `protectedProcedure`          | active user (`ACTIVE`/`ON_LEAVE`), mutations audited | most authenticated actions               |
| `adminProcedure`              | `admin:access` capability, all calls audited         | finance, audit, tokens, webhooks         |
| `hrProcedure`                 | `hr:access` capability                               | HR console, leave approval, resignations |
| `capabilityProcedure(action)` | a specific ABAC capability                           | `leave:approve`, `resignation:*`, etc.   |

Middleware order (audit is deliberately **outermost**, so even denied attempts are recorded): audit → session check → `assertActive` (status gate) → ABAC `can()`. **The capability check is not the end of authorization** — inside the resolver, load the resource and call `can()` again with the resource's attributes, or use a helper from `src/server/authz.ts` / `src/lib/authz.ts` (e.g. `assertChannelMember`, `canAccessProject`, `canManageProject`). A role answers "may this kind of user do this kind of thing"; a relationship answers "may this user touch this record". Both are required.

Enrich audit detail from a resolver with `annotateAudit(ctx, …)`.

### Prisma

- The client is generated into `src/generated/prisma` (git-ignored); run `bun run db:generate` after schema edits.
- Money is `Decimal` (usually `Decimal(12,2)`); currency is an explicit `USD`/`PKR` enum on records that carry it. Never do money math in floats — recompute server-side (see invoices).
- Use cascade/`SetNull` deliberately: containment cascades; historically-meaningful links use `SetNull` (audit actor, client/project links).

### Auth and realtime

- JWT claims (role/status/`tokenVersion`) refresh from the DB ~every minute. Bump `tokenVersion` to revoke sessions (password change, admin reset, layoff, sign-out-everywhere).
- **Known gap to respect:** the direct routes `/api/assistant`, `/api/ably-token`, `/api/upload`, `/api/files/[name]` check session identity but not current account status. Do not add new privileged direct routes without an explicit status check.
- Realtime: the browser never sees `ABLY_API_KEY`. The token route issues 30-minute capability-scoped tokens whose `clientId` is the verified user id. Clients subscribe to persisted channels; the **server** publishes after DB writes.

### AI tools

Every write tool must (1) declare `needsApproval: true`, and (2) **re-authorize inside `execute`** via `h.can(...)` — the approval card is not a security boundary (invariant AI-04). Follow the existing factories in `src/lib/ai/tools/`. Zod tool params must use `.nullish()` (not `.optional()`) and avoid `format`/`.email()` keywords — a portability constraint inherited from the earlier Groq provider, preserved in comments.

### Style

Match the surrounding code. Comments state constraints the code cannot show, not narration. `@base-ui/react` primitives supply accessibility behavior — don't hand-roll focus/ARIA when a primitive exists. Semantic design tokens define color (see the design specs under `docs/superpowers/`); there is an active UI redesign on this branch — preserve it.

## Database-change workflow

**Current (Verified, unsafe):** schema changes are applied with `prisma db push`; there is **no migration history** (`prisma.config.ts` points at `prisma/migrations`, which does not exist). This means production schema changes are not reviewable, reproducible, or cleanly reversible (risk R-002).

**Until migrations exist**, treat every schema change as elevated risk:

1. Confirm a database backup point before touching a shared environment.
2. `bun run db:push` against your local database; verify.
3. Apply to a staging/Preview database before production; never `db push` straight to production during traffic.
4. Note the change in the release record.

**Target workflow (Proposed — D-013):** baseline once, then `prisma migrate dev` locally → review the SQL in the PR → `prisma migrate deploy` in CI before the app promotes, using expand/contract for anything destructive so rollback stays safe. Detail: [data architecture](../architecture/DATA-ARCHITECTURE.md#proposed-migration-workflow) and [deployment](../operations/DEPLOYMENT-ENVIRONMENTS.md#database-changes-across-environments).

## Safe-change workflow

1. Branch from `main` (or the active feature branch); never commit to `main` directly.
2. Read every file before editing it. For code discovery, prefer the codebase-memory tools, then Grep/Read.
3. Make the change; keep the diff scoped. If it touches a business rule, integration, env var, API contract, or operational dependency, update the matching doc in the **same** PR ([maintenance contract](../README.md#documentation-maintenance-contract)).
4. `bunx tsc --noEmit`, `bun run lint`, `bun run format:check` locally. Add no new lint errors — the 14 existing ones are a documented baseline ([quality and performance](QUALITY-PERFORMANCE.md)), not a licence to add more.
5. Verify behavior by exercising the flow, not just typechecking (there are no automated tests yet).
6. Push; validate on the Vercel Preview; walk the [release checklist](../governance/RELEASE-CHECKLIST.md).
7. Record any material architecture decision in the [decision register](../governance/DECISION-REGISTER.md).

## Troubleshooting

| Symptom                                               | Likely cause                                                                                         | Check                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Assistant returns an apology / 500                    | `GOOGLE_GENERATIVE_AI_API_KEY` missing (silent — never named in code) or invalid `GEMINI_MODEL`      | Env presence; Google AI status                                                  |
| Chat/voice attachment fails: "Invalid attachment URL" | **Known bug (R-004):** upload returns `/api/files/…`, `chat.sendMessage` still requires `/uploads/…` | `src/server/routers/chat.ts` sendMessage guard vs `src/app/api/upload/route.ts` |
| Realtime frozen; `/api/ably-token` returns 503        | `ABLY_API_KEY` not configured (503) vs Ably outage                                                   | Env presence; Ably status                                                       |
| Uploaded files 404 after a deploy                     | **Expected (R-001):** function-local storage is wiped on instance recycle                            | `src/app/api/upload/route.ts` writes to `private-uploads/`                      |
| Video: "Video calling is not configured"              | JaaS vars missing                                                                                    | `NEXT_PUBLIC_JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY`                       |
| `AUTH_SECRET is required in production` at boot       | Missing in a production build                                                                        | Env presence                                                                    |
| Repeated PostgreSQL SSL-mode warnings in logs         | TLS mode in `DATABASE_URL` should use full cert/hostname verification                                | Connection string sslmode                                                       |
| Emails not arriving                                   | Brevo key/sender missing or vendor issue; in-app record still created                                | Env; Brevo dashboard                                                            |
| Lint fails on a file you didn't touch                 | Pre-existing baseline (14 errors)                                                                    | [quality and performance](QUALITY-PERFORMANCE.md) inventory                     |

## Explicit current limitations

Know these before you build on top of the system (all Verified; each links to a risk):

1. **No automated tests, no CI** — verify behavior manually (R-007).
2. **No migration history** — schema changes go through `db push` (R-002).
3. **Uploads are not durable** on Vercel — function-local disk (R-001).
4. **Chat/voice attachments are broken** by a URL-contract mismatch (R-004).
5. **Rate limiting is per-instance** memory — not a global limit (R-011).
6. **Audit and webhook writes are fire-and-forget** — may be lost at serverless termination.
7. **`/api/assistant` has no body validation, size, rate, or cost limit** (R-010).
8. **Direct routes don't check account status**, only session identity.
9. **Connected mailboxes are disabled** pending OAuth hardening (R-005).
10. **Webhooks allow arbitrary URLs** (SSRF) and never retry (R-006, R-023).
11. **Scheduled jobs aren't scheduled** — overdue invoices, recurring expenses, contract expiry, and future-dated resignation offboarding are manual (R-015).
12. **Two lockfiles and legacy dependencies** remain (R-013, R-022).

## Related documents

- [System architecture](../architecture/SYSTEM-ARCHITECTURE.md) · [API and automation reference](API-AUTOMATION-REFERENCE.md) · [Quality and performance](QUALITY-PERFORMANCE.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · [Glossary and source map](../reference/GLOSSARY-SOURCE-MAP.md)
