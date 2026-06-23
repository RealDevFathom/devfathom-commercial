# FIXES.md — QA Remediation (June 2026)

Per-bug remediation log for the 53 findings in [`/BUGS.md`](./BUGS.md), driven through both trackers
(GitHub Issues `WhatTheStack1/DevFathom-Hub` + internal "QA Remediation — June 2026" › "QA Findings").

**The loop (per ticket):** To Do → In Progress → (engineer implements root-cause fix) → In Review →
QA re-tests the exact repro + regression → **PASS** ⇒ card → Done + GitHub issue closed with evidence;
**FAIL** ⇒ back to In Progress (max 3 cycles, then Blocked + escalate). Build (`bun run build`) +
`src/` typecheck stay green at the end of every phase. Keystone (ABAC/IDOR/auth) re-verified after every
security change.

Branch: `fix/qa-remediation`. Verification method mirrors the original QA pass — static (file:line) +
clean build/typecheck + pure-logic dynamic repro tests (no writes to the shared Neon DB).

## Status summary

| Phase | Severity | Total | Fixed | Blocked | Remaining |
|---|---|---|---|---|---|
| 1 | HIGH | 3 | 3 | 0 | 0 |
| 2 | MEDIUM | 22 | 22 | 0 | 0 |
| 3 | LOW | 28 | 28 | 0 | 0 |
| **All** | | **53** | **53** | **0** | **0** |

**53/53 fixed, verified, and reconciled (Done cards = closed GitHub issues = merged commits).
AUTH-01 unblocked (2026-06-23, commit `365ea6c`): session revocation via `User.tokenVersion`,
validated against a local disposable Postgres (`db push` clean) — no shared-DB mutation. Ships
with a `prisma db push` at deploy.**
Build green; `src/` typecheck clean; ABAC/IDOR/auth keystone re-verified intact after every
security change (the `src/lib/abac` policy engine and `src/lib/authz.ts` object-guards were never
modified — all fixes ADD restrictions).

---

## PHASE 1 — HIGH (3/3 fixed)

### FIN-01 — Invoice subtotal/tax/total trusted from client — **Fixed** · GH #3 closed · cycles: 1
- **Root cause:** `finance.createInvoice` wrote `subtotal/tax/total` verbatim; REST `POST /api/v1/invoices`
  used bare `z.number()` (accepted `total:-15000`, decrementing paid/outstanding sums).
- **Fix:** derive every line `amount`, `subtotal`, `total` server-side from `quantity × rate (+ tax)` in
  both paths; ignore client totals; bound + non-negative REST money fields.
- **Files:** `src/server/routers/finance.ts:8-18` (round2), `:174-235` (createInvoice);
  `src/app/api/v1/invoices/route.ts:32-90`.
- **Verification:** items worth $15,000 sent with `subtotal:0,total:0` (and `-15000` over REST) now store
  $15,000; negatives ignored. Build green; dynamic repro test PASS. Internal card → Done.
- **Commit:** `9983579`.

### FIN-02 — Money aggregates sum USD + PKR into one `$` figure — **Fixed** · GH #4 closed · cycles: 1
- **Root cause:** no `currency` in any aggregate `where`/`groupBy`; `_sum(amount)` blended USD + PKR and
  rendered under a hardcoded `$` (Rs 280,000 + $5,000 → "$285,000", ~47× overstated).
- **Fix:** new `src/lib/finance/currency.ts` helpers; every monetary aggregate groups BY currency across
  `finance.getFinancialSummary`/`getPnlReport`, `dashboard.getStats`/`getRevenueChart`, REST
  `/finance/summary`, and AI `getFinanceSummary`/`getPnlReport`. KPIs render per-currency (collapse to
  "$X" when only USD); revenue + P&L charts gained a currency selector.
- **Files:** `src/lib/finance/currency.ts` (new); `src/server/routers/finance.ts:319-432`;
  `src/server/routers/dashboard.ts:38-64,186-244`; `src/app/api/v1/finance/summary/route.ts`;
  `src/lib/ai/tools/finance.ts:113-218`; `finance-content.tsx`, `dashboard-content.tsx`,
  `revenue-chart.tsx`, `pnl-report.tsx`.
- **Verification:** $5,000 + Rs 280,000 → "$5,000 · Rs 280,000" (never "$285,000"). Build green; dynamic
  repro test PASS. Internal card → Done.
- **Commit:** `9983579`.

### PROJ-01 — Kanban drag moves the wrong task under a filter — **Fixed** · GH #5 closed · cycles: 1
- **Root cause:** drag indices came from the rendered `filteredColumns` but were spliced into the
  unfiltered `board.columns`, so under any filter a different task moved with a wrong `order`.
