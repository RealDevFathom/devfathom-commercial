# Ownership and RACI

**Working governance model: 2026-07-12**  
**Status:** Proposed role-based accountability. Replace role placeholders with named people only after leadership acceptance.

## Why this exists

The most important current controls are documented but do not have named owners. A policy without an accountable owner, review date, and evidence is not an operating control.

RACI meanings:

- **A - Accountable:** owns the outcome and accepts residual risk; exactly one per row.
- **R - Responsible:** performs the work and produces evidence.
- **C - Consulted:** must be involved before a material decision.
- **I - Informed:** receives status/incident/change communication.

## Role catalogue

| Governance role           | Core accountability                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Executive sponsor         | Product boundary, funding, risk acceptance, major policy and external commitments                  |
| Product owner             | Product outcome, roadmap, adoption, workflow definitions, experience quality                       |
| Engineering lead          | Architecture, code quality, technical delivery, review standards, ADRs                             |
| Platform/operations owner | Vercel, environments, deployment, observability, storage, queues, continuity mechanics             |
| Security/privacy owner    | Threat/risk program, identity controls, security events, privacy governance, vendor security       |
| Data owner                | Database change/recovery, data integrity, classification implementation, export/deletion mechanics |
| Finance owner             | Accounting/FX/currency/KPI rules, invoice/payment reconciliation, finance access                   |
| People owner              | HR workflows, personnel-data access/retention, employee notice, joiner/mover/leaver process        |
| Delivery owner            | Project/task workflow definitions, completion semantics, capacity/blocker operating cadence        |
| AI owner                  | Model/provider/tool policy, evaluation, cost/quality controls, AI data handling                    |
| Client/business owner     | Client/contract data quality, customer communication and contractual expectations                  |

These are accountability roles, not necessarily full-time positions. One person may hold several roles in a small team, but conflicts must be explicit; the same person should not silently approve and evidence every high-risk control.

## Product and engineering RACI

| Activity                                | Executive | Product | Engineering | Platform | Security/Privacy | Data | Business owner |
| --------------------------------------- | --------- | ------- | ----------- | -------- | ---------------- | ---- | -------------- |
| Internal vs commercial product boundary | **A**     | R       | C           | C        | C                | C    | C              |
| Product roadmap and pilot               | I         | **A/R** | C           | C        | C                | I    | R/C            |
| Business-rule definition                | I         | **A**   | R           | I        | C                | C    | R              |
| Architecture decision/ADR               | I         | C       | **A/R**     | C        | C                | C    | I              |
| Code review and safe-change practice    | I         | I       | **A/R**     | C        | C                | C    | I              |
| Test strategy and CI gate               | I         | C       | **A/R**     | R        | C                | C    | I              |
| Accessibility and experience acceptance | I         | **A**   | R           | I        | C                | I    | C              |
| Release approval                        | I         | C       | **A**       | R        | C                | C    | I              |
| External product commitment             | **A**     | R       | C           | C        | C                | C    | C              |

## Platform, security, and data RACI

| Control                                         | Executive | Engineering | Platform | Security/Privacy | Data    | Finance/People/AI |
| ----------------------------------------------- | --------- | ----------- | -------- | ---------------- | ------- | ----------------- |
| Vercel project, alias, environments, deployment | I         | C           | **A/R**  | C                | I       | I                 |
| Durable private storage                         | I         | R           | **A/R**  | C                | C       | I                 |
| Database migrations                             | I         | R           | C        | C                | **A/R** | I                 |
| Backup/PITR and restore drill                   | I         | C           | R        | C                | **A**   | I                 |
| Health, metrics, alerts, on-call                | I         | R           | **A/R**  | C                | C       | I                 |
| Identity/session/MFA                            | I         | R           | C        | **A**            | I       | People C          |
| Threat/risk/vulnerability program               | I         | R           | R        | **A**            | C       | I                 |
| Privacy/data classification/retention           | I         | C           | C        | **A**            | R       | Finance/People C  |
| Secret/key rotation                             | I         | C           | R        | **A**            | C       | AI C              |
| Vendor security/privacy review                  | I         | C           | R        | **A**            | C       | AI/Business C     |
| Incident declaration/response                   | I         | R           | R        | **A**            | R       | Domain owner C    |
| Audit completeness/archive                      | I         | R           | R        | **A**            | R       | Finance/People C  |
| AI provider/tool governance                     | I         | R           | C        | C                | C       | **AI A/R**        |

## Business-domain RACI

