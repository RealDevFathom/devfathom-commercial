# Product strategy

**Internal · Confidential · Working strategy: 2026-07-12**  
**Status:** Proposed until leadership accepts it.

## Strategic recommendation

Operate DevFathom Hub as an **internal-first delivery operating system**. Make it measurably indispensable inside DevFathom before funding commercial multi-tenancy, self-service, billing, compliance, or external support promises.

The application already has broad capability. The strategic problem is focus: breadth must now converge on one recurring behavior that creates visible operating value.

**Recommended product wedge:** a role-aware daily attention queue that answers:

1. What changed?
2. What is at risk?
3. Who owns the next action?
4. What evidence explains the recommendation?
5. What can this user safely do now?

## Product thesis

DevFathom Hub should be the place where company activity becomes the next clear decision. It is not another passive workspace or a collection of unrelated widgets. It connects delivery, clients, people, money, communication, knowledge, and automation through one permission-aware operating graph.

### Positioning

| Statement            | Recommended wording                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| Category             | Internal delivery operating system                                                                      |
| Primary promise      | Know what needs attention, why it matters, and what to do next                                          |
| Differentiator       | Shared operational context and authorization across work, people, money, communication, and AI actions  |
| Alternative replaced | Status chasing and truth fragmented across chat, boards, documents, spreadsheets, and memory            |
| Not today            | Commercial multi-tenant SaaS, customer portal, ERP, compliance system, or employee-surveillance product |

## Target users and jobs

| User                  | Primary job to be done                                                                            | Evidence of value                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Founder/leadership    | Identify delivery, cash, capacity, or people interventions before they become expensive           | Faster intervention, fewer surprises, reconciled reports               |
| Delivery/project lead | Sequence work, expose blockers, balance capacity, and communicate reliable status without chasing | Lower coordination time, fewer unowned blockers, better predictability |
| HR/people operator    | Run leave, reviews, resignation, and lifecycle workflows consistently and audibly                 | Shorter cycle time, fewer manual follow-ups, policy compliance         |
| Finance/admin         | Keep invoices, payments, expenses, and reporting current and correct                              | Lower invoice aging, reconciliation accuracy, fewer manual corrections |
| Team member           | Understand personal commitments, changes, dependencies, and where help is needed                  | Faster time-to-next-action, less context switching                     |
| Automation owner      | Extend approved workflows without bypassing user identity or business rules                       | Reliable scoped automation, attributable outcomes                      |

## Product principles

1. **Action before analytics.** Every insight should expose evidence, ownership, and a safe next action.
2. **One operational truth, not one visual style.** Consolidation is valuable only when definitions and ownership agree.
3. **Permission-aware by construction.** Role, relationship, scope, and active status travel with every action surface.
4. **AI proposes; policy decides.** Model output never replaces authorization, validation, confirmation, or accounting rules.
5. **Calm escalation.** Rank attention; do not turn every metric into an alarm.
6. **Reduce work, do not add reporting.** If a workflow requires duplicate updates, the product has failed.
7. **Durability before delight for systems of record.** Files, schema, audit, and recovery precede expansion.
8. **Measure outcomes, not feature count.** Adoption matters only when coordination, delivery, economics, or trust improve.

## Attention-queue concept

The initial queue should combine a small set of explainable signals:

| Signal family           | Example                                                        | Evidence shown                                      | Available action                                       |
| ----------------------- | -------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Delivery risk           | Milestone due soon with blocked/high-priority tasks            | Due date, blockers, assignees, last activity        | Reassign, resolve blocker, update status, notify owner |
| Ownership gap           | Important task/project has no responsible active owner         | Membership, assignment, status                      | Assign or request owner                                |
| Capacity conflict       | Active commitments exceed available team capacity              | Assigned work, leave, due dates                     | Rebalance or adjust date/scope                         |
| Cash action             | Sent/overdue invoice requires follow-up                        | Invoice status, due date, payment history, currency | Draft reminder, record payment, escalate               |
| Operational deadline    | Contract expiry, recurring expense, resignation date           | Effective date and current workflow state           | Review, post, renew, or complete offboarding           |
| Decision request        | Leave/review/resignation/invoice action awaits authorized user | Request, policy state, conflicts                    | Approve/reject/request changes                         |
| Change since last visit | Material record changed or automation completed                | Actor, timestamp, before/after/audit context        | Review or acknowledge                                  |

The first version should use deterministic rules. AI may summarize, group, and draft actions, but should not invent risk scores or personnel judgments.

## Six-week internal pilot

### Pilot selection

Choose one active delivery team with:

- multiple concurrent projects;
- a willing delivery lead;
- enough work volume to expose coordination costs;
- no imminent critical launch that makes experimentation unsafe;
- leadership commitment to use the queue rather than parallel status spreadsheets.

### Week 0: baseline

1. Interview the team and map current tools/status rituals.
2. Measure weekly status-chasing time.
3. Record on-time milestone rate, unowned blockers, overdue task aging, and invoice follow-up cycle where relevant.
4. Define the queue rules and assign an owner for every signal.
5. Agree what data will **not** be used for employee scoring.

### Weeks 1-2: narrow operation

