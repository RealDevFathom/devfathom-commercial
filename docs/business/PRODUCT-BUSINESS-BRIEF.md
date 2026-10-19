# Product and business brief

**Internal · Confidential · 2026-07-12**

## Purpose

**Verified:** DevFathom Hub is the **internal operating system** for DevFathom, a software services and consultancy firm. It consolidates the operational surfaces a services business runs on — client relationships, project delivery, finance, people operations, meetings, communication, and knowledge — into one permission-aware application, plus an AI operator and a scripting API over the same records.

The value proposition is **consolidation of the operating context**: a user moves from a client, to a contract, to a project, to a board and tasks, to time and invoices, to a meeting or a note, without re-keying who the client is or what the work is across disconnected tools. The differentiator is not any single module; it is that they share one data graph and one authorization model.

## Product boundary

**Verified — this is a single-company internal tool, not a multi-tenant SaaS.** There is no organization/tenant key anywhere in the 60-model schema (decision D-002). Every user belongs to the one DevFathom instance; authorization is by role and by record relationship, never by tenant.

**Implication (Open Decision OD-001):** offering the Hub to external customers would not be a configuration change — it would require introducing a tenant boundary into every record, policy, channel, token, and query, plus a compliance and data-isolation program. That strategic fork is unresolved and is carried in [metrics and roadmap](METRICS-ROADMAP.md).

What the Hub is **not** today: not a customer-facing portal (clients cannot log in — even the invoice email CTA points at an authenticated internal route, finding 16 / R-024-adjacent), not a public product, and not an assured system of record for compliance purposes (no backups drill, no observability, no external security assurance — see [technical due diligence](../executive/TECHNICAL-DUE-DILIGENCE.md)).

## Stakeholders and value streams

| Stakeholder           | What they get from the Hub                                 | Primary modules                         |
| --------------------- | ---------------------------------------------------------- | --------------------------------------- |
| Leadership / Admin    | Company-wide visibility, finance, headcount control, audit | Dashboard, Finance, Insights, Audit, HR |
| HR                    | People lifecycle, leave, resignations, reviews             | HR console, Team, Reviews, Resignations |
| Project leads         | Delivery planning and tracking                             | Projects, Boards, Milestones, Time      |
| Employees             | Their work, their team, communication, knowledge           | Dashboard, Tasks, Chat, Notes, Meetings |
| Finance (admin-bound) | Invoicing, payments, P&L, budgets                          | Finance                                 |
| Clients (indirect)    | Are _represented_ in the system; do not log in             | Clients, Contracts, Invoices            |
| Automation / agents   | Programmatic reads/writes over the same records            | REST API, AI assistant, webhooks        |

**Core value stream (Verified linkage):** Client → Contact → Contract → Project → Board/Tasks/Time → Invoice → Payment, with People, Meetings, Chat, and Notes as the collaboration substrate and Audit/Automation as the governance and extension layer.

## Capability catalogue