| Domain                                | Accountable            | Responsible                      | Consulted                    | Required evidence                                                    |
| ------------------------------------- | ---------------------- | -------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| Delivery/project/task definitions     | Delivery owner         | Product + Engineering            | Team leads                   | Metric dictionary, workflow tests, pilot results                     |
| Client/contract records               | Client/business owner  | Delivery/operations              | Legal/Finance                | Data-quality review, contract lifecycle process                      |
| Invoice/payment/expense reporting     | Finance owner          | Finance operator + Engineering   | Product/Data                 | Signed currency/FX/budget policy, reconciliation record              |
| Leave/reviews/resignation/termination | People owner           | HR/People operator + Engineering | Security/Privacy/Legal       | Policy, access review, lifecycle test, employee notice               |
| Chat/notes/meetings                   | Product owner          | Engineering + Delivery           | Security/Privacy             | Visibility rules, retention decision, authorization tests            |
| API tokens/webhooks                   | Engineering lead       | Platform/Engineering             | Security/Privacy             | Scope/destination review, rotation/replay evidence                   |
| Connected mailbox                     | Security/privacy owner | Engineering/Platform             | Mailbox owner, Legal/Privacy | OAuth tests, provider approval, disconnect/delete evidence           |
| Product analytics                     | Product owner          | Engineering/Data                 | Privacy/People               | Metric purpose, minimization review, dashboard and deletion behavior |

## Risk ownership

Risk severity does not change ownership:

1. The **accountable** role decides mitigate/accept/transfer/avoid.
2. The **responsible** role produces evidence and reports slippage.
3. Security/privacy may block a release for an unaccepted Critical/High security/privacy risk.
4. Finance/People owners may block reports/workflows that violate signed domain rules.
5. Only the Executive sponsor accepts material residual business risk, with technical and domain-owner concurrence.

Recommended risk-register mapping:

| Risk cluster                                                         | Accountable role          |
| -------------------------------------------------------------------- | ------------------------- |
| Storage, deployment, observability, queues, rate limits, alias drift | Platform/operations owner |
| Migrations, backup/restore, data integrity                           | Data owner                |
| OAuth, SSRF, MFA, session freshness, audit integrity, privacy        | Security/privacy owner    |
| CI, lint, dependencies, complexity, lockfiles                        | Engineering lead          |
| Finance semantics and invoice client experience                      | Finance owner             |
| People PII and lifecycle workflows                                   | People owner              |
| AI cost, evaluation, provider/model governance                       | AI owner                  |
| Product adoption, attention queue, metric definitions                | Product owner             |

## Required operating cadence

| Cadence                     | Meeting/review                                                 | Owner                                       | Output                                                       |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| Weekly while P0 open        | Stabilization review                                           | Engineering/Platform with Executive sponsor | Updated risk status, blockers, evidence links                |
| Weekly during pilot         | Product learning review                                        | Product owner                               | Pilot scorecard, decisions, false positives, next experiment |
| Monthly                     | Access, incidents, dependencies, vendor and cost review        | Security/Platform/AI                        | Exceptions, rotations, cost/anomaly actions                  |
| Monthly                     | Finance/data reconciliation                                    | Finance/Data                                | Signed reconciliation and metric-definition issues           |
| Quarterly                   | Full risk, threat model, continuity, vendor and privacy review | Security/Privacy                            | Revised registers, access review, exercise schedule          |
| Quarterly                   | Documentation/evidence refresh                                 | Engineering lead                            | Updated snapshot date and verified counts                    |
| Annually or material change | External security/privacy/continuity assurance                 | Executive + Security                        | Test/report/acceptance evidence                              |

## Owner acceptance record

Populate this table in a reviewed change; do not insert names casually.

| Role                      | Named owner | Accepted date | Delegate | Review date |
| ------------------------- | ----------- | ------------- | -------- | ----------- |
| Executive sponsor         | TBD         |               |          |             |
| Product owner             | TBD         |               |          |             |
| Engineering lead          | TBD         |               |          |             |
| Platform/operations owner | TBD         |               |          |             |
| Security/privacy owner    | TBD         |               |          |             |
| Data owner                | TBD         |               |          |             |
| Finance owner             | TBD         |               |          |             |
| People owner              | TBD         |               |          |             |
| Delivery owner            | TBD         |               |          |             |
| AI owner                  | TBD         |               |          |             |
| Client/business owner     | TBD         |               |          |             |

## Escalation rule

If a required accountable owner is vacant, the Executive sponsor temporarily owns the decision. That is an explicit risk, not permission to leave the control unowned. Critical/High risks without an accepted owner remain release-red.

## Related documents

- [Project status](../executive/PROJECT-STATUS.md) · [Risk register](../executive/RISK-REGISTER.md) · [Decision register](DECISION-REGISTER.md) · [Release checklist](RELEASE-CHECKLIST.md) · [Business continuity](../operations/BUSINESS-CONTINUITY.md)