- Delivery risks, ownership gaps, upcoming deadlines, and pending approvals only.
- Daily 10-minute observation with the product owner.
- Fix workflow-breaking defects before adding signal families.
- Record false positives, missing signals, ignored recommendations, and manual work displaced.

### Weeks 3-4: controlled expansion

- Add cash/operational deadlines where data definitions are reliable.
- Allow assistant-generated summaries and drafts, never autonomous consequential actions.
- Measure time-to-resolution and queue-to-action conversion.

### Weeks 5-6: evaluate

- Compare outcomes to baseline.
- Interview every role, including non-adopters.
- Identify trust failures, definition conflicts, and duplicate-work regressions.
- Choose expand, iterate, narrow, or stop. Do not declare success from usage alone.

## Pilot scorecard

| Outcome             | Proposed pilot target                                                               | Guardrail                                                     |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Weekly adoption     | At least 60% of invited knowledge workers                                           | No mandatory busywork to inflate activity                     |
| Delivery-lead habit | At least 3 meaningful active days/week                                              | Opening the app without action does not count                 |
| Coordination effort | At least 25% less recurring status-chasing time                                     | Confirm through interviews/time sampling, not telemetry alone |
| Ownership clarity   | Fewer unowned high-priority blockers                                                | Never assign silently                                         |
| Predictability      | Improvement in on-time milestone rate or forecast confidence                        | Use one signed definition of complete/done                    |
| Queue usefulness    | Majority of surfaced items lead to action, acknowledgement, or documented dismissal | Track false-positive reason                                   |
| Trust               | No unresolved severity-1 incident; all consequential AI actions auditable           | A privacy/surveillance complaint is a stop signal             |
| Economics           | Faster invoice follow-up or lower aging where finance is in scope                   | Currency-correct only; no mixed sums                          |

## Product analytics requirements

Instrumentation must be minimal and privacy-aware:

- invited, activated, and weekly active users by role;
- module reach and meaningful actions, not raw clicks;
- time-to-first-value from invite acceptance;
- queue item created, viewed, acted, dismissed, expired, and false-positive reason;
- assistant proposal, approval, denial, execution, failure, and estimated cost;
- workflow cycle times using approved business definitions;
- no keystroke logging, hidden productivity score, or individual ranking.

## Near-term roadmap priority

| Priority | Theme                                                                  | Why                                                                |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| P0       | Durable storage, migrations/recovery, security blockers, CI/tests      | Trust foundation; pilot data must survive and actions must be safe |
| P1       | Observability, distributed limits, scheduled work, finance definitions | Makes attention signals reliable and failures visible              |
| P2       | Attention queue and role-aware dashboard                               | Creates the core operating habit                                   |
| P3       | Adoption/outcome instrumentation                                       | Proves whether the habit creates value                             |
| P4       | Complexity reduction and additional integrations                       | Only after behavior and contracts are tested                       |

## Commercialization option

Commercialization is an **Open Decision**, not the current product state. If internal value repeats across multiple teams and P0 controls close, test a paid design-partner model before building broad SaaS infrastructure.

### Proposed discovery offer

| Offer                     | Hypothesis                                                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Design partner            | 3-5 service firms, 6-month term, up to 25 users, high-touch onboarding and weekly feedback                                                     |
| Indicative price          | `$500/month` during design-partner discovery; a test, not a published commitment                                                               |
| Candidate packaging later | Delivery core around `$12/active user/month`; cross-functional Operations around `$24/active user/month`; enterprise only after controls exist |
| Required evidence         | Repeatable onboarding, measurable ROI, tenant isolation, support capacity, security/privacy readiness, and willingness to pay                  |

These prices are hypotheses and require customer interviews and current market validation. They must not appear in customer-facing material without leadership approval.

## Commercial readiness gates

Do not accept an external customer until all are true:

1. Tenant-boundary architecture and isolation tests exist.
2. P0 security, data, file, recovery, CI, and observability risks are closed.
3. Privacy notice, DPA/subprocessor register, retention/deletion/export, breach process, and customer terms are approved.
4. Support ownership, severity/SLA language, onboarding, billing, offboarding, and data export are operational.
5. At least two internal teams and three design partners demonstrate repeatable value.
6. Unit economics include hosting, database, realtime, email, AI, support, and compliance costs.

## Product decision log

| Decision                         | Current status | Recommended owner             |
| -------------------------------- | -------------- | ----------------------------- |
| Internal-first boundary          | Proposed       | Leadership                    |
| Attention queue as product wedge | Proposed       | Product + Delivery            |
| Pilot team and success metrics   | Open           | Product owner + Delivery lead |
| Finance metric definitions       | Open           | Finance + Product             |
| Employee analytics guardrails    | Open           | People + Privacy + Leadership |
| Commercialization timing         | Open           | Leadership                    |

## Related documents

- [Bootstrap traction model](../business/BOOTSTRAP-TRACTION-MODEL.md) · [Project status](../executive/PROJECT-STATUS.md) · [Product/business brief](../business/PRODUCT-BUSINESS-BRIEF.md) · [Metrics and roadmap](../business/METRICS-ROADMAP.md) · [Experience and accessibility](EXPERIENCE-ACCESSIBILITY.md) · [Risk register](../executive/RISK-REGISTER.md)
