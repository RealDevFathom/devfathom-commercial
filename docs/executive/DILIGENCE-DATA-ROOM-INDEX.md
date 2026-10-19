# Diligence data-room index

**Internal · Confidential · Snapshot: 2026-07-12**  
**Audience:** leadership, investors, acquirers, insurers, enterprise reviewers, auditors, and the internal team preparing evidence.

## Purpose

This index separates what can be evidenced today from what is missing. It prevents the documentation atlas from being mistaken for external assurance. A repository can demonstrate implementation and intent; it cannot prove contracts, operating performance, legal compliance, or disaster recovery without supporting records.

Statuses:

- **Available:** evidence exists and is linked.
- **Partial:** useful repository evidence exists, but owner/operating/external proof is missing.
- **Missing:** no reliable evidence was found.
- **Not applicable today:** outside the current internal, single-company product boundary.

## Executive data-room map

| Domain                              | Status                          | Evidence available now                                                                                                                    | Missing evidence / request                                                                                        |
| ----------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Product purpose and scope           | **Available**                   | [Product/business brief](../business/PRODUCT-BUSINESS-BRIEF.md), [product strategy](../product/PRODUCT-STRATEGY.md), capability catalogue | Signed product owner, approved success metrics, pilot outcomes                                                    |
| Current project status              | **Available**                   | [Project status](PROJECT-STATUS.md), [risk register](RISK-REGISTER.md)                                                                    | Named owners, approved dates, closed-risk evidence                                                                |
| Validation evidence                 | **Available**                   | [Dated validation report](../reference/VALIDATION-REPORT.md)                                                                              | CI history and recurring signed evidence after the snapshot                                                       |
| Architecture                        | **Available**                   | System, data, security, integration architecture and diagrams                                                                             | Independent architecture review, measured capacity envelope                                                       |
| Source-code quality                 | **Partial**                     | Typecheck/lint/audit baseline, complexity findings, handbook, release checklist                                                           | CI history, code coverage, defect escape rate, protected-branch evidence                                          |
| Security design                     | **Partial**                     | Security architecture, [threat model](../architecture/THREAT-MODEL.md), layered authorization evidence                                    | External penetration test, ASVS verification, vulnerability-management records                                    |
| Identity and access                 | **Partial**                     | NextAuth, status gate, ABAC, object guards, API-token scopes, audit implementation                                                        | Privileged MFA policy, periodic access review, joiner/mover/leaver evidence                                       |
| Data model and integrity            | **Partial**                     | Prisma schema, relationship/data architecture, finance state machine                                                                      | Migration history, data dictionary owner, reconciliation and restore evidence                                     |
| Privacy and data governance         | **Partial**                     | [Data/privacy governance](../governance/DATA-PRIVACY-GOVERNANCE.md), field/domain inventory                                               | Approved retention schedule, legal bases, requests log, counsel review                                            |
| Availability and continuity         | **Missing/Proposed**            | Business-continuity plan and runbooks                                                                                                     | Provider backup contract, restore report, measured RPO/RTO, tabletop evidence                                     |
| Observability and incident response | **Missing/Proposed**            | Proposed runbooks/severity model                                                                                                          | Monitoring dashboards, alerts, on-call rota, incident and postmortem history                                      |
| Release management                  | **Partial**                     | Vercel deployment history, release checklist                                                                                              | CI/CD history, approvals, change tickets, alias decision record                                                   |
| Vendor management                   | **Partial**                     | Vendor inventory and data sensitivity in diligence/continuity docs                                                                        | DPAs, subprocessors, residency, retention, breach terms, vendor reviews                                           |
| AI governance                       | **Partial**                     | Model/tool architecture, tool authorization rules, risk findings                                                                          | Provider terms review, data-retention decision, eval results, cost budgets, model-change approvals                |
| Business continuity ownership       | **Missing**                     | Role placeholders and proposed cadence                                                                                                    | Named accountable owners and dated exercise plan                                                                  |
| Financial controls                  | **Partial**                     | Server-side invoice calculation, state machine, Decimal use                                                                               | Signed base-currency/FX/budget policy, reconciliation evidence, finance owner                                     |
| Commercial/legal                    | **Missing / not in repository** | Internal-product boundary documented                                                                                                      | Corporate records, customer/vendor contracts, IP assignments, licenses, privacy notices, employment/legal records |
| Commercial SaaS controls            | **Not applicable today**        | Single-company boundary explicitly documented                                                                                             | Tenant isolation, billing, self-service, external support/SLA/compliance program if strategy changes              |

## Technical evidence package

### Architecture and implementation

1. [System architecture](../architecture/SYSTEM-ARCHITECTURE.md)
2. [Data architecture](../architecture/DATA-ARCHITECTURE.md)
3. [Security architecture](../architecture/SECURITY-ARCHITECTURE.md)
4. [Threat model](../architecture/THREAT-MODEL.md)
5. [Integrations and flows](../architecture/INTEGRATIONS-AND-FLOWS.md)
6. `prisma/schema.prisma`
7. `src/server/routers/_app.ts`, `src/server/trpc.ts`, `src/server/authz.ts`
8. `src/lib/auth.ts`, `src/lib/api-auth.ts`, `src/lib/abac/`, `src/lib/authz.ts`
9. `src/app/api/`, `src/lib/ai/`, `src/lib/email/`, `src/lib/webhooks.ts`

