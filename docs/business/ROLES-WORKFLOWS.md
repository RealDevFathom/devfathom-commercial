# Roles and workflows

**Snapshot:** 2026-07-12  
All rules below are **Verified** against the enforcing code unless labelled otherwise. File paths are the durable evidence.

## Personas

| Persona                     | Definition                                        | Where authority comes from                                                                                                                      |
| --------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**                   | App `Role = ADMIN`                                | `admin:access` capability; can do everything HR can, plus finance, audit, API tokens, webhooks, role changes                                    |
| **HR**                      | App `Role = HR`                                   | `hr:access` capability; people lifecycle, leave approval, resignation review, reviews — but not finance/audit/roles, and cannot act on an admin |
| **Employee**                | App `Role = EMPLOYEE`                             | Active workspace, own work, own leave/resignation, team directory, project/channel/note participation                                           |
| **Project lead**            | `ProjectMember.role = LEAD` on a specific project | Manage that project's structure and membership (independent of app Role)                                                                        |
| **Channel owner/admin**     | `ChannelMember.role = OWNER/ADMIN`                | Manage that channel (except DMs)                                                                                                                |
| **Automation owner**        | Holder of a `df_` API token, bound to a user      | Acts as the bound user, limited to token scopes                                                                                                 |
| **External client contact** | A `ClientContact` record                          | Represented in the system; **cannot log in** — even invoice email links resolve to authenticated internal routes                                |

## Permission matrix

| Action                                     |   Employee   |      HR      |      Admin       | Enforcement                                   |
| ------------------------------------------ | :----------: | :----------: | :--------------: | --------------------------------------------- |
| Use workspace (status `ACTIVE`/`ON_LEAVE`) |      ✅      |      ✅      |        ✅        | `assertActive`, `ACTIVE_STATUSES`             |
| Team directory (redacted)                  |      ✅      |      ✅      |        ✅        | `team.getAll`/`getRoster`                     |
| Own leave & resignation                    |      ✅      |      ✅      |        ✅        | `team`, `resignations` routers                |
| Approve/reject leave                       |      ❌      |      ✅      |        ✅        | `capabilityProcedure('leave:approve')`        |
| Resignation queue & review                 |      ❌      |      ✅      |        ✅        | `hrProcedure` + ABAC `resignation:review`     |
| Lay off a non-admin                        |      ❌      |      ✅      |        ✅        | ABAC `team:layoff`                            |
| Lay off / administer an admin              |      ❌      |      ❌      |        ✅        | ABAC (`targetRole !== 'ADMIN'` for HR)        |
| Change roles                               |      ❌      |      ❌      |        ✅        | `team.adminUpdateMember`                      |
| Finance (invoices, payments, P&L)          |      ❌      |      ❌      |        ✅        | `adminProcedure`; REST also admin-bound token |
| Audit logs                                 |      ❌      |      ❌      |        ✅        | `adminProcedure`                              |
| API tokens & webhooks                      |      ❌      |      ❌      |        ✅        | `adminProcedure`                              |
| Manage a project's structure               |  LEAD only   |      —       |        ✅        | `canManageProject` (LEAD or admin)            |
| Read a private DM                          | members only | members only | **members only** | `assertChannelMember` — no admin bypass       |

Object-level roles (project LEAD/MEMBER, channel OWNER/ADMIN/MEMBER, note author/share, meeting creator/attendee) sit **beneath** the app-role table and are checked per record.

## Dashboard

**Verified** (`src/app/(app)/dashboard/dashboard-content.tsx`). Role-aware; sections in order: greeting; widget customizer (toggles persisted via `dashboard.updatePreferences`); next-meeting countdown; KPI row — Revenue This Month _(admin)_, Active Projects, Tasks Completed (this week), and Outstanding Invoices + net cash _(admin)_ **or** Pending Leaves _(non-admin)_; Revenue Chart _(admin)_; My Tasks; Upcoming Deadlines (milestones); Recent Activity; Active Projects grid.