- **Fix:** `handleDragEnd` maps by task id — remove the dragged task from the real source column by id,
  find its follow-neighbour in filtered space, insert before that neighbour's REAL index, send that real
  index as `newOrder`. Collapses to original behaviour with no filter. Moved `filteredColumns` memo above
  the handler.
- **Files:** `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx:126-220`.
- **Verification:** filter active → drag visible task → correct task moves, hidden tasks preserved,
  correct order persisted. Build green; dynamic repro test PASS (3/3). Internal card → Done.
- **Commit:** `d8afaa2`.

---

## PHASE 2 — MEDIUM (21/22 fixed · 1 blocked) — all verified, build green, keystone re-verified

Commits: `18adfe4` (FIN-03..07, REST-01), `559a2ff` (DASH-01), `6cfce8f` (NOTE-01), `cf6ff34` (HR-01),
`b36a7db` (AI-01), `996ee7b` (CLI-01), `7cef86e` (PROJ-02/03/05/06/07), `54f2d68` (RT-01/03/06),
`7bbb2b2` (RT-02/04), `e57624a` (REST-04), `a573209` (RT-05), `b611461` (PROJ-04).

| BUG-ID | Status | GH | Cycles | Fix summary |
|---|---|---|---|---|
| REST-01 | Fixed | #6 | 1 | `clients[/id]` REST only embeds invoices/`_count` when token also has `finance:read` (`hasScope`). |
| FIN-03 | Fixed | #7 | 1 | `getRevenueChart` months anchored at day 1 (no setMonth overflow) + endOfMonth `23:59:59.999`. |
| FIN-04 | Fixed | #8 | 1 | `getFinancialSummary`/`getStats` aggregates bounded with `lte: now`. |
| FIN-05 | Fixed | #9 | 1 | Active recurring expenses' monthly run-rate folded (currency-aware) into summary expense/profit. |
| FIN-06 | Fixed | #10 | 1 | `updateInvoiceStatus` (tRPC+AI): status state-machine, no-op skip, clear paidAt/sentAt on leave. |
| FIN-07 | Fixed | #11 | 1 | REST transaction `amount` bounded `.max(MAX_MONEY)`; invoices already bounded in FIN-01. |
| DASH-01 | Fixed | #12 | 1 | Activity feed scoped to viewer (own / accessible Note / member Project-Task); else dropped. |
| HR-01 | Fixed | #13 | 1 | `updateLeaveStatus` (+AI) rejects self-decision and non-PENDING re-decisions. |
| NOTE-01 | Fixed | #14 | 1 | `notes.update` (+AI) restricts visibility/project/client change to author/admin (on actual change). |
| RT-01 | Fixed | #15 | 1 | `logJoin` enforces the `[start-5min, end]` attendance window like `markJoined`. |
| RT-02 | Fixed | #16 | 1 | `removeMember`/`leaveChannel` emit `MEMBERSHIP_CHANGED`; client drops channel live + re-auths; TTL 30m. |
| RT-03 | Fixed | #17 | 1 | `logLeave` on SPA-nav (cleanup) + hard unload (pagehide keepalive beacon). |
| RT-04 | Fixed | #18 | 1 | `editMessage` notifies newly-added mentions (diff vs pre-edit set). |
| RT-05 | Fixed | #19 | 1 | Uploads → private dir, served via authenticated `/api/files/[name]` (path-traversal-guarded). |
| REST-04 | Fixed | #20 | 1 | In-process rate limiter on login (per-IP/account, pre-bcrypt) + REST (`withApiAuth` per-IP/token → 429). |
| PROJ-02 | Fixed | #21 | 1 | Trello import per-column order 0..n; `moveTask` rebuilds contiguous order (gap-resistant). |
| PROJ-03 | Fixed | #22 | 1 | Column-delete confirm names the task count it will cascade-destroy. |
| PROJ-04 | Fixed | #23 | 1 | `addTaskAttachment`/`deleteTaskAttachment` + Attachments section (list/open/download/delete/upload). |
| PROJ-05 | Fixed | #24 | 1 | `createTask`/`updateTaskAssignees` validate assignees are project members (skipDuplicates). |
| CLI-01 | Fixed | #25 | 1 | `clients.delete` pre-counts invoices → friendly BAD_REQUEST; UI renders the error. |
| AI-01 | Fixed | #26 | 1 | `resetMemberPassword` schema `z.string().min(8)`; full policy enforced in `execute`. |
| AUTH-01 | Fixed | #27 | 1 | `User.tokenVersion` revokes other sessions on password change / admin reset / lay-off; `signOutEverywhere`; jwt() revalidation + page guard enforce it. Validated on local Postgres. |

