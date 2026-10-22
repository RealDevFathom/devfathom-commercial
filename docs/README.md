# DevFathom Hub documentation atlas

**Internal · Confidential · Code-grounded snapshot: 2026-07-12**

This directory is the canonical documentation set for DevFathom Hub. It is written for leadership, engineering, product, operations, security reviewers, and future maintainers. The application is an internal operating system for DevFathom; it is not currently positioned as a commercial product.

The atlas was researched against:

- branch `Design-1`, committed baseline `aae58c6`, plus the local uncommitted UI redesign;
- resolved installs Next.js `16.2.10`, React `19.2.7`, Prisma `7.8.0`, tRPC `11.17.0`, AI SDK `6.0.207`, Base UI `1.5.0`, and PostgreSQL;
- 60 Prisma models, 23 enums, 20 composed tRPC domains (22 router files) with 229 procedures, 16 REST route files, and 96 assistant tools across 10 factories;
- the linked Vercel project and its Production, Preview, and Development environment inventories;
- live TypeScript, ESLint, dependency-audit, deployment, and repository-structure checks.

The atlas currently contains **31** Markdown documents, excluding historical design material under `docs/superpowers/`. Verified code counts are consolidated in the [glossary and source map](reference/GLOSSARY-SOURCE-MAP.md) and the dated [validation report](reference/VALIDATION-REPORT.md).

## Evidence labels

Every document uses four labels where applicable:

- **Verified** — directly supported by current code, schema, configuration, CLI output, or a live deployment check.
- **Inferred** — a reasonable business or operational interpretation that is not encoded as an enforceable rule.
- **Proposed** — a recommended target state, owner, policy, metric, or roadmap item.
- **Open Decision** — a material fork that requires an authorized business/technical owner; the repository cannot decide it.

Where source code and an older root-level document disagree, current code and schema win. Historical files such as `BUGS.md`, `IMPROVEMENTS.md`, `SECURITY.md`, `PRODUCT-OVERVIEW.md`, and `DEPLOY-NOTES.md` remain useful evidence, but they are not the current source of truth.

## Start here by audience

| Audience                     | Read first                                                           | Then                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Executive / owner            | [Project status](executive/PROJECT-STATUS.md)                        | [Executive brief](executive/EXECUTIVE-BRIEF.md), [technical diligence](executive/TECHNICAL-DUE-DILIGENCE.md), [risk register](executive/RISK-REGISTER.md)                                                              |
| Engineering lead             | [System architecture](architecture/SYSTEM-ARCHITECTURE.md)           | [Engineering handbook](engineering/ENGINEERING-HANDBOOK.md), [quality and performance](engineering/QUALITY-PERFORMANCE.md)                                                                                             |
| Product / operations         | [Product strategy](product/PRODUCT-STRATEGY.md)                      | [Bootstrap traction model](business/BOOTSTRAP-TRACTION-MODEL.md), [product/business brief](business/PRODUCT-BUSINESS-BRIEF.md), [roles/workflows](business/ROLES-WORKFLOWS.md), [metrics](business/METRICS-ROADMAP.md) |
| Security / privacy reviewer  | [Security architecture](architecture/SECURITY-ARCHITECTURE.md)       | [Threat model](architecture/THREAT-MODEL.md), [data/privacy governance](governance/DATA-PRIVACY-GOVERNANCE.md), [risk register](executive/RISK-REGISTER.md)                                                            |
| Platform / DevOps            | [Deployment and environments](operations/DEPLOYMENT-ENVIRONMENTS.md) | [Runbooks](operations/RUNBOOKS.md), [business continuity](operations/BUSINESS-CONTINUITY.md)                                                                                                                           |
| Automation / agent developer | [API and automation](engineering/API-AUTOMATION-REFERENCE.md)        | [Integrations and flows](architecture/INTEGRATIONS-AND-FLOWS.md)                                                                                                                                                       |
| New team member              | [Product and business brief](business/PRODUCT-BUSINESS-BRIEF.md)     | [Engineering handbook](engineering/ENGINEERING-HANDBOOK.md), [glossary/source map](reference/GLOSSARY-SOURCE-MAP.md)                                                                                                   |
| Diligence reviewer           | [Diligence data-room index](executive/DILIGENCE-DATA-ROOM-INDEX.md)  | [Project status](executive/PROJECT-STATUS.md), [technical diligence](executive/TECHNICAL-DUE-DILIGENCE.md), [ownership RACI](governance/OWNERSHIP-RACI.md)                                                             |
| Designer / frontend reviewer | [Experience and accessibility](product/EXPERIENCE-ACCESSIBILITY.md)  | [Product strategy](product/PRODUCT-STRATEGY.md), [quality and performance](engineering/QUALITY-PERFORMANCE.md)                                                                                                         |

## Atlas map

### Executive and diligence

- [Project status](executive/PROJECT-STATUS.md) — current verified RAG status, deployment state, blockers, workstreams, and decisions.
- [Executive brief](executive/EXECUTIVE-BRIEF.md) — what the system is, current posture, and immediate decisions.
- [Technical due diligence](executive/TECHNICAL-DUE-DILIGENCE.md) — architecture, maintainability, security, delivery, data, vendor, and operational assessment.
- [Risk register](executive/RISK-REGISTER.md) — severity, evidence, impact, recommendation, owner, and acceptance criteria.
- [Diligence data-room index](executive/DILIGENCE-DATA-ROOM-INDEX.md) — available/missing evidence and external-review request list.

### Architecture

