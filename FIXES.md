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
| 2 | MEDIUM | 22 | 21 | 1 (AUTH-01) | 0 |
| 3 | LOW | 28 | 4 | 0 | 24 |
| **All** | | **53** | **28** | **1** | **24** |

LOW already closed early (fixed alongside their domain cluster): PROJ-06, PROJ-07, RT-06,
and REST-06 (transactions route; tasks route pending).

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
| AUTH-01 | **Blocked** | #27 | 0 | Needs a `passwordChangedAt`/`tokenVersion` column + migration — see plan below. |

### AUTH-01 — Blocked (needs DB migration) — implementation plan
The fix (revoke other sessions on password change) requires schema + migration that this engagement
forbids against the shared remote Neon DB, and no local Postgres was available to verify a migration.
Wiring a column-read into the live JWT path would break login on the un-migrated shared DB. **Ticket left
in In Progress; GitHub issue open with a blocked comment; escalated to CTO.** Ready-to-apply plan:
1. `User` model: add `passwordChangedAt DateTime @default(now())` (and/or `tokenVersion Int @default(0)`).
2. Migration: `prisma migrate dev -n auth01_session_revocation` (backfills existing rows via the default).
3. Sign-in (`auth.ts` `authorize`): stamp `passwordChangedAt`/`tokenVersion` into the JWT.
4. `jwt()` refresh: also read `passwordChangedAt`; if the token's value is older than the user's, return
   `null`/force re-auth (alongside the existing role/status re-read).
5. `changePassword` / `adminResetPassword` / `layOffMember`: bump `passwordChangedAt = now()` (force-logout).
6. Acceptance: sign in on 2 devices → change password on one → the other is logged out on next `jwt()` refresh.

---

## PHASE 3 — LOW (in progress)

LOW items already closed during PHASE 2 (fixed in their domain commit):
- PROJ-06 (#40, `7cef86e`) — addComment verifies parentId belongs to the task.
- PROJ-07 (#41, `7cef86e`) — completion logging uses the shared done-column heuristic.
- RT-06 (#36, `54f2d68`) — atomic attendance insert (createMany+skipDuplicates).
- REST-06 (#30, `18adfe4`) — transactions route limit NaN-safe (tasks route still pending).
