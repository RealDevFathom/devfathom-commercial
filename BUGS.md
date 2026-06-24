# DevFathom-Hub — QA Defect Report

**Engagement:** Two-lead senior QA + BA full-app pass (QA Lead + Business Analyst, with a 7-specialist team).
**Date:** 2026-06-23 · **Branch:** `main` · **Build:** `bun run build` → **exit 0 (clean)**.
**Method:** Deep static review of every router, REST endpoint, AI tool, auth/ABAC layer, and UI, plus live unauthenticated probes against the running dev server. The DB is a shared remote Neon instance, so authenticated mutation flows were proven from code (file:line) rather than executed against shared data. Every High/Medium headline was re-verified first-hand by the lead.

## Verdict

The security keystone is **strong**: object-level authorization (IDOR/ABAC) has clearly been remediated and is applied **consistently** across tRPC, the REST `/api/v1` surface, and all ~96 AI-assistant tools. **No Critical and no High *authorization* defect was found** — no cross-tenant IDOR, no privilege escalation, no ABAC bypass on layoff/resignation/role-change, no chat/DM privacy break, and the AI assistant cannot be coaxed into leaking finance or other users' data. Login hardening (timing-oracle defense, status allow-list, ~60s JWT revocation), invite tokens, and security headers are all sound.

The real defect concentration is in **financial data integrity** (caller-trusted invoice totals, mixed-currency summation, unbounded date windows) and **functional correctness** (kanban drag under filters, video-call attendance, chat edge cases), plus a cluster of **information-disclosure / separation-of-duties** gaps that are individually low-to-medium but worth closing.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 22 |
| Low | 28 |
| **Total** | **53** |

---

## Summary table (sorted by severity)

| ID | Title | Sev | Module | Type |
|---|---|---|---|---|
| FIN-01 | Invoice subtotal/tax/total trusted from client, never recomputed | High | Finance | Data |
| FIN-02 | Money aggregates sum USD + PKR into one `$` figure | High | Finance/Dashboard | Data |
| PROJ-01 | Kanban drag-and-drop moves the **wrong** task when a filter is active | High | Projects/Kanban | Functional/Data |
| REST-01 | Full invoice/financial records reachable via `clients:read` scope | Med | REST/Finance | Security |
| FIN-03 | Revenue chart drops the last day of every month (+ month-overflow) | Med | Dashboard | Functional/Data |
| FIN-04 | "This month/year" KPIs have no upper date bound (future rows inflate) | Med | Finance/Dashboard | Data |
| FIN-05 | Recurring expenses excluded from P&L expense/profit | Med | Finance | Functional |
| FIN-06 | Invoice status: no transition guard, `paidAt` never cleared, double-notify | Med | Finance | Data/Functional |
| FIN-07 | REST invoice/transaction money fields unvalidated (negatives/overflow → 500) | Med | REST/Finance | Security/Data |
| DASH-01 | Activity feed leaks SHARED-note titles + cross-team activity to all staff | Med | Dashboard/Notes | Security |
| HR-01 | Leave requests can be self-approved & re-decided (no SoD, no PENDING guard) | Med | Team/HR | Security |
| NOTE-01 | Non-author editor can change a note's visibility (SHARED→TEAM exposure) | Med | Notes | Security |
| RT-01 | Video-call attendance (`logJoin`) bypasses the anti-backfill window | Med | Meetings | Data |
| RT-02 | No realtime revocation on channel removal — ex-member keeps live events | Med | Realtime/Chat | Security |
| RT-03 | `logLeave` never fires on SPA nav/tab close → attendance sessions stay open | Med | Meetings | Functional/Data |
| RT-04 | Editing a message to add an `@mention` creates no notification | Med | Chat | Functional |
| RT-05 | Uploaded files (incl. private-DM voice/attachments) world-readable by URL | Med | Upload | Security |
| REST-04 | No rate limiting anywhere (REST API **and** login) | Med | Platform | Security |
| PROJ-02 | `order` treated as contiguous index; Trello import gaps break later moves | Med | Projects/Trello | Data |
| PROJ-03 | Deleting a column silently cascade-deletes all its tasks (no count/warning) | Med | Projects/Kanban | Data loss/UX |
| PROJ-04 | Task attachments are fetched but never rendered, and cannot be added | Med | Projects/Kanban | Functional |
| PROJ-05 | `createTask`/`updateTaskAssignees` accept arbitrary/non-member user IDs | Med | Projects/Kanban | Data/Authz |
| CLI-01 | Deleting a client with invoices fails with a raw FK error (no friendly msg) | Med | Clients | Error handling/UX |
| AI-01 | `resetMemberPassword` ships a Groq-incompatible `pattern`/`allOf` schema | Med | AI Assistant | Functional/Availability |
| AUTH-01 | Password change does not revoke other active sessions | Med | Auth/Settings | Security |
| REST-02 | `/api/v1/spec` bypasses `withApiAuth` and is never audited | Low | REST | Security |
| REST-05 | Malformed JSON body → 500 instead of 400 (all writes) | Low | REST | Functional |
| REST-06 | Non-numeric `?limit=` → 500 on `/tasks` & `/transactions` GET | Low | REST | Functional |
| REST-07 | Unvalidated foreign keys → 500 instead of 400/404 | Low | REST | Validation |
| FIN-08 | Profit/margin computed with JS float arithmetic on Decimals | Low | Finance | Data |
| FIN-09 | P&L month-end drops final 999 ms; invoice-number race + cross-year reset | Low | Finance | Data |
| AUTHZ-02 | `adminUpdateMember` has no last-admin guard → admin lockout | Low | Team | Security/Availability |
| AUTHZ-04 | Client-directory trust boundary inconsistent across tRPC/REST/AI | Low | Clients | Security (info) |
| RT-06 | Attendance create is non-atomic → concurrent double-join throws P2002 (500) | Low | Meetings | Data |
| RT-08 | Client timeline sorts by `createdAt` only (no id tiebreak) — unstable order | Low | Realtime | Functional |
| RT-09 | `markRead` broadcasts every member's `lastReadAt` to the whole channel | Low | Chat | Privacy |
| RT-10 | Recurring-meeting list shows the next (empty) occurrence, hiding attendance | Low | Meetings | Functional |
| PROJ-06 | `addComment` does not verify `parentId` belongs to the same task | Low | Projects | Data |
| PROJ-07 | Task-completion logged only for a column named exactly `"Done"` | Low | Projects | Business logic |
| CON-01 | Contracts/projects/milestones accept `endDate` before `startDate` | Low | Contracts | Validation |
| CON-02 | Contract `signedAt` auto-stamp inconsistent (status dropdown vs edit form) | Low | Contracts | Logic |
| TRELLO-01 | Malformed date strings in a Trello export crash the whole import | Low | Trello import | Robustness |
| CLI-02 | `addContact` skips email validation; no contact edit/delete UI at all | Low | Clients/Contacts | Validation/UI |
| UX-01 | Client create/edit forms swallow validation errors (no feedback) | Low | Clients | UX |
| HR-02 | Leave requests accept invalid/overlapping/past date ranges | Low | Team/HR | Validation |
| DASH-02 | `getStats` returns company-wide pending-leave count to non-admins | Low | Dashboard | Info exposure |
| AUTH-02 | Edge middleware authorizes on cookie **presence** only (no signature check) | Low | Auth | Security (DiD) |
| SEC-01 | CSP `connect-src` ends with `ws: wss:` wildcards + stale `localhost:3001` | Low | Platform/Config | Security |
| SEC-02 | `img-src 'self' data: https:` allows images from any HTTPS origin | Low | Platform/Config | Security |
| SEC-03 | Inconsistent page-level auth — most pages rely on proxy+tRPC, not `auth()` | Low | Auth/UX | UX/Correctness |
| AI-02 | Assistant eval never exercises execute-level guards or resource isolation | Low | AI Assistant | Security (test) |
| AI-03 | `getDashboardStats.pendingLeaves` + `getTeamMember` over-share (tRPC parity) | Low | AI Assistant | Data |
| AI-04 | Approval is a UX confirmation, not the security boundary (record-only) | Low | AI Assistant | Security (info) |

