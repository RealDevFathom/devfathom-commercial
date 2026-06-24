# DevFathom-Hub — Improvement Roadmap (Business Analyst)

A product-strategy companion to `BUGS.md`. Bugs are "works but wrong"; this is **"works but incomplete / could be much better."** Each item is tagged **Quick Win** (hours–1 day), **Medium** (days), or **Big Bet** (weeks / cross-cutting), with the user/business value and a short rationale. Within each module, *Missing or incomplete features* are separated from *Enhancements to existing features*.

DevFathom-Hub is already an unusually complete internal ops platform (projects+kanban, CRM, finance, HR, notes, realtime chat, video, an LLM operator, a public API). The biggest leverage now is **closing half-built loops** (modeled-but-unwired features), **lifecycle/automation** (reminders, balances, off-boarding), and **self-service trust features** (password reset, 2FA, notification prefs).

## Top recommendations (do these first)

1. **Close the modeled-but-unwired loops** — Time tracking, task checklists/attachments management, contact CRUD, client status/logo. The schema already pays for these; users hit visible dead-ends. *(Medium, high perceived-completeness ROI.)*
2. **Financial correctness as a feature** — per-currency reporting + server-derived invoice totals + an invoice edit/PDF path turn finance from "looks right" into "trustworthy." *(Medium; pairs with FIN-01/02.)*
3. **HR people-ops depth** — leave balances + team calendar + off-boarding automation is the difference between "a leave table" and "an HR product." *(Big Bet.)*
4. **Account trust & recovery** — self-service password reset, 2FA, and session management. A system holding finance + HR data should not lack these. *(Big Bet, but reset alone is Medium.)*
5. **A relevance-scoped activity feed & notifications** — fixes DASH-01 and makes the dashboard useful to non-admins. *(Medium.)*

---

## Projects & Kanban

### Missing or incomplete features
- **Time tracking — Big Bet.** `TimeEntry` is fully modeled (`Decimal(5,2)`, task/project links) but has **zero** routers or UI. *Value:* billing, utilization, project profitability. *Rationale:* the schema investment is completely stranded, and finance already has the client/project links to bill against.
- **Checklist management — Medium.** Only `toggleChecklistItem` exists — no create/rename/reorder/delete of checklists or items; they appear only if imported from Trello. *Value:* core kanban capability. *Rationale:* the detail sheet renders checklists read-only, a visible dead-end.
- **Task attachments — Medium.** No render and no add/delete (see PROJ-04). *Value:* specs/designs live on cards. *Rationale:* data is modeled and counted but unusable.
- **Comment edit/delete — Quick Win.** No `updateComment`/`deleteComment`; comments are permanent. *Value:* fix typos / remove mistakes. *Rationale:* table-stakes, low effort.
- **Board rename/description + label edit/delete + project-file delete — Quick Win.** `create`/`delete` exist but no `updateBoard`, no label remove/recolor, no file delete. *Value:* avoid permanently-mislabeled boards and accumulating labels/files.
- **Subtasks / dependencies / blockers — Medium.** No parent-child or blocking relations. *Value:* real delivery planning beyond a flat board.

### Enhancements to existing features
- **Board/column templates + WIP limits — Medium.** Default columns are hardcoded. *Value:* faster setup, flow control. *Rationale:* teams recreate the same structure each project.
- **Bulk task actions — Medium.** Multi-select move/label/assign/delete. *Value:* manage big boards without one-at-a-time clicks.
- **Pagination / lazy-load on large boards — Medium.** `getBoardWithTasks` loads every task with all relations in one shot — large boards will be slow.
- **Task activity timeline in the detail sheet — Quick Win.** Surface the `task_created`/`task_completed` activity already logged.
- **Generalized "done" detection — Quick Win.** Drive completion logging from the same heuristic the UI uses (relates to PROJ-07).

## Clients / CRM & Contracts

### Missing or incomplete features
- **Full contact CRUD UI — Medium.** Add/edit/delete contacts, set primary, capture phone (create form omits phone, allows only one primary). Wire existing `addContact`/`deleteContact` and add `updateContact` (relates to CLI-02). *Value:* a usable CRM contact book.
- **Client activity timeline — Medium.** No per-client history of projects/invoices/contracts/notes events. *Value:* account context at a glance before a call.
- **Client status workflow + logo upload — Quick Win.** `status` (ACTIVE/INACTIVE/PROSPECT) has no selector in the edit UI, so PROSPECT→ACTIVE conversion isn't reachable; `Client.logo` is modeled and shown but never settable. *Value:* basic CRM lifecycle + polish.
- **Contract expiry/renewal reminders — Medium.** `endDate` + an `EXPIRED` status exist but nothing auto-flags or notifies on upcoming expiry. *Value:* prevent lapsed agreements. *Rationale:* high leverage — the `notify()` email infra already exists.
- **Contract ↔ project/invoice linkage + value rollup — Medium.** Contracts attach to a client only; can't tie to the governed project, generate an invoice from contract value, or show "total contracted value" per client. *Value:* connects the sales→delivery→billing chain.

