# Metrics and roadmap

**Snapshot:** 2026-07-12

## Metrics the system can produce today

These are computed from live data by existing code. Each carries a **definition caveat** you must read before trusting the number.

### Delivery

| Metric                      | Source                    | Definition caveat                                                                                                                                                                                 |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active projects             | `dashboard`, `projects`   | Status `ACTIVE`; `IN_DEVELOPMENT` is a separate status and may or may not be intended as "active"                                                                                                 |
| Tasks completed (this week) | `dashboard`, `team-stats` | **Counts only a column named exactly `Done`** — a task in "Shipped"/"Completed"/"Closed" is not counted here, though project activity logic counts those (finding 20). Two reports will disagree. |
| Upcoming deadlines          | `dashboard`               | Milestone due dates; does not weight by task load                                                                                                                                                 |
| Project completion rate     | `team-stats`              | Same `Done`-only caveat as above                                                                                                                                                                  |

### Finance

| Metric                          | Source                               | Definition caveat                                                                                                                                |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Revenue this month              | `dashboard` (admin), `finance`       | Grouped by currency in finance/dashboard paths (correct)                                                                                         |
| Outstanding invoices / net cash | `dashboard` (admin)                  | Sum of unpaid; currency handling per path                                                                                                        |
| P&L, expense by category        | `finance`, `/api/v1/finance/summary` | Grouped by currency; no base-currency consolidation                                                                                              |
| Client revenue                  | `clients.getAll`                     | **Sums paid-invoice totals across USD and PKR with no grouping** (finding 17) — a client billed in both currencies shows a meaningless mixed sum |
| Budget vs actual                | `finance.getBudgetVsActuals`         | Project `budget` is a single `Decimal` **with no currency**; actuals may span currencies; the code comment acknowledges the ambiguity            |
| Convenience "≈ $X" conversions  | `src/lib/finance/currency.ts`        | Uses a **static `PKR 280/USD`** constant, display-only, explicitly "swap for a live FX feed in production"                                       |

### People

| Metric             | Source                          | Caveat                                                                  |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Pending leaves     | `dashboard` (non-admin), `team` | Own vs company scope differs by role                                    |
| Leave balance used | `team`                          | **Derived** from approved requests, not a stored counter                |
| Headcount / status | `team`, `team-stats`            | Reflects `UserStatus`; `INVITED` accounts exist but aren't active staff |
| Review completion  | `reviews`                       | Only `SUBMITTED` reviews count; drafts excluded                         |

### Collaboration, audit, API, webhooks

| Metric                   | Source                         | Caveat                                                                                                                              |
| ------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Meeting attendance rate  | `meetings.getAttendanceReport` | Per occurrence; auto-join only counts within the join window                                                                        |
| Activity feed volume     | `dashboard`, `notifications`   | Product history, **not** a compliance ledger                                                                                        |
| Audit coverage           | `audit` router                 | tRPC mutations, privileged reads, REST, auth events — but many writes are fire-and-forget and may be lost at serverless termination |
| API token usage          | `apiTokens.usage`              | Derived from audit rows by `tokenId`                                                                                                |
| Webhook delivery success | `WebhookDelivery` rows         | **Single attempt** — a failure is final and not retried (R-023)                                                                     |

**Cross-cutting caveat:** there is no metrics pipeline, RUM, or query telemetry (R-008). Every number above is computed on read from PostgreSQL; there is no historical time-series, no SLO measurement, and no alerting on any of them.

## Recommended product-adoption metrics (Proposed)

The Hub measures _business_ outputs but not its own _adoption_ — whether the team actually relies on it. Add:

| Metric                                         | Why                                      | Source once instrumented                                 |
| ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Weekly active users by role                    | Is the whole team using it, or a subset? | Session/auth events                                      |
| Module reach (users touching each module/week) | Which modules earn their maintenance     | Activity/audit by domain                                 |
| Assistant usage & write-approval rate          | Adoption and trust of the AI operator    | `assistant.*` audit actions                              |
| Time-to-first-value for new invitees           | Onboarding friction                      | Invite→accept→first action timing                        |
| Task cycle time (created→done)                 | Delivery health, not just counts         | Task timestamps (after the `Done` definition is unified) |
| Data freshness (stale projects/invoices)       | Is the record actually kept current?     | `updatedAt` distributions                                |