## Lifecycle workflows

### Team invite → signup

`team.inviteMember` (admin) creates a `User` with `status = INVITED`, no password, a single-use SHA-256-hashed token with a **7-day** TTL, and sends the invite email (returns an `inviteUrl` for manual sharing). The public `/invite/[token]` page uses `invitations.get` + `invitations.accept`: the invitee sets a policy-checked password, **phone is required**, bio/skills optional; identity fields (name/email/title/department/role) are fixed by the inviter. Acceptance flips status to `ACTIVE`. Re-invite is allowed only while still `INVITED`.

### Leave request → approval → balance

`team.createLeaveRequest`: type `VACATION`/`SICK`/`REMOTE`; rejects a past start, requires `endDate ≥ startDate`, and rejects overlap with the requester's own `PENDING`/`APPROVED` leave. `updateLeaveRequest`/`cancelLeaveRequest` work only on own `PENDING` rows. `team.updateLeaveStatus` (`leave:approve`): **cannot decide your own request**, only `PENDING` is decidable; sets `APPROVED`/`REJECTED` and notifies. Balances: `team.setLeaveBalance` (HR) sets entitlement per (user, year, type); **used days are derived from approved requests**, not written on approval.

### Review cycles

`reviews.createCycle`/`closeCycle`/`reopenCycle` (HR; `OPEN`↔`CLOSED`). `addReview` (HR) assigns a reviewer→subject as a `DRAFT` (unique per cycle/subject/reviewer). `submitReview` (protected): only the assigned reviewer, only while the cycle is `OPEN`; rating 1–5 + text → `SUBMITTED`. Visibility: HR/admin see all; others see reviews they authored plus `SUBMITTED` reviews about themselves — **draft reviews about you are never exposed**.

### Resignation → review → offboarding

`resignations.submit` (`resignation:request`): reason 10–2000 chars + proposed last day; **one `PENDING` at a time**; notifies admins/HR. `withdraw` (own, `PENDING` → `WITHDRAWN`). `review` (HR + ABAC `resignation:review`): cannot review your own; HR cannot review an admin; `PENDING` only → `APPROVED`/`DECLINED`, records last working day. **Offboarding is only semi-automatic:** if the approved last day is on or before today, the account is set `INACTIVE` inside `review`; a **future** last day is _not_ automated — no scheduled job exists (finding 19 / R-015). Decision is emailed.

### Layoff / termination

`team.layOffMember` (HR). Guards (Verified): cannot lay off yourself; ABAC `team:layoff` blocks HR from laying off an admin; **cannot lay off the last active admin**. Effect: status → `INACTIVE` **and `tokenVersion` bumped** (kills live sessions), audit annotated, best-effort deactivation email. Note the direct-route gap: a deactivated user's still-valid JWT can reach `/api/assistant`, `/api/ably-token`, `/api/upload`, `/api/files/[name]` until it expires — see [runbooks §4](../operations/RUNBOOKS.md#4-authentication-or-session-compromise).

### Client → contract → project → invoice

Records link as: `Client` → `ClientContact` (primary flag) → `Contract` (optionally to a project) → `Project` (`clientId`, type `CLIENT`/`INTERNAL`) → `Invoice` (`clientId` required, `projectId` optional) → `Payment[]`; transactions optionally link client + project. Contract dates are guarded: **end cannot precede start** (`clients.addContract`/`updateContract`, only when both are supplied).

### Invoice and payment state machine