---

## HIGH severity — details

### FIN-01 — Invoice subtotal/tax/total are trusted from the client and never recomputed
- **Module:** Finance (`finance.createInvoice` tRPC + REST `POST /api/v1/invoices`) · **Type:** Data integrity
- **Repro:** Create an invoice with `items:[{description:"Dev work",quantity:100,rate:150,amount:15000}]` but `subtotal:0, tax:0, total:0`. The server stores `total=0` while the line items represent $15,000 of work.
- **Expected vs Actual:** Server should derive `subtotal = Σ(items.amount)` and `total = subtotal + tax` (or reject a mismatch). **Actual:** the inputs are written verbatim; there is no full invoice-**edit** mutation (only `updateInvoiceStatus`), so the wrong total is permanent and flows into `totalPaid`/`totalOutstanding` aggregates. Over REST you can even send `total:-15000`, which *decrements* the paid/outstanding sums.
- **Evidence (verified first-hand):** `src/server/routers/finance.ts:201-214` writes `subtotal: input.subtotal, tax: input.tax, total: input.total` with no cross-field `.refine`. REST is worse — `src/app/api/v1/invoices/route.ts:43-48` uses bare `z.number()` for `subtotal/tax/total/amount` (no `.positive()`). Note the AI tool *does* it correctly (`src/lib/ai/tools/finance.ts:482-490` recomputes with `round2`), proving the intended behavior.
- **Suggested fix:** Recompute `amount/subtotal/total` server-side from `items + tax` in **both** tRPC and REST; ignore client-sent totals (or `.refine` they match). Add a full invoice-edit path.
- **Confidence:** High.

### FIN-02 — Every money aggregate sums across currencies (USD + PKR) into one number
- **Module:** Finance + Dashboard (summary, P&L, revenue chart, REST `/finance/summary`, AI finance tools) · **Type:** Data integrity
- **Repro:** Record June income of one USD transaction `$5,000` and one PKR transaction `Rs 280,000` (≈ $1,000). `transaction.aggregate({_sum:{amount}})` returns `285000`; the finance KPI and dashboard render it through a hardcoded `$` → **"$285,000"** (true USD-equivalent ≈ $6,000 — overstated ~47×).
- **Expected vs Actual:** Aggregates should group/convert by currency. **Actual:** no `currency` appears in any aggregate `where`/`groupBy`. PKR is a first-class currency reachable via the AI assistant and REST (`createTransaction`/`createInvoice` accept `currency:'PKR'` and render `Rs …`), making this latent-but-reachable, not theoretical.
- **Evidence (verified first-hand):** `src/server/routers/finance.ts:332-353` (summary) and `:389-396` (P&L); `src/server/routers/dashboard.ts:48-59`, `:200-214`; `src/app/api/v1/finance/summary/route.ts`; `src/lib/ai/tools/finance.ts:122-138`. UI renders hardcoded `$`: `finance-content.tsx:92`, `dashboard-content.tsx:932`.
- **Suggested fix:** `groupBy:['currency']` and report per-currency, or filter aggregates to a single currency, or convert via an FX table before summing. Never `_sum` a mixed-currency column into one scalar.
- **Confidence:** High.

### PROJ-01 — Kanban drag-and-drop moves the WRONG task when any board filter is active
- **Module:** Projects / Kanban · **Type:** Functional / Data integrity
- **Repro:** On a board, apply any filter (search text, priority, assignee, or label) so ≥1 task is hidden. Drag a visible task. A *different* task is moved and a wrong `order` is persisted.
- **Expected vs Actual:** The dragged task should move to the dropped slot. **Actual:** the rendered drag indices come from the **filtered** column list, but `handleDragEnd` splices into the **unfiltered** `board.columns` using those indices, so it removes/reinserts the wrong element and mutates with a wrong `newOrder`. (When no filter is active `filteredColumns === board.columns`, so indices align and the bug is invisible — masking it in casual testing.)
- **Evidence (verified first-hand):** `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx:164-189` — `newColumns` is derived from `board.columns`, then `sourceCol.tasks.splice(source.index,1)` / `destCol.tasks.splice(destination.index,0,…)` use filtered indices; `moveTask.mutate({ newOrder: destination.index })`. Render uses `filteredColumns` (`:372`, Draggable `index` `:483-484`); `filteredColumns` returns `board.columns` only when `!hasFilters` (`:233`).
- **Suggested fix:** Disable DnD while a filter is active, or translate the filtered source/destination indices back to real positions in `board.columns` (locate by `draggableId`) before splicing/mutating.
- **Confidence:** High.

