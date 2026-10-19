# Glossary and source map

**Snapshot:** 2026-07-12

This document defines the terms used across the atlas and — more importantly — names the **canonical source file** for each domain, so that when documentation and code disagree, everyone knows which file wins.

## Source-of-truth precedence

When two sources conflict, trust them in this order:

1. **Source code, Prisma schema, and configuration** (`prisma/schema.prisma`, `src/**`, `next.config.ts`, `vercel.json`).
2. **Live platform evidence** (Vercel environment inventory, deployment status, CLI output).
3. **This atlas** (`docs/`), which interprets 1 and 2 with labels.
4. **Historical root-level Markdown** (`BUGS.md`, `SECURITY.md`, etc.) — evidence of past state, never current truth.

If code and a root-level doc disagree, code wins and the doc is stale by definition.

## Business glossary

| Term                              | Meaning                                                                                                          | Canonical source                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Role                              | `ADMIN`, `EMPLOYEE`, `HR` — coarse capability tier                                                               | `prisma/schema.prisma` (enum `Role`)                   |
| User status                       | `ACTIVE`, `ON_LEAVE` (may use app), `INACTIVE`, `INVITED` (may not)                                              | enum `UserStatus`; `ACTIVE_STATUSES` in `src/lib/abac` |
| Department                        | `LEADERSHIP`, `ENGINEERING`, `PRODUCT`, `QUALITY`, `MARKETING`, `DESIGN`                                         | enum `Department`                                      |
| Project                           | Delivery container; `CLIENT` or `INTERNAL`; status `ACTIVE`/`COMPLETED`/`ON_HOLD`/`CANCELLED`/`IN_DEVELOPMENT`   | `src/server/routers/projects.ts`                       |
| Board / Column / Task             | Kanban structure under a project; task priority `LOW`/`MEDIUM`/`HIGH`/`URGENT`                                   | `projects.ts`                                          |
| Project member role               | `LEAD` or `MEMBER` (distinct from app Role)                                                                      | `projects.ts`                                          |
| Milestone                         | Named target date on a project                                                                                   | `projects.ts`                                          |
| Time entry                        | Manually logged decimal hours on a task (no timer)                                                               | `projects.ts`                                          |
| Client / Contact / Contract       | CRM records; contract status `DRAFT`/`SENT`/`SIGNED`/`EXPIRED`/`TERMINATED`                                      | `src/server/routers/clients.ts`                        |
| Invoice                           | Billing document; status machine `DRAFT`/`SENT`/`PAID`/`OVERDUE`/`CANCELLED`                                     | `src/server/routers/finance.ts`                        |
| Payment                           | Amount against an invoice; inherits invoice currency; partial allowed                                            | `finance.ts`                                           |
| Transaction                       | Income/expense ledger entry; expense categories `SALARIES`…`MISCELLANEOUS`                                       | `finance.ts`                                           |
| Recurring expense                 | Scheduled expense template; posting is operator-triggered                                                        | `finance.ts`                                           |
| Leave                             | Request (`VACATION`/`SICK`/`REMOTE`) with status `PENDING`/`APPROVED`/`REJECTED`; balance derived from approvals | `src/server/routers/team.ts`                           |
| Resignation                       | Separation request; `PENDING`/`APPROVED`/`DECLINED`/`WITHDRAWN`; one pending per user                            | `src/server/routers/resignations.ts`                   |
| Review cycle / Review             | Performance cycle (`OPEN`/`CLOSED`) with assigned reviews (`DRAFT`/`SUBMITTED`, rating 1–5)                      | `src/server/routers/reviews.ts`                        |
| Layoff                            | Admin/HR deactivation of a member; guarded (last-admin, self, admin-target)                                      | `team.layOffMember`                                    |
| Channel                           | Chat container: `DM`, `GROUP`, `PROJECT`; member roles `OWNER`/`ADMIN`/`MEMBER`                                  | `src/server/routers/chat.ts`                           |
| Note                              | Rich document; visibility `PRIVATE`/`SHARED`/`TEAM`; share permission `VIEW`/`EDIT`; ≤50 revisions               | `src/server/routers/notes.ts`                          |
| Meeting                           | Scheduled event; recurrence daily/weekly/biweekly/monthly/null; attendance per occurrence                        | `src/server/routers/meetings.ts`                       |
| Mailbox                           | Connected inbox (`GMAIL`/`OUTLOOK`); feature disabled                                                            | `src/server/routers/email.ts`                          |
| Activity vs Notification vs Audit | Human feed / delivery state / security evidence — three different histories                                      | `src/lib/notifications.ts`, `src/server/audit.ts`      |