- **Create** (`finance.createInvoice`, admin): line items `{description, quantity, rate}`; the **server recomputes** each amount, subtotal, and total (+tax) — caller-supplied money is never trusted. Number `INV-<year>-NNN`, sequence resets yearly. Starts `DRAFT`.
- **Send** (`finance.sendInvoiceEmail`): emails the client's primary contact using the `invoiceIssued` template. **Finding 16 (Verified):** the CTA links to `{appUrl}/finance/invoices/{id}/print` — an **authenticated internal route inside `(app)`** — so an external client clicking it hits the login redirect. DRAFT→SENT only after a successful send.
- **Payments** (`finance.addPayment`): partial allowed; **rejected for DRAFT** ("send first"), PAID, and CANCELLED; re-sums prior payments and **rejects overpayment** (half-cent tolerance); **payment inherits the invoice currency** (no currency input). Flips to PAID when payments cover the total, which is the only place the `invoice.paid` webhook fires.
- **Overdue** (`finance.markOverdueInvoices`): **operator-triggered** — flips past-due SENT → OVERDUE; a comment notes it is "the action a nightly cron would call."
- **State machine** (`finance.updateInvoiceStatus`, `ALLOWED` map, Verified exactly):

```
DRAFT     → SENT | CANCELLED
SENT      → PAID | OVERDUE | CANCELLED | DRAFT
OVERDUE   → PAID | CANCELLED | SENT
PAID      → CANCELLED
CANCELLED → DRAFT
```

### Project and task lifecycle

Board → Column (ordered, optional WIP limit, per-column default assignees auto-added on task entry) → Task (priority, due date, subtasks, blockers). Rules (Verified in `projects.ts`): **assignees and column default-owners must be project members**; **a subtask stays on the same board as its parent**; **the blocker graph cannot cycle** (DFS check on `addBlocker`); **the last project lead cannot be removed or demoted**. Tasks carry checklists, threaded comments, attachments, labels, and milestones. **Time is logged manually** (decimal hours + date) — there is no start/stop timer.

### Meetings and attendance

`meetings.create`: recurrence daily/weekly/biweekly/monthly or null (one-time); creator auto-added. **Attendance is occurrence-scoped** (`MeetingAttendanceLog` keyed by `occurrenceStart`): `markJoined` (manual), `logJoin` (auto from the embedded call, counted only within `[start−5min, end]`, idempotent), `logLeave`. `getAttendanceReport` derives per-person attendance across occurrences. `getCallToken` backs the JaaS call at `/meetings/[id]/call`.

### Notes

Tiptap content + extracted plain text; visibility `PRIVATE`/`SHARED`/`TEAM`; `setShares` grants per-user `VIEW`/`EDIT`; backlinks via `NoteLink`; ≤**50** revisions retained (pruned each save), restorable. **Mentions notify but never grant visibility** — mention targets are filtered to users who can already see the note, so a `PRIVATE` note cannot leak; only newly added mentions notify on edit.

### Chat

Channel types `DM` (via `createOrGetDM`), `GROUP`, `PROJECT`; member roles `OWNER`/`ADMIN`/`MEMBER`. Messages support threads, edits with full history, soft delete, reactions, pins, saved/bookmarks, mentions, mute, unread tracking, and search. Voice notes are audio attachments (with duration). Realtime via Ably. **DMs stay private even from admins** — reads are pure membership checks and admin moderation powers are explicitly withheld for `type = DM`. (Attachment _sending_ is currently broken by the URL-contract mismatch, R-004.)

### Email (disabled)

**Verified:** `/email` hard-redirects to `/dashboard` ("intentionally paused until OAuth and the mailbox schema are deployed") and the sidebar entry is commented out. The full UI and `email` router (providers, connect, list/send, sync) exist but stay disabled until OAuth hardening and Vercel variables land (R-005). Provider connect buttons disable themselves when their OAuth env is absent.

### Search, Trello import

Global search (`search.global`, powers Cmd+K) spans five permission-scoped domains: projects (members only unless admin), tasks (own-project scope), clients, notes (visibility-filtered), team. Trello import (`trello-import.importBoard`) ingests a Trello JSON export into a board/project: labels, lists→columns, cards→tasks (due dates, done-routing), checklists, comments, and member mapping restricted to real project members; duplicate re-imports are detected.

### AI / API / webhook workflows