---

## MEDIUM severity — details

### REST-01 — Full invoice/financial records reachable via a `clients:read` token
- **Module:** REST / Finance · **Type:** Security (scope confinement)
- **Repro:** `GET /api/v1/clients/<id>` with a token scoped only to `clients:read` (no `finance:read`).
- **Expected vs Actual:** A non-finance scope should not return financial data; the system's stated control is that "even a wildcard `*` token cannot read finance data." **Actual:** this route declares `clients:read`, so the admin finance double-gate never runs, and the handler returns every invoice for the client (`total/subtotal/tax/currency/status/dueDate/paidAt`). The list route similarly leaks an invoice `_count`. Impact is confined to **admin-bound** tokens (manual `isAdmin` gate), so a deliberately-narrow CRM integration token silently carries full finance read.
- **Evidence:** `src/app/api/v1/clients/[id]/route.ts:14-21` (`include: { invoices: … }`); `src/app/api/v1/clients/route.ts:22`.
- **Suggested fix:** Drop `invoices` from the `clients:read` include, or require `hasScope(ctx,'finance:read')` before including them.
- **Confidence:** High.

### FIN-03 — Dashboard revenue chart drops the last day of every month (+ month-overflow)
- **Module:** Dashboard (`dashboard.getRevenueChart`) · **Type:** Functional/Data
- **Repro:** A `$5,000` income dated `2026-05-31 10:00` is **excluded** from the May bar.
- **Expected vs Actual:** `endOfMonth = new Date(y, m+1, 0)` is the last day at `00:00:00.000`, and the query filters `date: { lte: endOfMonth }`, so anything after midnight on the final day is cut. The P&L report uses `…,0,23,59,59` and *does* include it, so the chart and the report disagree on every month's last day. Separately, `date.setMonth(date.getMonth()-i)` on today's day-of-month overflows on the 29th–31st (e.g. on May 31, stepping back to "Feb" rolls to Mar 3), duplicating/skipping a month.
- **Evidence:** `src/server/routers/dashboard.ts:190-215`; contrast `src/server/routers/finance.ts:386`.
- **Suggested fix:** Build months with `new Date(y, m-i, 1)` and set `endOfMonth = new Date(y, m+1, 0, 23, 59, 59, 999)`.
- **Confidence:** High.

### FIN-04 — "This month / this year" KPIs have no upper date bound
- **Module:** Finance (`getFinancialSummary`), Dashboard (`getStats`) · **Type:** Data
- **Repro:** Log income of `$1,000,000` dated `2030-01-01`. It appears in "Monthly Revenue" and "Net Profit" today.
- **Expected vs Actual:** Should be excluded as a future row. **Actual:** the aggregates use `date: { gte: startOfMonth }` / `{ gte: startOfYear }` with **no `lte`** (verified first-hand at `finance.ts:334,342`; `dashboard.ts:50`). The bounded P&L/chart will then disagree with the KPI.
- **Suggested fix:** Add `lte: now` (or end-of-period) to these aggregates.
- **Confidence:** High.

### FIN-05 — Recurring expenses are excluded from P&L expense and profit
- **Module:** Finance · **Type:** Functional
- **Repro:** With seeded subscriptions (~$588/mo), monthly burn/expense and profit silently omit them.
- **Expected vs Actual:** Expense/profit should include recurring costs. **Actual:** every expense figure `_sum`s the `Transaction` table only; `RecurringExpense` rows are never posted as transactions nor summed (`getRecurringExpenses` only lists them).
- **Evidence:** `src/server/routers/finance.ts:388-396`, `:419-423`; recurring rows only read at `:265-281`.
- **Suggested fix:** Materialize due recurring expenses as transactions on their due date, or add their per-period amount into expense/profit (currency-aware — see FIN-02).
- **Confidence:** Medium (may be intentional, but it overstates profit).

### FIN-06 — Invoice status: no transition guard; `paidAt`/`sentAt` never cleared; re-PAID re-fires side-effects
- **Module:** Finance (`updateInvoiceStatus` tRPC + REST + AI) · **Type:** Data/Functional
- **Repro:** Mark an invoice PAID, then back to DRAFT. It stays `DRAFT` but keeps a `paidAt` timestamp. Re-issuing PAID on an already-paid invoice overwrites `paidAt` and (AI path) re-emits the `invoice_paid` activity + "Payment received" notification/email.
- **Expected vs Actual:** Illegal transitions should be blocked, `paidAt`/`sentAt` cleared when leaving PAID/SENT, and side-effects idempotent. **Actual:** any status → any status; stamps set but never cleared (verified first-hand at `finance.ts:236-238`); no `priorStatus === status` guard (AI `finance.ts:603-620`). `OVERDUE` is also only computed at display time, so the stored status used by sums can be stale.
- **Suggested fix:** Validate allowed transitions; clear `paidAt`/`sentAt` on leaving; skip side-effects when status is unchanged.
- **Confidence:** High.

### FIN-07 — REST invoice/transaction money fields unvalidated (negatives & overflow → raw 500)
- **Module:** REST / Finance · **Type:** Security/Data
- **Repro:** `POST /api/v1/invoices` with `total: 99999999999999` → numeric-overflow against `Decimal(12,2)` → unhandled DB exception → generic 500. `total: -500` is accepted and decrements paid/outstanding sums.
- **Expected vs Actual:** Expected a clean 400 and rejection of negatives. **Actual:** bare `z.number()` (no `.nonnegative()/.max()`). The tRPC layer correctly uses `nonNegativeMoney()`; REST does not mirror it.
- **Evidence:** `src/app/api/v1/invoices/route.ts:32-49`; contrast `src/server/routers/finance.ts:8-11`.
- **Suggested fix:** Apply `.nonnegative().max(MAX_MONEY)` (and `.multipleOf(0.01)`) to all REST money fields.
- **Confidence:** High.