- [System architecture](architecture/SYSTEM-ARCHITECTURE.md) — contexts, containers, layers, modules, deployment topology, and request paths.
- [Nuxt + FastAPI migration](architecture/NUXT-FASTAPI-MIGRATION.md) - current runtime migration boundary, compatibility approach, local development, and remaining parity sequence.
- [Data architecture](architecture/DATA-ARCHITECTURE.md) — domain model, ownership, lifecycle, retention, money, and migration posture.
- [Security architecture](architecture/SECURITY-ARCHITECTURE.md) — authentication, authorization, audit, API, AI, realtime, upload, and control boundaries.
- [Threat model](architecture/THREAT-MODEL.md) — assets, actors, trust boundaries, abuse cases, mitigations, and verification plan.
- [Integrations and runtime flows](architecture/INTEGRATIONS-AND-FLOWS.md) — Ably, Google AI, Brevo, Gmail, Outlook, JaaS, Vercel, PostgreSQL, and webhooks.

### Engineering

- [Engineering handbook](engineering/ENGINEERING-HANDBOOK.md) — setup, structure, conventions, safe-change workflow, database workflow, and troubleshooting.
- [API and automation reference](engineering/API-AUTOMATION-REFERENCE.md) — tRPC, REST, API tokens, webhooks, assistant tools, and extension rules.
- [Quality and performance](engineering/QUALITY-PERFORMANCE.md) — current baselines, test strategy, CI target, performance practices, and quality gates.

### Business and product

- [Bootstrap traction model](business/BOOTSTRAP-TRACTION-MODEL.md) - service-led offer, ICP, pricing, founder sales system, 90-day traction plan, economics, cash model, and external-access gates.
- [Product and business brief](business/PRODUCT-BUSINESS-BRIEF.md) — purpose, value streams, capabilities, stakeholders, assumptions, and boundaries.
- [Roles and workflows](business/ROLES-WORKFLOWS.md) — personas, permissions, module workflows, and business rules.
- [Metrics and roadmap](business/METRICS-ROADMAP.md) — outcome metrics, operational metrics, adoption measures, roadmap, and decision cadence.

### Product and experience

- [Product strategy](product/PRODUCT-STRATEGY.md) — internal-first recommendation, attention-queue wedge, pilot, metrics, roadmap, and commercial gates.
- [Experience and accessibility](product/EXPERIENCE-ACCESSIBILITY.md) — information architecture, design principles, WCAG 2.2 AA target, critical journeys, and QA gate.

### Operations

- [Deployment and environments](operations/DEPLOYMENT-ENVIRONMENTS.md) — Vercel topology, variables, database changes, release flow, and rollback.
- [Runbooks](operations/RUNBOOKS.md) — incident triage and service-specific recovery procedures.
- [Business continuity](operations/BUSINESS-CONTINUITY.md) — proposed RTO/RPO, backup requirements, restore tests, and continuity ownership.

### Governance and reference

- [Decision register](governance/DECISION-REGISTER.md) — current architectural decisions and ADR template.
- [Release checklist](governance/RELEASE-CHECKLIST.md) — evidence required before preview and production releases.
- [Data and privacy governance](governance/DATA-PRIVACY-GOVERNANCE.md) — classification, lifecycle, vendors, AI/privacy, rights workflows, and open legal decisions.
- [Ownership and RACI](governance/OWNERSHIP-RACI.md) — role-based accountability, decision rights, cadence, and owner-acceptance record.
- [Environment variable catalogue](reference/ENVIRONMENT-VARIABLES.md) — required, optional, legacy, and deployment coverage.
- [Glossary and source map](reference/GLOSSARY-SOURCE-MAP.md) — terminology, canonical files, and known documentation drift.
- [Validation report](reference/VALIDATION-REPORT.md) — exact checks, results, counts, evidence sampling, deployment inspection, and limitations.

## Current headline status

| Area                     | State                 | Evidence summary                                                                                                       |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Product breadth          | Strong                | Projects, CRM, finance, people, meetings, chat, notes, REST, webhooks, and AI operator are implemented.                |
| Type safety              | Passing               | `bunx tsc --noEmit` passed on 2026-07-12.                                                                              |
| Production build         | Passing               | `bun run build` passed on 2026-07-12 with Next.js 16.2.10 and Prisma 7.8.0.                                            |
| Lint                     | Failing               | 14 errors and 6 warnings across email, HR, meetings, notes, Kanban, reviews, voice, and meeting-call code.             |
| Source formatting        | Failing               | `bun run format:check` reports 70 source files; atlas Markdown itself is formatted.                                    |
| Automated tests          | Absent                | No test files, test script, or CI workflow were found.                                                                 |
| Database change control  | Unsafe                | Prisma schema exists, but no migration history is checked in; operational scripts rely on `db push`.                   |
| Durable uploads          | Not production-ready  | Uploads write to local `private-uploads/`; Vercel runtime storage is not a durable object store.                       |
| Observability            | Insufficient          | Application logs and audit rows exist, but no error tracker, metrics, health endpoint, alerts, or SLOs are configured. |
| Dependency security      | Action required       | `bun audit` reported 1 critical and 2 moderate transitive advisories.                                                  |
| Deployment               | Active / drift open   | Recent builds are Ready; canonical alias points to an older Ready deployment and intent is undocumented.               |
| Documentation/governance | Complete / unapproved | 29-document atlas is complete; proposed policies still require named owner acceptance.                                 |

## Documentation maintenance contract

1. Update the relevant document in the same pull request as a changed business rule, integration, environment variable, API contract, or operational dependency.
2. Mark proposals as **Proposed** until an owner accepts them and implementation evidence exists.
3. Add material architecture decisions to the decision register.
4. Re-run the diligence evidence quarterly and before investor, customer, insurer, or acquisition review.
5. Never paste credentials, production data, customer PII, raw access tokens, or private key material into documentation.
6. Treat line numbers as orientation only; file paths and named symbols are the durable evidence anchors.