## Technical glossary

| Term                       | Meaning                                                                               | Canonical source                            |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| ABAC capability            | Coarse default-deny policy answering "may this class of user do this class of action" | `src/lib/abac/policies.ts`                  |
| Object-level authorization | Relationship check answering "may this user touch this record"                        | `src/lib/authz.ts`, `src/server/authz.ts`   |
| Procedure variant          | `public`/`protected`/`admin`/`hr`/`capability` tRPC wrappers                          | `src/server/trpc.ts`                        |
| `tokenVersion`             | Session-revocation counter in the JWT; bump invalidates a user's sessions             | `src/lib/auth.ts`                           |
| API token (`df_…`)         | Bcrypt-hashed, user-bound, scope-gated REST credential                                | `src/lib/api-auth.ts`                       |
| Scope                      | REST permission string; write implies read; finance implies admin                     | `AVAILABLE_SCOPES` in `src/lib/api-auth.ts` |
| Assistant tool             | AI-callable function; writes need approval + in-execute re-authorization              | `src/lib/ai/tools/*`                        |
| `needsApproval`            | AI SDK flag pausing a tool for user confirmation (advisory, not security)             | `src/lib/ai/tools/*`                        |
| `emitEvent` / webhook      | Outbound signed POST on `task.created` / `invoice.paid`                               | `src/lib/webhooks.ts`                       |
| Capability token (Ably)    | 30-min channel-scoped realtime token; `clientId` = user id                            | `src/app/api/ably-token/route.ts`           |
| Occurrence                 | A single dated instance of a recurring meeting; attendance key                        | `src/lib/meeting-occurrence`                |
| `withApiAuth`              | REST wrapper: rate limit + scope + finance-admin gate + audit + 500 handling          | `src/lib/api-auth.ts`                       |
| `proxy.ts`                 | Cookie-presence redirect gate — **not** a security boundary                           | `src/proxy.ts`                              |

## Canonical source files by domain

| Domain             | Schema / server                                                                                                                    | UI                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Identity & auth    | `src/lib/auth.ts`, `src/server/routers/invitations.ts`, `password-reset.ts`, `two-factor.ts`                                       | `login/`, `invite/[token]/`, `reset-password/`            |
| Authorization      | `src/lib/abac/`, `src/lib/authz.ts`, `src/server/authz.ts`, `src/server/trpc.ts`                                                   | —                                                         |
| Projects & tasks   | `src/server/routers/projects.ts`, `trello-import.ts`                                                                               | `(app)/projects/**`                                       |
| Clients            | `src/server/routers/clients.ts`                                                                                                    | `(app)/clients/**`                                        |
| Finance            | `src/server/routers/finance.ts`, `src/lib/finance/currency.ts`                                                                     | `(app)/finance/**`                                        |
| People / HR        | `src/server/routers/team.ts`, `team-stats.ts`, `resignations.ts`, `reviews.ts`                                                     | `(app)/team/**`, `(app)/hr/`, `(app)/reviews/`            |
| Chat               | `src/server/routers/chat.ts`, `chat-helpers.ts`, `src/lib/realtime-emit.ts`                                                        | `(app)/chat/`, `components/chat/**`                       |
| Notes              | `src/server/routers/notes.ts`                                                                                                      | `(app)/notes/**`                                          |
| Meetings           | `src/server/routers/meetings.ts`                                                                                                   | `(app)/meetings/**`, `components/meetings/**`             |
| Email              | `src/server/routers/email.ts`, `src/lib/email/**`                                                                                  | `(app)/email/` (paused)                                   |
| Dashboard & search | `src/server/routers/dashboard.ts`, `search.ts`                                                                                     | `(app)/dashboard/**`                                      |
| Audit & automation | `src/server/audit.ts`, `src/server/routers/audit.ts`, `api-tokens.ts`, `webhooks.ts`, `src/lib/api-auth.ts`, `src/lib/webhooks.ts` | `(app)/audit-logs/`, `(app)/settings/`, `(app)/api-docs/` |
| AI operator        | `src/app/api/assistant/route.ts`, `src/lib/ai/**`                                                                                  | `components/assistant/**`                                 |
| Persistence        | `prisma/schema.prisma`, `src/lib/db.ts`                                                                                            | —                                                         |
| Platform config    | `next.config.ts`, `vercel.json`, `prisma.config.ts`                                                                                | —                                                         |

