# API and automation reference

**Snapshot:** 2026-07-12  
**Audience:** engineers and automation/agent developers integrating with DevFathom Hub.

## Three automation surfaces

| Surface                           | Caller                  | Auth                               | Shape                                  | Use it for                                         |
| --------------------------------- | ----------------------- | ---------------------------------- | -------------------------------------- | -------------------------------------------------- |
| **Browser tRPC**                  | Authenticated UI only   | NextAuth session cookie            | 229 typed procedures across 20 domains | Everything the app UI does                         |
| **REST `/api/v1`**                | Scripts and agents      | `Authorization: Bearer df_…` token | 16 route files, scope-gated            | Programmatic reads/writes from outside the browser |
| **AI assistant `/api/assistant`** | Authenticated UI        | NextAuth session cookie            | Streaming model + 96 tools             | Natural-language operation of the Hub              |
| **Outbound webhooks**             | The Hub → your receiver | HMAC signature you verify          | 2 event types, signed POST             | Reacting to Hub events                             |

tRPC is the browser's private API and is not a stable external contract — this document focuses on the three surfaces meant for automation: REST, assistant, and webhooks. Internal tRPC conventions are in the [engineering handbook](ENGINEERING-HANDBOOK.md).

## REST API (`/api/v1`)

### Authentication and token lifecycle

**Verified** from `src/lib/api-auth.ts` and `src/server/routers/api-tokens.ts`.

- **Format:** `df_` + `randomBytes(24).toString('base64url')` → `df_` followed by 32 base64url chars (~192 bits entropy). (A code comment saying "hex" is inaccurate; the implementation is base64url.)
- **Storage:** only a `prefix` (first 12 chars, indexed, for display) and a bcrypt `tokenHash` (cost 10, unique). The raw token is **never stored** and is shown exactly once — in the `apiTokens.create` response. It cannot be retrieved again.
- **Lookup:** candidates by prefix, then bcrypt compare per candidate.
- **Binding:** every token is bound to one user. REST actions are attributed to that user. An admin can bind a token to another user (`userId`, must be an active account); default is the creator.
- **Expiry:** optional `expiresInDays` at creation → `expiresAt`; default none. Expired → 401.
- **Activity:** `lastUsedAt` updated (fire-and-forget) on each successful auth; richer usage stats (`apiTokens.usage`) are derived from audit rows keyed by `tokenId`.
- **Management:** **admin-only.** `list`, `usage`, `create`, `revoke` are all `adminProcedure`. Revoke is a hard delete — the next request with that token gets 401.

### Scopes

Scope constants (`AVAILABLE_SCOPES`, `src/lib/api-auth.ts`):

`*` (full access) · `tasks:read` · `tasks:write` · `projects:read` · `projects:write` · `clients:read` · `clients:write` · `team:read` · `finance:read` · `finance:write` · `meetings:read` · `meetings:write`

Rules (Verified):

- **Write implies read:** holding `X:write` satisfies any `X:read` check.
- **`*`** satisfies every scope check.
- **Finance is special:** any `finance:*` endpoint additionally requires the **bound user's role to be `ADMIN`**, enforced centrally in `withApiAuth`. A `*` token bound to a non-admin still gets `403` on finance routes.
- The tRPC `create` mutation accepts an arbitrary string array and does **not** validate entries against the scope list — an unknown scope string is stored but grants nothing.

### Endpoint / scope matrix

**Verified.** All bodies are parsed with a JSON reader and validated with Zod; all responses are JSON. Envelope: success is `{ "data": … }` (lists may add `"nextCursor"`); deletes return `{ "success": true }`.