### DASH-01 — Activity feed leaks SHARED-note titles and cross-team activity to every employee
- **Module:** Dashboard / Notes · **Type:** Security (information disclosure)
- **Repro:** User A creates a `SHARED` note titled "Acme layoff plan" shared only with B. User C (not a recipient) opens `/dashboard` and sees `A created note "Acme layoff plan"` / `A shared note "…" with 1 member`.
- **Expected vs Actual:** SHARED notes are visible only to author + recipients (correctly enforced in `notes.list`/`getById`/`search`). **Actual:** the feed is filtered **only** for finance event types — not by note visibility or project membership — so SHARED-note titles, plus task/project/client names from projects the viewer can't access, are broadcast to all authenticated users. The developer comment intends "team-visible" but the check is `visibility !== 'PRIVATE'`, which **includes** SHARED.
- **Evidence (verified first-hand):** `src/server/routers/notes.ts:260-263` (logs title for any non-PRIVATE note), `:385` (share activity with title); `src/server/routers/dashboard.ts:92-93` (`where: isAdmin ? {} : { type: { notIn: financeTypes } }`); rendered for all users (`dashboard-content.tsx:888`, SSR-prefetched).
- **Suggested fix:** Scope the feed to the viewer's visibility — exclude note activity for notes they can't access (or strip titles) and filter project/task/client activity to their memberships.
- **Confidence:** High.

### HR-01 — Leave requests can be self-approved and re-decided (no separation of duties)
- **Module:** Team/HR (`team.updateLeaveStatus`) · **Type:** Security (separation of duties)
- **Repro:** As HR (or admin), submit your own leave request, then `team.updateLeaveStatus({ id:<own>, status:'APPROVED' })` — it succeeds. You can also flip an already-`APPROVED` request to `REJECTED`.
- **Expected vs Actual:** A reviewer should not approve their **own** leave, and only `PENDING` requests should be decidable — exactly how the sibling `resignation:review` flow works. **Actual:** only the coarse `leave:approve` capability (HR/ADMIN) is checked; no owner/PENDING resource conditions. The AI mirror `setLeaveStatus` filters PENDING but still lacks self-exclusion.
- **Evidence:** `src/lib/abac/policies.ts:44` (`'leave:approve': [isHrOrAdmin]` — no attribute conditions); `src/server/routers/team.ts:235-246`; compare `policies.ts:60-66`.
- **Suggested fix:** Load the request and reject if `leave.userId === self` or `leave.status !== 'PENDING'`; ideally add an attribute-conditioned `leave:approve` policy mirroring `resignation:review`.
- **Confidence:** High.

### NOTE-01 — A non-author editor can change a note's visibility (SHARED→TEAM exposure)
- **Module:** Notes (`notes.update`) · **Type:** Security (integrity / confidentiality)
- **Repro:** A shares a `SHARED` note with B as `EDIT`. As B: `notes.update({ id, visibility:'TEAM' })` → the note is now visible company-wide. Or set `PRIVATE` to lock the author's other collaborators out. Any user can do the same to a `TEAM` note (TEAM is editable by all).
- **Expected vs Actual:** Visibility/sharing is the author's prerogative (`setShares` is author-only). **Actual:** `update` gates only on `canEdit`, which returns true for SHARED+EDIT grantees and *anyone* on a TEAM note, yet freely writes `visibility` (and `projectId`/`clientId`).
- **Evidence:** `src/server/routers/notes.ts:71-76` (`canEdit`), `:294-298`; contrast author-only `:368`. AI mirror identical (`src/lib/ai/tools/notes.ts:68-82`, `:357-359`).
- **Suggested fix:** Restrict `visibility` (and project/client re-attach) to `note.authorId === userId` (or ADMIN); editors get content/title only.
- **Confidence:** High.

### RT-01 — Video-call attendance (`logJoin`) bypasses the anti-backfill window
- **Module:** Meetings · **Type:** Data integrity
- **Repro:** As an attendee of a 09:00–09:30 standup, open `/meetings/<id>/call` at 02:00. The conference connects, fires `videoConferenceJoined → logJoin`, and you are stamped "present" for the resolved occurrence.
- **Expected vs Actual:** `markJoined` deliberately refuses attendance outside `[start−5min, end]` ("prevent retroactive attendance lies"). **Actual:** `logJoin` — the *primary*, auto-fired attendance signal — has **no window check**, so the strict and lax paths disagree and the lax one is the one users actually hit.
- **Evidence:** `src/server/routers/meetings.ts:404-467` (`logJoin`, no guard) vs `:261-271` (`markJoined` window check).
- **Suggested fix:** Apply the same `[start−5min, end]` gate in `logJoin` (factor into a shared helper).
- **Confidence:** High.

### RT-02 — No realtime revocation when a member leaves/is removed
- **Module:** Realtime / Chat · **Type:** Security (live data exposure)
- **Repro:** B is removed from private channel C (or leaves with the tab open). A posts a message; B's still-attached Ably subscription receives it and patches B's cache.
- **Expected vs Actual:** Removal should immediately cut B off. **Actual:** `removeMember` is a bare `deleteMany` with no emit; the Ably token capability is computed only at mint time with no explicit short `ttl`; the client re-authorizes only when *new* channels appear, never on removal — so B keeps receiving live messages until a refetch + token renewal (default ~60 min) drops the subscription. (History is correctly blocked by `assertChannelMember`, so this is a live-stream leak, not history.)
- **Evidence:** `src/server/routers/chat.ts:619-635`; `src/app/api/ably-token/route.ts:45-57`; `src/components/chat/realtime-provider.tsx:200-212`.
- **Suggested fix:** On `removeMember`/`leaveChannel`, emit a `user:{id}` "membership changed" event so the client refetches channels and calls `client.auth.authorize()` immediately; use a short token TTL.
- **Confidence:** High (mechanism confirmed; exact window TTL/refetch-dependent).