### Enhancements to existing features
- **Friendly delete-guards & inline validation errors — Quick Win.** Fixes CLI-01 + UX-01 (surface mutation errors as the Projects forms already do).
- **Contract status state-machine + date/`signedAt` validation — Quick Win.** Any status → any status is allowed (e.g. TERMINATED→DRAFT); plus CON-01/CON-02. *Value:* trustworthy contract lifecycle.
- **Role-aware fetching & richer search — Quick Win.** `getById` loads invoices/contracts then discards them for non-admins; list search matches name only (add contact/industry).

## Trello Import

### Missing or incomplete features
- **Import into a brand-new project + lead-only gate — Medium.** Today any project *member* can import into a pre-existing project; the common flow is "import as a new project." *Value:* matches user expectation; tightens who can bulk-mutate a board.
- **Map more card data — Medium.** Cover images, custom fields, and due-complete state are dropped (only name/desc/due/labels/members/checklists/attachments/comments map).

### Enhancements to existing features
- **Robust dates + per-column order normalization — Quick Win/Medium.** Fixes TRELLO-01 and PROJ-02.
- **Partial-failure / skipped-card reporting — Quick Win.** The import is all-or-nothing behind a generic spinner; report what was skipped (unmapped lists, invalid dates) in the result.
- **Dedup when `trello.id` is absent — Quick Win.** Dedup is skipped entirely without an id, allowing duplicate imports.

## Finance