### Engineering and delivery

1. [Engineering handbook](../engineering/ENGINEERING-HANDBOOK.md)
2. [API and automation reference](../engineering/API-AUTOMATION-REFERENCE.md)
3. [Quality and performance](../engineering/QUALITY-PERFORMANCE.md)
4. [Release checklist](../governance/RELEASE-CHECKLIST.md)
5. `package.json`, `bun.lock`, stale `package-lock.json`
6. TypeScript, ESLint, dependency-audit, link, and secret-scan outputs from the dated review

### Operations

1. [Deployment and environments](../operations/DEPLOYMENT-ENVIRONMENTS.md)
2. [Runbooks](../operations/RUNBOOKS.md)
3. [Business continuity](../operations/BUSINESS-CONTINUITY.md)
4. [Environment catalogue](../reference/ENVIRONMENT-VARIABLES.md)
5. [Dated validation report](../reference/VALIDATION-REPORT.md)
6. Linked Vercel project/deployment/environment **names-only** inspection

### Product and business

1. [Product/business brief](../business/PRODUCT-BUSINESS-BRIEF.md)
2. [Roles and workflows](../business/ROLES-WORKFLOWS.md)
3. [Metrics and roadmap](../business/METRICS-ROADMAP.md)
4. [Product strategy](../product/PRODUCT-STRATEGY.md)
5. [Experience and accessibility](../product/EXPERIENCE-ACCESSIBILITY.md)

### Governance

1. [Decision register](../governance/DECISION-REGISTER.md)
2. [Risk register](RISK-REGISTER.md)
3. [Data/privacy governance](../governance/DATA-PRIVACY-GOVERNANCE.md)
4. [Ownership RACI](../governance/OWNERSHIP-RACI.md)
5. [Glossary and source map](../reference/GLOSSARY-SOURCE-MAP.md)

## Diligence findings by question

### Can the system be understood and maintained?

**Qualified yes.** The modular-monolith shape, typed API/data layers, domain routers, and atlas make the system understandable. Maintainability risk is concentrated in large routers, large UI components, and assistant tool factories. Tests must precede major extraction work.

### Is access control thoughtfully designed?

**Yes, with material gaps.** The implementation layers session identity, account status for tRPC, ABAC capabilities, record relationships, API scopes, membership checks, and audit. Direct route status freshness, optional privileged MFA, OAuth callback validation, and webhook SSRF remain open.

### Is data recoverable and schema change controlled?

**No evidence yet.** No migration history, provider backup contract, or restore exercise is checked in. This is a primary production blocker.

### Is release quality repeatable?

**No.** TypeScript passes, but lint is red and automated tests/CI are absent. Recent deployments being Ready proves build/deploy completion, not application correctness.

### Is production observable?

**No.** Logs exist, but no health endpoint, error tracker, metric/alert stack, SLO, or on-call evidence was found.

### Is the product ready for commercial SaaS?

**No, and it is not currently designed as one.** There is no tenant boundary, customer identity, billing, self-service onboarding, external support/SLA, or commercial privacy/compliance program. These are strategic investments, not configuration tasks.

## Highest-value missing evidence

1. A dated database restore report with measured RPO/RTO.
2. A committed migration baseline and CI migration gate.
3. CI history showing type, lint, tests, build, audit, and preview smoke checks.
4. External penetration-test or ASVS verification report after P0 fixes.
5. Monitoring/alert screenshots plus a synthetic alert exercise.
6. Named ownership and on-call/escalation records.
7. Signed finance, privacy/retention, privileged-MFA, and AI-provider policies.
8. Vendor agreements: DPA, subprocessors, residency, retention, breach notification, and exit plan.
9. Six-week internal pilot report with adoption, coordination, predictability, economics, and trust outcomes.
10. Canonical production alias decision and release record explaining the current older target.

## External-review rules

- Share secrets, production data, personnel records, customer PII, or raw logs only through an approved secure room with least privilege.
- Prefer names-only environment inventories and redacted evidence.
- Time-box reviewer access and record exports/downloads where the platform permits.
- Every evidence item needs an owner, capture date, environment, and explanation of what it proves.
- Never claim certification, compliance, uptime, encryption coverage, or recovery ability without direct evidence.
- Record unresolved reviewer questions in the decision and risk registers rather than answering from memory.

## Suggested data-room folder structure

```text
00-index-and-scope/
01-corporate-and-ip/              # supplied outside this repository
02-product-and-market/
03-architecture-and-source/
04-security-and-privacy/
05-quality-and-release/
06-data-and-recovery/
07-operations-and-incidents/
08-vendors-and-contracts/         # supplied outside this repository
09-finance-and-controls/          # restricted; supplied outside this repository
10-open-items-and-management-responses/
```

## Limitations

This index is not an audit opinion. It does not validate corporate ownership, IP chain, financial statements, taxes, employment law, privacy-law applicability, customer contracts, insurance coverage, or vendor contractual terms. Those require named business/legal owners and source records outside the code repository.

## Related documents

- [Project status](PROJECT-STATUS.md) · [Technical due diligence](TECHNICAL-DUE-DILIGENCE.md) · [Risk register](RISK-REGISTER.md) · [Threat model](../architecture/THREAT-MODEL.md) · [Ownership RACI](../governance/OWNERSHIP-RACI.md)