## Stale / historical root documents

These remain in the repository as evidence of past state. **Do not treat any as current.** They are labelled historical in this map.

| File                      | What it is                                                      | Status                                                                                                                     |
| ------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `README.md`               | Project readme                                                  | **Corrected by this atlas** — previously described Socket.IO realtime and a nonexistent socket-server startup              |
| `PRODUCT-OVERVIEW.md`     | Internal product overview                                       | Useful business context; superseded by [product & business brief](../business/PRODUCT-BUSINESS-BRIEF.md) where they differ |
| `BRAND.md`                | Brand guidelines                                                | Current reference (visual identity, not system behavior)                                                                   |
| `BUGS.md`                 | QA defect report, 53 findings (2026-06-23)                      | **Historical snapshot**                                                                                                    |
| `FIXES.md`                | Remediation log for those findings                              | **Historical**                                                                                                             |
| `TICKETS.md`              | Findings reconciled into trackers                               | **Historical**                                                                                                             |
| `IMPROVEMENTS.md`         | BA improvement roadmap (IMP-\* ids)                             | Working roadmap; many items since implemented — verify each against code                                                   |
| `ENHANCEMENTS.md`         | The roadmap filed into trackers                                 | **Historical / process**                                                                                                   |
| `DEPLOY-NOTES.md`         | Two deploy-gated items (PLAT-02 uploads, PLAT-03 observability) | Still-open TODO; consistent with current code                                                                              |
| `SECURITY.md`             | Security hardening report (engagement 2026-06-18)               | **Historical report** — not a current external assurance                                                                   |
| `RESUME.md`               | Session handoff note for the QA branch                          | **Stale working note**                                                                                                     |
| `AGENTS.md` / `CLAUDE.md` | Agent/build instructions                                        | **Current** — read before writing code                                                                                     |

`IMP-*`, `FIN-*`, `PROJ-*`, `RT-*`, `SEC-*`, `HR-*`, `CON-*`, `PLAT-*` codes appearing in code comments trace back to these historical planning docs; they are useful for archaeology but the code is the authority on what actually shipped.

## Documentation maintenance rules

1. Update the matching atlas document in the **same PR** as any change to a business rule, integration, environment variable, API contract, or operational dependency.
2. Keep the precedence order above intact — never let a doc claim authority over code.
3. When a historical root doc becomes actively misleading, correct the fact in the atlas and note the correction here; do not silently rewrite the historical file.
4. Re-verify counts (models, procedures, tools, routes) and the quality baseline before external diligence; record the date.
5. Label every non-obvious statement Verified / Inferred / Proposed / Open Decision.

## Verified counts (2026-07-12)

For reconciliation across the atlas: **60** Prisma models · **23** enums · **20** composed tRPC domains (22 router files; `_app.ts` and `chat-helpers.ts` carry no procedures) · **229** tRPC procedures · **16** REST route files under `/api/v1` · **96** assistant tools across **10** factories (**60** definitions with `needsApproval: true`) · **2** webhook events.

Counting method: exact Prisma `model`/`enum` declarations; `_app.ts` composition; router `.query(`/`.mutation(` terminals; `/api/v1/**/route.ts` files; `tool({` and anchored `needsApproval: true` properties under `src/lib/ai/tools`. Comments are excluded from the approval count.

## Related documents

- [Engineering handbook](../engineering/ENGINEERING-HANDBOOK.md) · [Data architecture](../architecture/DATA-ARCHITECTURE.md) · [Roles and workflows](../business/ROLES-WORKFLOWS.md) · [README](../README.md)