### AUTH-01 — RESOLVED 2026-06-23 (commit `365ea6c`)
Implemented exactly per the plan below, using `tokenVersion` (and `passwordChangedAt` for audit). A
**local disposable Postgres** (`127.0.0.1:5433`, never shared Neon) made it possible to validate the
`db push` cleanly — the only thing that had blocked it. Deploy applies it via `prisma db push`. Original
ready-to-apply plan (now done):
1. `User` model: add `passwordChangedAt DateTime @default(now())` (and/or `tokenVersion Int @default(0)`).
2. Migration: `prisma migrate dev -n auth01_session_revocation` (backfills existing rows via the default).
3. Sign-in (`auth.ts` `authorize`): stamp `passwordChangedAt`/`tokenVersion` into the JWT.
4. `jwt()` refresh: also read `passwordChangedAt`; if the token's value is older than the user's, return
   `null`/force re-auth (alongside the existing role/status re-read).
5. `changePassword` / `adminResetPassword` / `layOffMember`: bump `passwordChangedAt = now()` (force-logout).
6. Acceptance: sign in on 2 devices → change password on one → the other is logged out on next `jwt()` refresh.

---

---

## PHASE 3 — LOW (28/28 fixed) — all verified, build green

Commits: `7cef86e` (PROJ-06/07), `54f2d68` (RT-06), `293c19c` (SEC-01/02), `c6ad18e` (AUTH-02/SEC-03),
`330a9c8` (FIN-08/09), `730dcf2` (AUTHZ-02), `748568b` (CON-01/02), `31008b4` (TRELLO-01),
`18adfe4` (REST-06 tx), `28e28be` (RT-08/09), `4764f93` (AI-03), `e79b5f6` (REST-02/05/06/07),
`e32ead7` (RT-10, CLI-02, UX-01, AI-04, AI-02, AUTHZ-04).

| BUG-ID | GH | Fix |
|---|---|---|
| REST-02 | #28 | /api/v1/spec records a REST audit (success + 401). |
| REST-05 | #29 | `readJson()` → clean 400 on malformed JSON across all 10 v1 write routes. |
| REST-06 | #30 | `/tasks` + `/transactions` limit is NaN-safe/clamped. |
| REST-07 | #31 | `/tasks`, `/transactions`, `/meetings` validate FKs → 400, not raw FK 500. |
| FIN-08 | #32 | P&L profit/margin rounded to cents/2dp (no float artifacts in raw JSON). |
| FIN-09 | #33 | P&L month-end includes final ms; invoice number per-year reset (tRPC+REST+AI). |
| AUTHZ-02 | #34 | adminUpdateMember blocks demoting/deactivating the last active admin. |
| AUTHZ-04 | #35 | Documented + aligned the canonical client-directory trust policy (tRPC/REST/AI). |
| RT-06 | #36 | Atomic attendance insert (createMany+skipDuplicates) — no P2002/500 race. |
| RT-08 | #37 | Client message sort adds an id tiebreak for same-ms messages. |
| RT-09 | #38 | Read receipts emitted to the actor's own room, not broadcast to the channel. |
| RT-10 | #39 | Occurrence resolver keeps the most recent past occurrence through the gap. |
| PROJ-06 | #40 | addComment verifies parentId belongs to the same task. |
| PROJ-07 | #41 | Completion logging uses the shared done-column heuristic. |
| CON-01 | #42 | Contracts reject endDate before startDate. |
| CON-02 | #43 | updateContract stamps signedAt on first SIGNED (matches inline dropdown). |
| TRELLO-01 | #44 | safeDate() tolerates malformed dates instead of crashing the import. |
| CLI-02 | #45 | addContact validates email when provided (contact CRUD UI → enhancement). |
| UX-01 | #46 | Client create + edit forms render mutation errors inline. |
| HR-02 | #47 | createLeaveRequest validates end>=start, rejects past + overlapping requests. |
| DASH-02 | #48 | getStats pending-leave count company-wide for admins, own-only otherwise. |
| AUTH-02 | #49 | /(app) layout server-side auth guard → clean redirect for stale/forged cookies. |
| SEC-01 | #50 | CSP connect-src drops blanket ws:/wss: + stale socket origin. |
| SEC-02 | #51 | CSP img-src tightened to `'self' data: blob:`. |
| SEC-03 | #52 | Shared page-auth guard + precise proxy static-asset match. |
| AI-02 | #53 | Added cross-user isolation eval cases; documented construction-level guard. |
| AI-03 | #54 | Scoped AI pending-leave count + colleague project roster. |
| AI-04 | #55 | Documented the approval-is-UX security invariant. |