### RT-03 — `logLeave` never fires on SPA navigation or tab close → open attendance sessions
- **Module:** Meetings · **Type:** Functional / Data
- **Repro:** Join a call, then leave by clicking another nav link or closing/refreshing the tab (instead of the in-call hang-up). `leftAt` is never written; the log row stays open indefinitely.
- **Expected vs Actual:** Every join should get a matching `leftAt`. **Actual:** `logLeave` is wired only to Jitsi's `videoConferenceLeft`/`readyToClose`; the effect cleanup only `dispose()`s the iframe and there is no `beforeunload`/`pagehide`/`visibilitychange` handler, so the common exit paths skew any duration/attendance-% math.
- **Evidence:** `src/components/meetings/meeting-call.tsx:113-138`; `logLeave` is no-op-safe (`src/server/routers/meetings.ts:495-505`).
- **Suggested fix:** Call `logLeave` in the effect cleanup and on `pagehide`/`visibilitychange(hidden)` (use `navigator.sendBeacon`/keepalive for unloads).
- **Confidence:** High.

### RT-04 — Editing a message to add an `@mention` creates no notification
- **Module:** Chat · **Type:** Functional
- **Repro:** Send "hello", edit to "hello @Bob". Bob's mention row and highlight are created, but he gets no bell/notification.
- **Expected vs Actual:** `sendMessage` fires `notify()` + `emitToUser` for new mentions; `editMessage` recomputes and persists `validMentions` but never notifies.
- **Evidence:** `src/server/routers/chat.ts:341-397` (no `notify`/`emitToUser` after the edit transaction).
- **Suggested fix:** Diff new mentions against the pre-edit set and notify the newly-added ones.
- **Confidence:** High.

### RT-05 — Uploaded files (incl. private-DM voice/attachments) are world-readable by URL
- **Module:** Upload · **Type:** Security
- **Repro:** Send a voice message/attachment in a private DM → it lands at `public/uploads/<uuid>-<name>`, served statically at `/uploads/…` with no auth. Anyone who obtains the URL (a since-removed member, a referer/log leak, link sharing) can fetch it forever.
- **Expected vs Actual:** Message *content* is gated by membership, but the underlying *file bytes* have zero authorization. The UUID prefix prevents enumeration but not post-disclosure access.
- **Evidence (verified first-hand):** `src/app/api/upload/route.ts:80-89` writes to `public/uploads` and returns `/uploads/…`; `public/uploads/` exists and is statically served. (The MIME+extension allowlist is solid against stored-XSS — `.html`/`.svg` excluded.)
- **Suggested fix:** Serve attachments through an authenticated route that re-checks `assertChannelMember`, or use signed short-lived URLs (Vercel Blob with token).
- **Confidence:** High (severity depends on deployment; prod uses public storage).

### REST-04 — No rate limiting anywhere (REST API and login)
- **Module:** Platform · **Type:** Security (DoS / brute-force)
- **Repro:** Any endpoint (and the NextAuth login `authorize`) can be called in an unbounded loop; invalid-token floods are never throttled.
- **Expected vs Actual:** Expected per-token/per-IP limits returning 429. **Actual:** none exist (repo-wide grep for `rate.?limit|throttle|upstash|429` returns nothing; `proxy.ts:14-22` short-circuits `/api/v1` with no limiting). Each auth attempt runs a bcrypt `compare` per prefix-matching candidate, so unthrottled floods are CPU-amplifying.
- **Evidence:** `src/proxy.ts:14-22`; `src/lib/api-auth.ts:55-57`; `src/lib/auth.ts:89`.
- **Suggested fix:** Add per-token + per-IP rate limiting (edge middleware / Upstash), and cap login + auth attempts.
- **Confidence:** High.

### PROJ-02 — `order` treated as a contiguous index; Trello import writes gapped orders
- **Module:** Projects/Kanban + Trello import · **Type:** Data integrity
- **Repro:** Import a Trello board whose cards interleave across lists, then drag a task one slot in an imported column — the move silently no-ops or misorders.
- **Expected vs Actual:** Import assigns a **global** running counter as each task's order, so a column can have orders like `[2,5,9]`. `moveTask` then does range math (`order: { gte: newOrder, lt: oldOrder }`) assuming `newOrder` (a client array index) is comparable to the stored `order` — `gte:1, lt:2` matches nothing, so the task doesn't move.
- **Evidence:** `src/server/routers/trello-import.ts:155-160` (global `tasksCreated` counter); `src/server/routers/projects.ts:646-656`.
- **Suggested fix:** Normalize `order` per-column on import (0..n); have `moveTask` recompute positions from the actual ordered list rather than trusting client indices.
- **Confidence:** High.

### PROJ-03 — Deleting a column silently cascade-deletes all its tasks
- **Module:** Projects/Kanban · **Type:** Data loss / UX
- **Repro:** Click the trash icon on a column with tasks → tiny inline "Delete / No" with no count → all tasks (and their comments/checklists/attachments) are permanently destroyed.
- **Expected vs Actual:** Expected a warning naming the task count or a move-first flow. **Actual:** `Task.column` is `onDelete: Cascade` and the UI shows no count.
- **Evidence:** `prisma/schema.prisma:472`; `src/app/(app)/projects/[id]/board/[boardId]/kanban-board.tsx:417-431`; `src/server/routers/projects.ts:842-847`.
- **Suggested fix:** Block deletion of non-empty columns, or show "This will delete X tasks" and require explicit confirmation.
- **Confidence:** High.

### PROJ-04 — Task attachments are fetched but never rendered, and cannot be added
- **Module:** Projects/Kanban · **Type:** Functional / Missing UI
- **Repro:** Open a task that has attachments (e.g. imported from Trello). The card shows a paperclip count, but the detail sheet renders no attachments section, so they're unreachable.
- **Expected vs Actual:** `getTaskDetail` includes `attachments` (`projects.ts:885`) but `task-detail-sheet.tsx` never references them, and there is no `addTaskAttachment`/`deleteTaskAttachment` mutation anywhere.
- **Suggested fix:** Render an Attachments section and add upload/delete (reuse the `/api/upload` pipeline).
- **Confidence:** High.

