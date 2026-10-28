# DevFathom — Security Hardening Report

**Engagement date:** 2026-06-18
**Scope:** Full application security review and remediation (authn/authz, REST agent API, AI assistant, realtime server, secrets, config).
**Method:** 8-dimension adversarial audit (every finding independently refuted-or-confirmed) → prioritized remediation → typecheck/lint regression gate → adversarial re-verification.

---

## Reporting a vulnerability

Submit a private report through
[GitHub private vulnerability reporting](https://github.com/RealDevFathom/devfathom-commercial/security/advisories/new).
Include the affected feature or version, impact, and steps to reproduce with
redacted evidence. Do not include credentials or open a public issue.
The hardening report below is historical audit context.

## ⚠️ Action required by an operator (cannot be done in code)

1. **Rotate the four live credentials** that were sitting in plaintext `.env` (they were never committed to git, but treat them as compromised):
   - Neon Postgres password (in `DATABASE_URL`) — reset in the Neon dashboard.
   - `AUTH_SECRET` — `openssl rand -base64 33` (rotating this logs everyone out — expected).
   - `GROQ_API_KEY` — roll in the Groq console.
   - `BREVO_API_KEY` — roll in the Brevo dashboard.
   Then store them in a secret manager / Vercel encrypted env vars, not a file on disk. `.env.example` documents the surface with placeholders only.
2. **Runtime-test the realtime socket server** end-to-end (see Socket section) — its auth rebuild can't be unit-verified.
3. Set **`SEED_PASSWORD`** (or **`ADMIN_PASSWORD`** as its fallback) before running `prisma/seed.ts` (hardcoded demo password removed). If `ADMIN_EMAIL` is set, `ADMIN_PASSWORD` is also required for the separate workspace administrator.

---

## Audit result

35 findings, **all 35 independently confirmed** (0 false positives): **8 high, 9 medium, 18 low/hardening**.

The dominant, systemic issue was **broken object-level authorization (IDOR)**: the app authenticated requests (`protectedProcedure` = "are you logged in?") but rarely authorized them ("may you touch *this* record?"). It recurred across the tRPC routers, the REST API, the AI tools, chat, meetings, and the Trello import.

---

## What was fixed

### 1. Authorization keystone (root-cause fix for the IDOR family)
A single reusable layer now backs every access decision:
- `src/lib/authz.ts` — framework-agnostic predicates (project membership/lead, board/column/task → project resolution, channel membership, meeting access, notification ownership).
- `src/server/authz.ts` — tRPC `assert*` guards that throw `FORBIDDEN`/`NOT_FOUND`.

Applied across:
- **`projects.ts`** — all 24 project/board/column/task/label/milestone/comment/checklist mutations and the detail reads (`getById`, `getBoardWithTasks`, `getTaskDetail`) now verify membership; destructive ops require LEAD/ADMIN.
- **`chat.ts`** — every channel operation requires `ChannelMember` (private DMs are no longer readable/postable by non-members; no admin bypass).
- **`meetings.ts`** — `update`/`delete` require creator/ADMIN; detail read requires attendee/creator/ADMIN.
- **`team.ts`** — `markNotificationRead` requires ownership; password policy raised to 12 chars + complexity; verified `updateProfile` cannot set role/status/department/title.
- **`trello-import.ts`** — import requires membership of the target project; imported task assignees and comment authorship are constrained to real project members (fixes audit-trail forgery).
- **REST `/api/v1`** — object-level checks on every `[id]` route; collection `GET /tasks` & `/projects` membership-scoped; `POST /tasks` checks project access; finance/clients require ADMIN; a non-admin's wildcard `*` token can no longer reach finance.
- **AI assistant (`tools.ts`)** — every tool scoped to the acting user; `createClient`/`getFinanceSummary` are ADMIN-only and absent from the employee toolset; `createTask` checks project access. A prompt-injected model cannot exceed the employee's own permissions.

### 2. Session revocation (high)
Stateless 30-day JWTs meant a fired/demoted user kept full access for up to 30 days. Now `auth.ts` re-reads role + status from the DB every ~60s and writes `status` into the token; `protectedProcedure`/`adminProcedure` reject non-`ACTIVE` accounts. Session lifetime cut from 30 days to 8 hours with rotation. `AUTH_SECRET` is now required at boot in production.

### 3. Realtime socket server (was fully unauthenticated)
Identity was a client-supplied query param; anyone could spoof presence, read/inject any channel (incl. private DMs), and forge notifications. Now: the browser fetches a short-lived **HMAC ticket** from an authenticated route and presents it in the handshake; the server verifies it (timing-safe, expiry-checked), derives the user id server-side, and **authorizes every channel op against DB membership** (fails closed). `senderId` is server-stamped; payloads are zod-validated and rate-limited; the forgeable client→client `notification:send` relay was removed.

### 4. Login & account security
- Constant-time bcrypt comparison against a dummy hash for missing/inactive accounts (kills the username-enumeration timing oracle).
- Open-redirect fix: `callbackUrl` is restricted to same-origin relative paths.
- Password policy: 12-char minimum + complexity on all password-set paths.

### 5. Secrets & config hygiene
- `.env.example` added; hardcoded seed password and plaintext-token log output removed/redacted.
- Security headers: **CSP** and **HSTS** added (the four prior headers kept); CSP keeps `'unsafe-eval'` in dev only.
- **Image-optimizer SSRF** closed: `images.remotePatterns` no longer `'**'`.
- REST error responses no longer leak `err.message` / Prisma internals.

---

## Intentional behavior changes (please confirm these match product intent)

- **Project/board/task detail is now member-scoped.** Employees who are not members of a project can no longer open its board, tasks, or member list (this previously leaked member emails for arbitrary projects). If you want company-wide project *visibility*, relax the read guards — but keep the write/delete guards.
- **Private chat channels / DMs** are now strictly members-only, including for admins.
- **Finance via REST** requires an ADMIN-bound token.

---

## Verified clean

- TypeScript: **no new errors** introduced (4 pre-existing, unrelated to security).
- ESLint: **no new errors** introduced (pre-existing `react-hooks/refs` issues in UI files remain).

## Adversarial re-verification

An independent principal-level pass tried to bypass the fixes. **The keystone (tRPC IDOR, session revocation, REST, AI assistant, socket, config) was confirmed CLOSED — no bypass found.** It surfaced two residuals, both now fixed:
- **Notes forward-link leak (`notes.getById`)** — a crafted `noteLink` to an arbitrary note id leaked that note's *title* via `linksFrom`. Fixed: forward-links are now visibility-filtered exactly like backlinks (`src/server/routers/notes.ts`).
- **Stored XSS via client `website`** (admin-planted `javascript:` URL rendered as an `href`). Fixed at the sink with `safeHref()` (`src/lib/validators.ts`) on both render sites, plus scheme validation on store in `clients.ts`.

## Residual / follow-up (low severity — flagged, not changed)

- **`ON_LEAVE` users have no app access.** The original login already blocked any non-`ACTIVE` status; session revocation now enforces this continuously. If on-leave staff should retain read access, treat `ON_LEAVE` as allowed in `assertActive` (`src/server/trpc.ts`) and in `authorize` (`src/lib/auth.ts`).
- `updateTaskAssignees` / `addLabelToTask` don't verify the assignee/label belongs to the project/board (a member can assign a task to a non-member or attach a foreign-board label). Low impact.
- `createBoard`/`createColumn` require project *membership* while `deleteBoard`/`deleteColumn` require LEAD/ADMIN — intentional, but confirm it matches your "who can restructure a board" policy.
- `deleteChannel` is available to any channel member; consider restricting to the creator/ADMIN.
- REST/AI `website` write paths rely on the render-side `safeHref` guard; add `optionalWebsiteUrl` there too for consistency if desired.
- **Rate limiting** on login and the AI assistant is best-effort/absent; a shared store (Upstash/Vercel KV) is recommended for production brute-force/cost protection.

## Verification status summary

| Area | Status |
|------|--------|
| tRPC object-level authz (projects/chat/meetings/team/trello) | ✅ Closed (re-verified) |
| Session revocation (60s) | ✅ Closed |
| REST `/api/v1` authz + role enforcement | ✅ Closed |
| AI assistant tool scoping | ✅ Closed |
| Realtime socket auth + channel authz | ✅ Logic verified — **needs runtime test** |
| Notes visibility / website XSS | ✅ Fixed |
| CSP / HSTS / image-SSRF / secrets hygiene | ✅ Closed |
| TypeScript / ESLint regressions | ✅ None introduced |