| Capability              | What it does                                                                                                                                                                 | Maturity (Verified)                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Dashboard               | Role-aware KPI home: revenue (admin), active projects, tasks, invoices/leave, activity, deadlines, next meeting                                                              | Established                                        |
| Projects & Kanban       | Boards, columns (WIP limits, default assignees), tasks, subtasks, blockers (cycle-safe), checklists, threaded comments, attachments, labels, milestones, manual time logging | Established                                        |
| Trello import           | Boards, lists→columns, cards→tasks, labels, checklists, comments, member mapping                                                                                             | Established                                        |
| Clients / CRM           | Clients, contacts (primary flag), contracts (date-guarded), documents                                                                                                        | Established                                        |
| Finance                 | Invoices (server-recalculated totals, state machine), partial payments, transactions, recurring expenses, P&L, budget-vs-actual                                              | Established, with correctness caveats (finding 17) |
| People / HR             | Directory, profiles, leave (balances, approval), reviews, resignations, layoffs — all with guard rules                                                                       | Established                                        |
| Chat                    | DM/group/project channels, threads, edits+history, reactions, pins, saved, mentions, voice notes, realtime                                                                   | Established; attachment send broken (R-004)        |
| Notes                   | Rich Tiptap notes, visibility levels, sharing, backlinks, mentions, ≤50 revisions                                                                                            | Established                                        |
| Meetings                | Scheduling, recurrence, embedded JaaS video, per-occurrence attendance, attendance reports                                                                                   | Established                                        |
| AI operator             | 96-tool Gemini assistant operating the Hub with approval-gated, re-authorized writes                                                                                         | Established capability; ungoverned (R-010)         |
| REST API + docs         | Scoped token API for scripts/agents; self-describing Markdown spec                                                                                                           | Established                                        |
| Webhooks                | Signed outbound events on `task.created` / `invoice.paid`                                                                                                                    | Basic; single-attempt, SSRF-open (R-006, R-023)    |
| Audit                   | Append-only actor/action/outcome evidence across tRPC, REST, and auth                                                                                                        | Established; durability caveat                     |
| Email (connected inbox) | Gmail/Outlook adapters, sync, send                                                                                                                                           | **Disabled** pending OAuth hardening (R-005)       |
| Transactional email     | Brevo-sent invites, resets, invoices, HR notices                                                                                                                             | Established                                        |

## Operating model

- **One deployment, one database, one team.** A modular monolith on Vercel (region `sin1`) fits the single-company scope (D-001, D-011).
- **Three ways to act on the same records:** the browser UI (tRPC), the AI assistant, and the REST API — all pass through the same layered authorization and audit (D-003, D-006).
- **Manual operational cadence today:** several recurring operations that a services business would expect to be automatic are operator-triggered — overdue-invoice marking, recurring-expense posting, contract expiry, and future-dated resignation offboarding (finding 19 / R-015). This is a running cost and a correctness risk until scheduled (D-016).

## Business assumptions (Inferred unless noted)

1. All users are DevFathom staff on one instance (Verified: no tenant model).
2. Two settlement currencies matter: USD and PKR (Verified: `Currency` enum).
3. The company is small enough that a single admin tier plus HR is sufficient governance (Verified: 3-role model).
4. Clients are managed _about_, not _by_ — no external login is expected (Verified: no client auth path).
5. Trust is high internally, so some controls (optional MFA, fail-open session refresh, per-instance rate limits) are lighter than an external product would require (Verified behaviors; Inferred rationale).

## Unresolved business decisions

| Decision                                                    | Why it matters                                                                                                                   | Reference                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Internal tool vs commercial SaaS                            | Determines whether the single-tenant architecture is a feature or a debt                                                         | OD-001 · [metrics and roadmap](METRICS-ROADMAP.md)     |
| Finance policy (base currency, FX source, budget semantics) | Client revenue can mix USD and PKR; budgets have no currency; FX is a static display constant                                    | OD-002 · finding 17                                    |
| Data retention and privacy program                          | HR, performance, finance, chat, and audit PII persist without a lifecycle                                                        | OD-003 · R-017                                         |
| "Done" and completion metric definitions                    | Team-stats/dashboard count only a column literally named "Done"; project logic counts several done-like names — reports disagree | finding 20 · [metrics and roadmap](METRICS-ROADMAP.md) |
| Team PII visibility policy                                  | The directory redacts contact fields that the member-detail endpoint hands to every logged-in user                               | finding 18 · R-017                                     |

## Related documents

- [Executive brief](../executive/EXECUTIVE-BRIEF.md) · [Product strategy and pilot](../product/PRODUCT-STRATEGY.md) · [Roles and workflows](ROLES-WORKFLOWS.md) · [Metrics and roadmap](METRICS-ROADMAP.md) · [System architecture](../architecture/SYSTEM-ARCHITECTURE.md)