| Route file                     | Method · scope (extra requirement)                                                                    | Notes                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks/route.ts`               | GET · `tasks:read` · POST · `tasks:write`                                                             | GET: filters `columnId`/`assigneeId`/`priority`, cursor pagination, limit 1–100 (def 50), non-admin scoped to member projects. POST: creates task, merges column default assignees, `→ 201`. |
| `tasks/[id]/route.ts`          | GET · `tasks:read` · PATCH · `tasks:write` · DELETE · `tasks:write` (+ manage: admin or project LEAD) | PATCH validates source and target project access; entering a "Done" column logs completion.                                                                                                  |
| `tasks/[id]/comments/route.ts` | GET · `tasks:read` · POST · `tasks:write`                                                             | Comment author = token's bound user; `content` 1–10000 chars, optional `parentId`.                                                                                                           |
| `boards/[id]/route.ts`         | GET · `tasks:read`                                                                                    | Deep board (columns → tasks → assignees/labels).                                                                                                                                             |
| `projects/route.ts`            | GET · `projects:read` · POST · `projects:write`                                                       | GET limit 1–1000, non-admin sees member projects only. POST auto-adds creator as LEAD and creates a default board (Backlog/To Do/In Progress/Review/Done).                                   |
| `projects/[id]/route.ts`       | GET · `projects:read` · DELETE · `projects:write` (+ manage)                                          | —                                                                                                                                                                                            |
| `clients/route.ts`             | GET · `clients:read` (**+ admin**) · POST · `clients:write` (**+ admin**)                             | Invoice `_count` embedded only if the token also has `finance:read`.                                                                                                                         |
| `clients/[id]/route.ts`        | GET · `clients:read` (**+ admin**) · DELETE · `clients:write` (**+ admin**)                           | Invoices embedded only with `finance:read`.                                                                                                                                                  |
| `team/route.ts`                | GET · `team:read`                                                                                     | Directory fields for everyone; admin-bound tokens additionally receive department, phone, bio, skills, status, startDate.                                                                    |
| `meetings/route.ts`            | GET · `meetings:read` · POST · `meetings:write`                                                       | GET returns only meetings where the token user is an attendee. POST auto-adds the token user; `recurrence` daily/weekly/biweekly/monthly/null.                                               |
| `transactions/route.ts`        | GET · `finance:read` · POST · `finance:write`                                                         | Cursor pagination; POST amount ≤ 9,999,999,999.99, currency USD/PKR.                                                                                                                         |
| `transactions/[id]/route.ts`   | PATCH · `finance:write` · DELETE · `finance:write`                                                    | No GET-by-id.                                                                                                                                                                                |
| `invoices/route.ts`            | GET · `finance:read` · POST · `finance:write`                                                         | POST recomputes subtotal/total server-side; number `INV-<year>-NNN`; starts DRAFT.                                                                                                           |
| `invoices/[id]/route.ts`       | GET · `finance:read` · PATCH · `finance:write`                                                        | PATCH sets status (`sentAt`/`paidAt`); **note:** it does **not** emit the `invoice.paid` webhook — only the tRPC payment flow does.                                                          |
| `finance/summary/route.ts`     | GET · `finance:read`                                                                                  | Income/expense/profit/invoices grouped by currency; period defaults to month-start→now.                                                                                                      |
| `spec/route.ts`                | GET · any valid token (no scope)                                                                      | See below.                                                                                                                                                                                   |

All finance routes require an admin-bound token (central gate).

### Response and error contract

**Verified.** Errors are always `{ "error": "<message>" }`; validation failures add `"details": [<zod issues>]`. There are no machine-readable error codes beyond the HTTP status.

| Status | When                                                                     | Example body                                                        |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 400    | Invalid input / malformed JSON / bad foreign key                         | `{"error":"Invalid input","details":[…]}`                           |
| 401    | Missing/invalid/expired token, wrong format                              | `{"error":"Token has expired"}`                                     |
| 403    | Inactive account, missing scope, finance-non-admin, object access denied | `{"error":"Insufficient permissions. Required scope: tasks:write"}` |
| 404    | Entity not found                                                         | `{"error":"Task not found"}`                                        |
| 429    | Rate limit exceeded                                                      | `{"error":"Too many requests"}` + `Retry-After` header              |
| 500    | Unhandled handler exception (internals never leaked)                     | `{"error":"Internal server error"}`                                 |

No route uses 422 — validation failures are 400.

### Attribution

**Verified.** Every `/api/v1` request — including failures, 429s, and `/spec` reads — writes an append-only `AuditLog` row via `recordRestAudit`: `actorType = API_TOKEN` (or `ANONYMOUS` on auth failure), `actorId` = bound user, snapshot `actorName`/`actorEmail`/`actorRole`, `tokenId`, `tokenName`, `source = REST_API`, `action = "<METHOD> <path>"`, IP, user agent, status code, `{scope, query}` metadata, outcome, and duration. Business events also call `logActivity` with the bound user — so the dashboard and team stats attribute REST writes to that user, not to the admin who minted the token.

### Rate limiting

**Verified** (`src/lib/rate-limit.ts`) — an in-process `Map`, **per server instance**, so it is not a global limit on Vercel (risk R-011). Two fixed-window gates:

- Pre-auth, per IP: 120 requests / 60 s (runs before bcrypt to cap auth floods). IP from `x-forwarded-for`.
- Post-auth, per token: 240 requests / 60 s.

Exceeding either returns 429 with `Retry-After`. tRPC and the assistant are **not** covered by this module.

### `/api/v1/spec` — Markdown, not OpenAPI

**Verified.** `GET /api/v1/spec` returns a **Markdown** document (`text/markdown`), generated per request, aimed at LLM agents. It is **not an OpenAPI/Swagger spec** — do not point OpenAPI tooling at it. Any valid token (no scope) may read it; the read is itself audited. Two known staleness points in its examples: it shows invoice `subtotal`/`total` as accepted (the server ignores and recomputes them) and describes `finance/summary` with a `{monthly, yearly}` shape (actual shape is currency-grouped).

### Extending the REST API

**Verified pattern.** Create `src/app/api/v1/<resource>/route.ts` and export handlers wrapped in `withApiAuth`:

```ts
export const POST = withApiAuth('<resource>:write', async (ctx, request) => {
  const j = await readJson(request);
  if (!j.ok) return j.response;
  const parsed = schema.safeParse(j.data);
  if (!parsed.success)
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  // object-level authz via src/lib/authz.ts (isAdmin / canAccessProject / canManageProject) → 403 on failure
  // pre-validate foreign keys → 400
  const created = await ctx.db; /* … */
  logActivity(ctx.db, ctx.userId, { type, message, entityType, entityId });
  return NextResponse.json({ data: created }, { status: 201 });
});
```

`withApiAuth` automatically supplies IP+token rate limiting, scope checking (write⊃read), the finance→admin gate, `recordRestAudit`, and the catch-all 500. Add new scopes to `AVAILABLE_SCOPES` and document the endpoint in `spec/route.ts`. To fan out a webhook, add the event to `WEBHOOK_EVENTS` and call `emitEvent(db, '<event>', payload)` after the committed write.

## AI assistant (`/api/assistant`)

### Model and request contract

**Verified** (`src/app/api/assistant/route.ts`, `src/lib/ai/*`).

- **Provider/model:** Google Gemini via `@ai-sdk/google`; model `GEMINI_MODEL` or default `gemini-2.5-flash`. Streaming via `streamText` → `toUIMessageStreamResponse`. Step cap: `stopWhen: stepCountIs(6)`. Function `maxDuration = 60`. No temperature/token settings (provider defaults). Groq is a dead dependency — not imported by any reachable app code.
- **Auth:** requires a valid NextAuth session (`session.user.id`); that is the **only** gate.
- **Body:** `const { messages } = await req.json()` — **no schema validation, no size limit, no message-count limit, no rate limit, and no account-status check** (risk R-010). Tool context (identity, role, department, status) is built from the session, never from the model.

### Tool inventory (96 tools, 10 domains)

**Verified** counts from `src/lib/ai/tools/`:

| Domain       |  Tools | Approval-gated writes |
| ------------ | -----: | --------------------: |
| projects     |     18 |                    16 |
| people       |     14 |                     9 |
| tasks        |     14 |                    11 |
| finance      |     13 |                     8 |
| insights     |      7 |         0 (all reads) |
| clients      |      7 |                     6 |
| chat         |      6 |                     4 |
| notes        |      6 |                     4 |
| meetings     |      6 |                     5 |
| resignations |      5 |                     3 |
| **Total**    | **96** |                **66** |

There is no email tool domain; email is a side effect of write tools.

### Domain selection

**Verified** (`src/lib/ai/tools.ts`). To control cost, only relevant toolsets are exposed per request. A hint is built from the last **two** user messages and matched against keyword regexes; each match loads that domain's full toolset. **16 core read tools are always on** (overview, search, team, projects, tasks, clients, meetings, notes, channels). No keyword match → default domains `people`, `projects`, `tasks`. Empty hint (e.g. an approval continuation) → the full set. Selection only narrows what is offered; authorization still happens inside each tool.

### Approval and authorization model

**Verified.** Sixty tool definitions declare `needsApproval: true`. The AI SDK pauses before `execute`; the client renders an approval card and continues on confirmation. The total is an exact anchored property count, excluding comments/usages.

**Critical invariant (AI-04):** the approval card is **advisory UX, not a security boundary** — the client supplies the full message history, so a forged approval could skip the card. This is acceptable **only because every write tool re-authorizes inside `execute`** against the same ABAC `can()` decision point used by tRPC and REST, with `{ source: 'ASSISTANT' }`. Examples:

- `people.layOffMember` re-checks `team:layoff` ABAC, self-lay-off, already-inactive, and last-admin guards.
- `finance.*` returns an empty toolset for non-admins **and** every finance `execute` re-checks `isAdmin`.
- `projects.deleteProject` re-checks `canManageProject` (LEAD or admin).

Writes also mirror tRPC side effects: audit (`assistant.*` actions, `source = SYSTEM`, `metadata.via = 'assistant'`), activity, and notifications.

### Error handling

**Verified.** Every tool `execute` is wrapped: a throw becomes `{ error: message }` so the model gets a recoverable structured failure. Expected failures return `{ error }` or `{ needsClarification }` (ambiguous name resolution). Stream-level errors surface a fixed user-facing apology string.

## Outbound webhooks

**Verified** (`src/lib/webhooks.ts`, `src/server/routers/webhooks.ts`).

- **Events:** exactly two — `invoice.paid` and `task.created`. Emit sites: `projects.createTask` (tRPC) emits `task.created`; `finance.recordPayment` (tRPC) emits `invoice.paid` **only when a payment fully covers the total**. REST task creation and REST invoice status changes do **not** emit.
- **Payload:** body is `{ event, data, timestamp }` (ISO timestamp inside the body — there is no timestamp header). `data` is small: task → `{taskId, title, columnId, projectId}`; invoice → `{invoiceId, total, currency, clientId}`.
- **Headers:** `Content-Type: application/json`, `X-DevFathom-Event: <event>`, `X-DevFathom-Signature: sha256=<hex HMAC-SHA256 of the raw body using the webhook secret>`.
- **Secret:** `randomBytes(32).toString('hex')` (64 hex chars), shown once at create, never echoed again.
- **Delivery:** fire-and-forget, **single attempt**, 5 s timeout, fanned out to all active hooks subscribed to the event. **No retries, no backoff, no dead-letter** (R-023). Each attempt writes a `WebhookDelivery` row: `{event, statusCode, success, error, attemptedAt}`.
- **URL validation:** accepts **any** well-formed http(s) URL — no private-network/loopback/metadata/redirect protection (SSRF risk R-006).
- **Management:** admin-only (`list`, `recentDeliveries`, `create`, `update`, `delete`).

### Verifying a signature (receiver side)

```
signature = "sha256=" + hex(HMAC_SHA256(rawRequestBody, webhookSecret))
```

Compare against `X-DevFathom-Signature` using a constant-time comparison over the **raw** body (not re-serialized JSON). Reject on mismatch. Because delivery is single-attempt, treat a missed delivery as possible and reconcile via REST reads when correctness matters.

## Related documents

- [Integrations and runtime flows](../architecture/INTEGRATIONS-AND-FLOWS.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · [Engineering handbook](ENGINEERING-HANDBOOK.md) · [Roles and workflows](../business/ROLES-WORKFLOWS.md)