None exist today; they depend on the observability work in R-008/D-015.

## 30 / 60 / 90-day roadmap

Aligned with the [executive brief](../executive/EXECUTIVE-BRIEF.md) and the [risk register](../executive/RISK-REGISTER.md); framed here around outcomes and metrics.

### Days 0–30 — make it safe to rely on

- Durable object storage for uploads (D-012, R-001); fix the chat/voice attachment contract (R-004).
- Prisma migration baseline + confirmed database backup ownership (D-013, R-002, R-003).
- Close OAuth state validation and webhook SSRF (R-005, R-006).
- Stand up CI (typecheck, lint, build, audit) and clear the 14 lint errors (D-014, R-007, R-009).
- Remove the stale lockfile; resolve the critical `shell-quote` advisory (R-012, R-013).
- **Exit metric:** a green CI gate exists and blocks a bad merge; a restart no longer loses files.

### Days 31–60 — make it observable and recoverable

- Error tracking, structured logs, health endpoint, metrics, alerts (D-015, R-008).
- Measured restore drill with real RPO/RTO ([business continuity](../operations/BUSINESS-CONTINUITY.md), R-003).
- Distributed rate limiting and assistant body/size/cost controls (D-017, R-010, R-011).
- Scheduled jobs for overdue invoices, recurring expenses, contract expiry, and resignation offboarding (D-016, R-015).
- Production/Preview environment parity (R-014).
- **Exit metric:** a synthetic failure pages someone; a documented restore has been performed.

### Days 61–90 — make it governable and measurable

- Critical-path test suite expanded (auth, authorization, finance, leave, notes, chat, assistant, REST, webhooks).
- Signed finance policy: base currency, FX source, budget semantics, unified "done" definition (OD-002, findings 17 & 20).
- Data classification and retention program (OD-003, R-017); resolve team-PII visibility (finding 18, R-024-adjacent).
- Product-adoption metrics instrumented (above).
- ASVS-aligned review and an incident tabletop.
- **Exit metric:** management reports reconcile; adoption is visible; a metric dictionary is signed.

## Strategic fork: internal tool vs commercial SaaS

**Open Decision OD-001.** The single most consequential product decision, because it changes what "done" means for the architecture.

|                  | Stay internal                                                                   | Go commercial (SaaS)                                                                                             |
| ---------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Architecture     | Single-tenant is a **feature** — keep D-002                                     | Single-tenant becomes **debt** — a tenant boundary in every record, policy, channel, token, and query            |
| Priorities       | The 30/60/90 plan above is sufficient                                           | Add tenant isolation, per-tenant billing, self-serve onboarding, external client login, and a compliance program |
| Data & privacy   | Internal policy suffices                                                        | DPAs, subprocessors, residency, breach notification, retention become mandatory                                  |
| Security posture | Current trust-heavy controls (optional MFA, per-instance limits) are defensible | Must harden to external-product standards before any customer                                                    |
| Timeline impact  | Weeks                                                                           | Quarters, and a re-architecture                                                                                  |

Everything else in this roadmap is compatible with either fork; this decision only sets the ceiling. It should be made **before** any external-customer commitment, not discovered afterward.

## Explicit open decisions

| ID     | Decision                                                    | Owner (TBD)               |
| ------ | ----------------------------------------------------------- | ------------------------- |
| OD-001 | Internal tool vs commercial SaaS                            | Leadership                |
| OD-002 | Finance base currency, FX source, budget & "done" semantics | Finance + Product         |
| OD-003 | Data retention and privacy program                          | Legal + People + Security |
| OD-004 | Mandatory MFA for privileged roles                          | Security                  |

## Related documents

- [Executive brief](../executive/EXECUTIVE-BRIEF.md) · [Product and business brief](PRODUCT-BUSINESS-BRIEF.md) · [Product strategy and pilot](../product/PRODUCT-STRATEGY.md) · [Roles and workflows](ROLES-WORKFLOWS.md) · [Risk register](../executive/RISK-REGISTER.md) · [Decision register](../governance/DECISION-REGISTER.md)