The AI assistant, REST API, and webhooks operate over these same records and rules. Their contracts, scopes, approval model, and limits are documented in the [API and automation reference](../engineering/API-AUTOMATION-REFERENCE.md). The load-bearing guarantee: **every write, on every surface, re-checks the same ABAC and object-level authorization** — the UI, the assistant approval card, and a token scope are conveniences, not the boundary.

## Centralized business-rules catalogue

The authoritative, deduplicated list. Each rule is **Verified** with its enforcement site.

### Access & identity

1. Only `ACTIVE` and `ON_LEAVE` users may use the app — `assertActive` / `ACTIVE_STATUSES` (`src/lib/abac`, `src/server/trpc.ts`, `src/lib/api-auth.ts`).
2. Sessions are revoked by bumping `tokenVersion` (password change, admin reset, layoff, sign-out-everywhere) — `src/lib/auth.ts`.

### People / HR

3. One pending resignation per user — `resignations.submit`.
4. Leave dates must be valid and future and cannot overlap the requester's pending/approved leave — `team.createLeaveRequest` / `updateLeaveRequest`.
5. Users cannot approve or reject their own leave — `team.updateLeaveStatus`.
6. Users cannot review their own resignation — ABAC `resignation:review`.
7. HR cannot terminate or review an admin — ABAC `team:layoff`, `resignation:review`.
8. The last active administrator cannot be demoted, deactivated, or laid off — `team.adminUpdateMember`, `team.layOffMember`.

### Delivery

9. The last project lead cannot be removed or demoted — `projects.removeMember` / `setMemberRole`.
10. Task assignees and column default-owners must be project members — `projects.createTask` / `updateTaskAssignees` / `setColumnDefaultAssignees`.
11. A subtask must stay on the same board as its parent — `projects.setTaskParent`.
12. The task blocker graph cannot contain a cycle — `projects.addBlocker`.

### Finance

13. Invoice totals are recalculated server-side; client-supplied amounts are ignored — `finance.createInvoice` / `updateInvoice`.
14. Draft invoices cannot receive payments — `finance.addPayment`.
15. Overpayment is rejected (half-cent tolerance) — `finance.addPayment`.
16. Payments inherit the invoice's currency — `finance.addPayment`.
17. Invoice status transitions follow the fixed machine above — `finance.updateInvoiceStatus`.
18. Contract end date cannot precede start date (when both are given) — `clients.addContract` / `updateContract`.

### Collaboration

19. Note mentions do not grant visibility — `notes.computeMentionTargets`.
20. Private DMs have no admin read bypass — `assertChannelMember`, `chat.canManageChannel`.
21. Meeting attendance is occurrence-scoped — `meetings.markJoined` / `logJoin`.

### Automation

22. API write scopes imply the matching read scope — `hasScope` (`src/lib/api-auth.ts`).
23. Finance API access requires an admin-bound token identity — central gate in `withApiAuth`.

### Known inconsistencies (Verified — carried as risks, not enforced rules)

- **Completion metrics disagree** (finding 20): dashboard/team-stats count only a column named exactly `Done`; project logic counts `done|complete|completed|shipped|closed`. A task in "Shipped" counts as done in one place, not the other.
- **Currency mixing** (finding 17): `clients.getAll` sums paid-invoice totals across USD and PKR without grouping; project `budget` has no currency; `FX_TO_USD` uses a static `PKR 280/USD` for display only.
- **Team PII inconsistency** (finding 18): `team.getById` returns email/phone/bio/skills/startDate to any logged-in user, while the directory redacts contact fields for non-HR/admin viewers.
- **Manual operations** (finding 19): `finance.markOverdueInvoices`, `finance.postDueRecurringExpenses`, `clients.sweepExpiredContracts`, and future-dated resignation offboarding have no scheduler.

## Related documents

- [Product and business brief](PRODUCT-BUSINESS-BRIEF.md) · [Metrics and roadmap](METRICS-ROADMAP.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · [API and automation reference](../engineering/API-AUTOMATION-REFERENCE.md) · [Risk register](../executive/RISK-REGISTER.md)