### Missing or incomplete features
- **Invoice edit + PDF/print + send-by-email — Big Bet→Medium.** There is no full invoice edit (only status) and no PDF/print or client-delivery path. *Value:* invoices that are actually sendable; also the natural home for the FIN-01 server-side total recompute.
- **Per-currency reporting & FX — Medium.** First-class multi-currency reporting (group by currency or convert) — turns FIN-02 from a bug-fix into a feature.
- **Recurring-expense posting + budgets vs actuals — Medium.** Auto-post due `RecurringExpense` rows as transactions (fixes FIN-05) and compare against `Project.budget`. *Value:* real burn/runway and project margin.
- **Payments / partial payments & overdue automation — Medium.** Model partial payments and auto-flip `OVERDUE` past `dueDate` (today it's display-only). *Value:* accurate AR.

### Enhancements to existing features
- **Decimal-safe math + bounded date windows — Quick Win.** FIN-04/FIN-08/FIN-09 hardening; report in integer cents internally.
- **Finance export (CSV) + date-range filters — Quick Win.** Standard for any finance view.

## Notes

### Missing or incomplete features
- **Version history / restore — Big Bet.** No revisioning; a TEAM/EDIT collaborator can overwrite or erase content irreversibly. *Value:* recover from mistakes/abuse, audit changes. *Rationale:* collaborative editing + NOTE-01 make loss easy.
- **People `@mentions` + notifications — Medium.** Notes have `[[note-links]]` only, no people-mentions or notifications — chat already has parity to copy. *Value:* collaboration loop.

### Enhancements to existing features
- **Author-only visibility control — Quick Win.** Implements NOTE-01 and clarifies the sharing model.
- **Resolve "shared-with-me" links instead of hiding them — Medium.** `getById` drops SHARED backlinks it "can't independently verify," so legitimate shared links vanish from the UI; resolve against the viewer's actual shares.
- **Allow-list link protocols in the editor — Quick Win.** Tiptap `Link` has `autolink:true` and no `protocols` allow-list; restrict to `http/https/mailto` as cheap defense-in-depth.

## Dashboard

### Missing or incomplete features
- **Relevance-scoped activity feed — Medium.** Fixes DASH-01 and makes the feed useful to employees (their projects/tasks/mentions). *Value:* the dashboard's most-viewed widget becomes trustworthy and relevant.
- **Customizable widgets + graceful empty states — Medium.** Let users choose/arrange cards (my tasks, deadlines, leave, meetings). *Value:* personal relevance.

### Enhancements to existing features
- **Personal "my time-off / pending leave" widget — Quick Win.** Replace the leaked company-wide `pendingLeaves` (DASH-02) with the user's own.

## Team / HR

### Missing or incomplete features
- **Leave balances + team calendar + overlap detection — Big Bet.** No accrual/balance model, no calendar, no overlap guard (HR-02). *Value:* real people-ops; prevents over-booking and gives employees visibility into remaining days. *Rationale:* the current leave table is a fraction of what an HR module needs.
- **Off-boarding automation — Medium.** Resignation approval records `lastWorkingDay` but never deactivates the account or revokes sessions. *Value:* security + process hygiene. *Rationale:* pairs with AUTH-01's token-version mechanism for force-logout.
- **Self-service leave edit/cancel — Quick Win.** Employees can create but not withdraw/edit a pending leave.
- **Performance review workflow — Medium.** `PerformanceNote` is admin-write/admin-or-self-read only; HR (people-ops) can't participate, and there's no review cycle, ratings, or configurable subject visibility. *Value:* turns a notes table into a review process.

### Enhancements to existing features
- **Separation-of-duties on approvals — Quick Win.** Implements HR-01 (block self-approval, PENDING-only).
- **Directory privacy controls — Quick Win.** `team.getAll` returns email/phone/bio to every authenticated user; consider restricting contact fields to HR/Admin or making them opt-in.
- **Include ON_LEAVE staff in people search — Quick Win.** Team search filters `status:'ACTIVE'`, dropping otherwise-active on-leave members.

## Settings / Profile / Auth

### Missing or incomplete features
- **Self-service password reset ("forgot password") — Big Bet→Medium.** Only logged-in change and admin reset exist; a locked-out user has no recovery. *Value:* table-stakes; reduces admin load. *Rationale:* the invite-token infra can be reused for reset links.
- **2FA / MFA — Big Bet.** No second factor on a system holding admin + finance + HR data. *Value:* materially raises account security.
- **Session management ("active sessions / sign out everywhere") + revoke-on-password-change — Medium.** Implements AUTH-01; gives users control after a compromise.
- **Notification preferences — Medium.** `notify()` always emails; no per-user channel/type opt-out. *Value:* reduces noise, respects preferences.

### Enhancements to existing features
- **Live password-policy checklist on the change form — Quick Win.** `password-policy.ts` exposes `passwordRules`, but the settings form only checks `length < 8` client-side — reuse the shared checklist so client and server agree (the invite flow already does this).
- **Edge token verification + consistent page-auth guard — Quick Win.** Implements AUTH-02/SEC-03 (verify the JWT in middleware; add a shared server-side auth guard so non-finance pages also redirect cleanly).

## Realtime Chat & Meetings/Video

### Missing or incomplete features
- **Attendance reporting & summaries — Medium.** Attendance is logged (per-occurrence, `joinedAt`/`leftAt`) but there's no report/% view per meeting or per person. *Value:* makes the attendance data actionable (and surfaces RT-01/RT-03 data-quality issues).
- **Message edit history / delete-for-everyone clarity + threads polish — Medium.** Standard chat affordances that deepen the Slack-grade goal.

### Enhancements to existing features
- **Realtime membership revocation + short token TTL — Medium.** Implements RT-02; also emit a leave/remove event so the UI updates live.
- **Notify on mention-added-by-edit + stable client ordering + scoped read receipts — Quick Win.** RT-04, RT-08, RT-09.
- **Authenticated/signed attachment delivery — Medium.** Implements RT-05 (private files behind an auth check or signed URLs) — required before relying on a public bucket in production.
- **Robust call exit handling — Quick Win.** `logLeave` on `pagehide`/route-change (RT-03); `upsert` attendance to kill the race (RT-06).

## Public REST API (`/api/v1`)

### Missing or incomplete features
- **Rate limiting + per-token usage metrics — Medium.** Implements REST-04; add per-token quotas and a usage view in the token UI. *Value:* abuse protection + operator visibility for an LLM-operable API.
- **Pagination cursors + consistent list envelopes — Quick Win.** Standardize `limit`/cursor handling and response shape across all list endpoints (also fixes REST-06).
- **Webhooks / events — Big Bet.** For an "agent-operable" API, outbound events (invoice.paid, task.created) unlock real integrations.

### Enhancements to existing features
- **Scope hygiene + audit completeness — Quick Win.** Fix REST-01 (finance data under `clients:read`), REST-02 (`/spec` unaudited), and align the published spec with actual response shapes (the doc claims `documents`/`monthly` keys the code doesn't return).
- **Consistent 400/404 on bad input — Quick Win.** REST-05/REST-07 (clean JSON-parse and FK validation) so integrators get actionable errors, not 500s.

## AI Assistant

### Missing or incomplete features
- **Authorization & isolation tests in the eval — Medium.** The eval proves routing but not the in-`execute` guards or cross-user isolation (AI-02). *Value:* protects the security model against regressions as tools grow.
- **Streaming citations / "why" + action audit surfacing — Medium.** Show which records an answer used and link assistant writes into the audit/activity views. *Value:* trust and traceability for an operator bot.

### Enhancements to existing features
- **Groq-schema discipline lint — Quick Win.** Fix AI-01 (`pattern`/`allOf` in `resetMemberPassword`) and add a guard/test that no tool schema emits `format`/`pattern`/`allOf` (validate in `execute`). *Value:* prevents whole-request 400s.
- **Parity fixes with the app — Quick Win.** Scope `pendingLeaves`/`getTeamMember` consistently with the underlying routers (AI-03/DASH-02) so the assistant and UI agree.

## Platform / Cross-cutting

- **Tighten CSP & image origins — Quick Win.** SEC-01 (drop `ws: wss:` + stale socket origin) and SEC-02 (restrict `img-src`). Move toward the nonce-based script policy the config comments already aspire to.
- **Production file storage — Medium.** The upload route is explicitly "DEV STORAGE ONLY (local FS)"; wire Vercel Blob (with access control, per RT-05) before production scale.
- **Observability — Medium.** With no rate limiting and several "generic 500" paths, add error tracking + request metrics so the 500s flagged here (REST-05/06/07, RT-06) are visible in production.
- **Audit log export + retention policy — Medium.** The viewer is read-only; add CSV/JSON export and a documented immutability/retention guarantee for compliance.