### PROJ-05 — `createTask` / `updateTaskAssignees` accept arbitrary user IDs
- **Module:** Projects/Kanban · **Type:** Data integrity / Authz consistency
- **Repro:** Call `createTask`/`updateTaskAssignees` with a `userId` that is not a project member (assigned + emailed about a project they're not on) or that doesn't exist (raw Prisma FK 500).
- **Expected vs Actual:** `setColumnDefaultAssignees` validates membership (`projects.ts:457-470`); `createTask` (`:529-541`) and `updateTaskAssignees` (`:950-955`) do not — and the latter `createMany` has no `skipDuplicates`/validation, so a dup/invalid ID throws.
- **Suggested fix:** Validate `assigneeIds` against `ProjectMember` before create.
- **Confidence:** High (FK-500); Medium (non-member assignment).

### CLI-01 — Deleting a client with invoices fails with a raw FK error
- **Module:** Clients · **Type:** Error handling / UX
- **Repro:** As admin, delete a client that has ≥1 invoice → the page fails with a generic error.
- **Expected vs Actual:** Expected a clean "Cannot delete: client has invoices" or a defined cascade. **Actual:** `Invoice.clientId` is a required relation with **no `onDelete`** (Prisma default = Restrict; contrast contacts/contracts/transactions which are explicit `Cascade`), so the delete throws P2003 surfaced as a generic error, and the UI renders no `deleteClient.error`.
- **Evidence:** `prisma/schema.prisma:612`; `src/server/routers/clients.ts:254-267`.
- **Suggested fix:** Pre-count invoices and return a friendly `BAD_REQUEST` (or define an explicit referential action); surface the error in the UI.
- **Confidence:** High.

### AI-01 — `resetMemberPassword` ships a Groq-incompatible `pattern`/`allOf` tool schema
- **Module:** AI Assistant · **Type:** Functional (availability)
- **Repro:** Admin asks "reset Aisha's password to Hunter2024" → routes to the `people` domain → `resetMemberPassword` is offered to Groq with `newPassword: passwordSchema` (`z.string().min(8).regex(...).regex(...).regex(...)`).
- **Expected vs Actual:** The codebase's own convention is to keep `format`/`pattern`/`allOf` out of schemas sent to Groq (its strict validator 400s the whole request) — `inviteMember` and client-website tools deliberately drop `.email()`/`.url()` and validate in `execute`. **Actual:** `passwordSchema` serializes (zod v4 → JSON Schema, the AI SDK path) to `allOf:[{pattern:…},{pattern:…},{pattern:…}]`. If Groq rejects `pattern`/`allOf` as it does `format`, the **entire request 400s**, breaking every admin turn that loads the `people` domain (lay-off, hire, role change, leave approval) — and, because approval-continuations force the full toolset, potentially the execution of any admin-approved write.
- **Evidence:** `src/lib/ai/tools/people.ts:940` (`newPassword: passwordSchema`); `src/lib/password-policy.ts:21-26`; contrast `people.ts:722-737`; force-full-toolset `src/app/api/assistant/route.ts:64`.
- **Suggested fix:** Use `newPassword: z.string().min(8)` and call the exported `passwordMeetsPolicy()` inside `execute`.
- **Confidence:** Medium (pattern emission confirmed; the 400 outcome depends on Groq's handling — verify with one admin people-domain request).

### AUTH-01 — Password change does not revoke other active sessions
- **Module:** Auth / Settings · **Type:** Security (session management)
- **Repro:** Sign in on devices 1 and 2; change password on device 1; device 2 keeps working up to the 8h token lifetime.
- **Expected vs Actual:** A password change should invalidate other sessions. **Actual:** the JWT revalidation re-reads only `role/status/department/title`, never a password epoch, so pre-change stateless tokens stay valid.
- **Evidence:** `src/lib/auth.ts:182-193`; `src/server/routers/team.ts:338-342`.
- **Suggested fix:** Add `passwordChangedAt`/`tokenVersion` to `User`, stamp it into the JWT at sign-in, compare on each `jwt()` refresh and force logout on mismatch (also enables force-logout on lay-off/reset).
- **Confidence:** Medium (inherent to JWT, but fixable).

---

## LOW severity — details (condensed)

- **REST-02 — `/api/v1/spec` bypasses `withApiAuth`, never audited.** `src/app/api/v1/spec/route.ts:15-33` calls `authenticateApiRequest` directly with no `recordRestAudit`, so reads of the full API map and 401 attempts on this path leave no audit trail (405s on other routes are similarly unaudited). *Fix:* wrap with `withApiAuth` or record manually. — Security · High conf.
- **REST-05 — Malformed JSON body → 500 instead of 400.** `await request.json()` throws before Zod and is caught as a generic 500 (no leak, wrong status, pollutes 500 metrics). Affects every write handler. *Fix:* shared `parseJson` returning 400 on `SyntaxError`. — Functional · High conf.
- **REST-06 — `?limit=abc` → 500 on `/tasks` & `/transactions` GET.** `parseInt('abc')→NaN → take:NaN →` Prisma error → 500 (clients/projects/invoices/meetings already clamp safely). `src/app/api/v1/tasks/route.ts:14,27`; `transactions/route.ts:12,26`. *Fix:* `parseInt(x,10)||default` + `Math.max(...,1)`. — Functional · High conf.
- **REST-07 — Unvalidated FKs → 500.** `assigneeIds`/`labelIds`/`attendeeIds`/`projectId` inserted without existence checks → Prisma FK violation → generic 500. `tasks/route.ts:98-105`, `meetings/route.ts:48`, `transactions/route.ts:76-79`. *Fix:* validate referenced IDs exist (and assignees are project members) → 400/404. — Validation · High conf.
- **FIN-08 — Float arithmetic on Decimals.** `Number(_sum)-Number(_sum)` and margin `%` run in JS float (`finance.ts:359-363`, `ai/tools/finance.ts:146-147`) → `0.20000000000000018` artifacts in raw API/AI JSON (masked by `toLocaleString` in UI). *Fix:* subtract in `Prisma.Decimal`/integer cents. — Data · Medium conf.
- **FIN-09 — Month-end ms + invoice numbering.** P&L `endOfMonth` uses `…59,59` (no ms), dropping a `23:59:59.5` row (`finance.ts:386`); `INV-${year}-${count+1}` from a non-transactional global `count()` (`finance.ts:197-199`) can produce duplicate numbers under concurrency and never resets to `-001` in a new year. *Fix:* `…59,999` and an atomic per-year sequence. — Data · High conf.
- **AUTHZ-02 — No last-admin guard on `adminUpdateMember`.** Admin-only, so not escalation/IDOR, but the sole remaining admin can demote/deactivate themselves → zero-admin lockout. Guard exists in `layOffMember` (`team.ts:453-462`) and the AI `updateMember`, but not here (`team.ts:346-397`). *Fix:* mirror the last-admin check. — Availability · High conf.
- **AUTHZ-04 — Client-directory trust boundary inconsistent.** REST treats clients as admin-only (`clients/[id]/route.ts:10`), tRPC exposes the directory to every employee (`clients.ts:16-44`, `search.ts:72-77`), the AI scopes non-admins to project-reachable clients but `globalSearch` shows all names. *Fix:* pick one policy and apply uniformly. — Security (info) · High conf.
- **RT-06 — Non-atomic attendance create → P2002 race.** `findUnique`-then-`create` (not `upsert`) means a genuine concurrent double-join throws an unhandled unique-constraint 500 (the comment claims a no-op). `meetings.ts:275-300,424-444`. *Fix:* `upsert` on the unique key, or catch P2002. — Data · High conf.
- **RT-08 — Client message ordering has no id tiebreak.** Server orders `[createdAt desc, id desc]` (`chat.ts:102`) but the client re-sorts on `createdAt` only (`message-list.tsx:64-66`) → same-ms messages can reshuffle/diverge. *Fix:* add an `id` tiebreak. — Realtime · Medium conf.
- **RT-09 — Read receipts broadcast to the whole channel.** `markRead` emits each user's `lastReadAt` to `channel:{id}` (`chat.ts:472-476`) though clients only act on their own → any subscriber can observe everyone's read times. *Fix:* emit to the actor's own `user:{id}` channel. — Privacy · High conf.
- **RT-10 — Recurring-meeting list hides just-finished occurrence.** `findRelevantOccurrence` picks the nearest occurrence, so in the latter half of a gap the list shows the next (empty) occurrence and the prior occurrence's attendance disappears early (`meeting-occurrence.ts:99-103`). *Fix:* prefer the most recent past occurrence until the next starts. — Functional · Medium conf.
- **PROJ-06 — `addComment` doesn't verify `parentId` belongs to the task.** Only `assertTaskAccess(taskId)` runs; a `parentId` from another task is threaded in, creating an orphaned reply (`projects.ts:890-911`). *Fix:* assert `parent.taskId === input.taskId`. — Data · High conf.
- **PROJ-07 — Completion logged only for a column named exactly `"Done"`.** Case-sensitive equality (`projects.ts:701`) misses "Shipped"/"Complete"/imported lists, while the board preview uses a `DONE_RE` regex (`project-detail-content.tsx:55`) — inconsistent. *Fix:* share the heuristic or add a per-column "is done" flag. — Business logic · High conf.
- **CON-01 — `endDate` before `startDate` accepted.** No cross-field `.refine` on contracts (`clients.ts:166-205`), projects (`projects.ts:122-135`), or milestones; the UI renders "Dec 1 – Jan 1". *Fix:* `.refine(end >= start)`. — Validation · High conf.
- **CON-02 — `signedAt` auto-stamp inconsistent.** The inline status dropdown stamps `signedAt` on SIGNED (`clients.ts:227-233`); the edit form's `updateContract` doesn't (`:207-217`). *Fix:* apply the same stamp-on-first-SIGNED logic in both. — Logic · High conf.
- **TRELLO-01 — Malformed dates crash the whole import.** `new Date(card.due)` / `new Date(comment.date)` on a non-parseable string → Invalid Date → the entire transactional import fails generically (`trello-import.ts:162,242`; schema only constrains to `string`). *Fix:* guard `isNaN(d.getTime())`. — Robustness · Medium conf.
- **CLI-02 — Contact validation gap + no contact CRUD UI.** `addContact` uses `email: z.string().optional()` while `create` uses `.email()` (`clients.ts:147` vs `:98`); the Contacts tab only lists — there's no UI to add/edit/remove a contact post-creation and no `updateContact` mutation at all. *Fix:* align validation; add contact CRUD UI + mutation. — Validation/UI · High conf.
- **UX-01 — Client forms swallow validation errors.** `optionalWebsiteUrl` rejects non-`http(s)` values (`validators.ts:33-39`) but neither the create nor edit form renders the mutation error (`clients-content.tsx`, `client-detail-content.tsx`) — the form just sits there. *Fix:* render `createClient.error`/`updateClient.error` inline. — UX · High conf.
- **HR-02 — Leave requests accept invalid/overlapping/past dates.** `createLeaveRequest` validates each field independently and passes straight to `create` (`team.ts:220-233`) — `endDate < startDate`, past dates, and duplicate overlaps all pass, corrupting "out today"/team-stats math. *Fix:* `.refine(end >= start)`, reject past start, check overlaps. — Validation · High conf.
- **DASH-02 — `getStats` returns company-wide pending-leave count to non-admins.** `pendingLeaves` is computed unconditionally (`dashboard.ts:33-35`) though the card only renders for admins; the value still ships to every client. The AI `getDashboardStats` mirrors this (`insights.ts:500`), and `getTeamMember` returns any colleague's full project-membership list (`people.ts:110-113`). *Fix:* gate/scope server-side. — Info exposure · High conf. *(= AI-03.)*
- **AUTH-02 / SEC-03 — Edge middleware authorizes on cookie presence only.** `proxy.ts:24-33` substring-matches the cookie name without verifying the JWT, and `pathname.includes('.')` (`:19`) treats any dotted path as a static asset. Real enforcement is downstream (`auth()` + tRPC), so this is defense-in-depth, not a direct leak — but a stale/forged cookie passes the edge gate and lands on a broken shell instead of a clean login redirect (most pages, unlike finance/audit-logs/team-stats/hr, don't call `auth()` at the page level). *Fix:* verify with `getToken`/`auth` in middleware; add a shared page-auth guard. — Security/UX · High conf (behavior), Low (severity).
- **SEC-01 — CSP `connect-src` ends with `ws: wss:` wildcards.** `next.config.ts:33` appends blanket `ws: wss:`, allowing a WebSocket to *any* host and nullifying the carefully-scoped Ably/8x8 allowlist above it; the `socketOrigin` (`NEXT_PUBLIC_SOCKET_URL`) is the stale Socket.IO origin (live header showed `http://localhost:3001`). *Fix:* drop `ws: wss:` and the dead socket origin. — Security · High conf. *(Independently flagged by the realtime specialist.)*
- **SEC-02 — `img-src 'self' data: https:` allows any HTTPS image.** `next.config.ts:31` permits images from any origin (tracking-pixel/exfil surface), laxer than the next/image host lock-down. *Fix:* restrict to the app origin + known avatar hosts. — Security · Medium conf.
- **AI-02 — Assistant eval never tests execute-level guards or isolation.** Employee/HR cases build the toolset with that role's context, so privileged tools aren't even constructed — the `forbid`/`mustNotInclude` assertions pass *vacuously* and the in-`execute` `if (!h.isAdmin) return {error}` checks are never exercised; no cross-user IDOR case exists. `scripts/assistant-eval.ts:163-186,232`. *Fix:* add cases invoking an admin tool's `execute` under an employee subject (expect `{error}`) and note/DM/meeting isolation cases. — Security (test) · High conf.
- **AI-04 — Approval is a UX confirmation, not the security boundary.** The client supplies the full message history including approval parts; a forged `approved:true` with a matching `approvalId` could skip the user's *own* confirmation — but every write re-checks authorization in `execute`, so there is no cross-user/privilege impact. Recorded so the in-`execute` authz is never relaxed on the assumption the approval gate protects it. `route.ts:34`. — Info · High conf.

---

## Coverage checklist

Every module, page, and endpoint below was exercised (✅ tested). "Findings" lists IDs raised; "clean" means reviewed with no defect (notable correct controls noted).

### Pages / routes (`src/app`)
| Route | Tested | Notes / findings |
|---|---|---|
| `/login`, `/` redirect | ✅ | Live-probed: 307→`/login`; timing-oracle login verified clean |
| `/invite/[token]` | ✅ | 256-bit token, SHA-256, single-use, 7-day expiry, no role/email mass-assign — clean |
| `/dashboard` | ✅ | DASH-01, DASH-02, SEC-03 |
| `/projects`, `/projects/[id]`, `/projects/[id]/board/[boardId]` | ✅ | PROJ-01..07 |
| `/projects/import` (Trello) | ✅ | PROJ-02, TRELLO-01; attribution forgery prevented — clean |
| `/clients`, `/clients/[id]` (+ contacts, contracts) | ✅ | CLI-01/02, CON-01/02, UX-01, AUTHZ-04 |
| `/finance` | ✅ | Page hard-gates ADMIN; FIN-01..09, REST-01 |
| `/hr` | ✅ | Page gates ADMIN/HR; HR-01, HR-02 |
| `/team`, `/team/[id]`, `/team/stats` | ✅ | AUTHZ-02; team-stats admin-gated, directory PII note (see Improvements) |
| `/meetings`, `/meetings/[id]/call` (video) | ✅ | RT-01, RT-03, RT-06, RT-10; JaaS minting gated — clean |
| `/notes`, `/notes/[id]` | ✅ | NOTE-01; Tiptap render XSS-safe — clean |
| `/chat` | ✅ | RT-02, RT-04, RT-05, RT-08, RT-09; channel/DM authz solid — clean |
| `/audit-logs` | ✅ | Admin-gated (page + every procedure) — clean |
| `/settings` | ✅ | AUTH-01; `updateProfile` whitelist (no self-escalation) — clean |
| `/api-docs`, `/brand` | ✅ | `/brand` public by design; spec auth-gated (REST-02) |

### tRPC routers (`src/server/routers`)
dashboard ✅ · projects ✅ · finance ✅ · clients ✅ · chat ✅ · chat-helpers ✅ · team ✅ · team-stats ✅ · resignations ✅ (clean) · invitations ✅ (clean) · notes ✅ · meetings ✅ · audit ✅ (clean) · api-tokens ✅ (clean) · search ✅ (clean) · trello-import ✅

### REST API (`src/app/api/v1`)
spec ✅ · tasks (+`[id]`,`/comments`) ✅ · boards/[id] ✅ · projects (+`[id]`) ✅ · clients (+`[id]`) ✅ · team ✅ · meetings ✅ · invoices (+`[id]`) ✅ · transactions (+`[id]`) ✅ · finance/summary ✅ — every route mapped to scope; finance double-gate verified live; object-scoping verified clean except REST-01.

### Cross-cutting
Auth/session (`auth.ts`, `proxy.ts`) ✅ · ABAC engine + policies ✅ · object-level `authz.ts` ✅ · AI assistant (route + 10 tool domains + prompt + context + eval) ✅ · realtime (Ably token, emit) ✅ · upload ✅ · security headers/CSP ✅ · build health ✅ · rate limiting ✅ (absent — REST-04).

### Authorization matrix (verified)
Finance read (EMPLOYEE/HR ❌, ADMIN ✅) · layoff (HR not vs admin, last-admin protected) · setRole (ADMIN only) · resignation review (not own, HR not vs admin, PENDING) · channel/DM (member-only, no admin DM bypass) · project/task/board/column (member; manage=LEAD/ADMIN) · notifications/profile (self-only) — **all enforced**. The one separation-of-duties gap is **leave approval** (HR-01); the one feed-level leak is **DASH-01**.
