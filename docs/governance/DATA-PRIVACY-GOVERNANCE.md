# Data and privacy governance

**Internal · Confidential · Working policy: 2026-07-12**  
**Status:** Proposed. Requires leadership, legal/privacy, people, finance, and security acceptance.

## Purpose and limitation

DevFathom Hub processes personnel, performance, finance, client, contract, communication, meeting, email, device/request, and audit information. The repository implements access controls but does not establish a complete organizational privacy program.

This document provides a control framework and decision inventory. It is **not legal advice** and does not determine which jurisdiction, employment, tax, contractual, or privacy law applies. Retention, legal basis, employee notice, monitoring, cross-border transfer, and data-subject rights require qualified local review.

Reference framework: [NIST Privacy Framework](https://www.nist.gov/privacy-framework/privacy-framework), particularly inventory/mapping, governance, processing-ecosystem risk, control, communication, and protection.

## Governance principles

1. Collect and expose only data needed for a documented business purpose.
2. Treat internal access as a privacy boundary; “employee” does not mean “may see everything.”
3. Attach owner, purpose, classification, retention trigger, and deletion/export behavior to every data domain.
4. Prefer derived operational signals over permanent sensitive raw history.
5. Make automated/AI processing explainable and prohibit hidden employee scoring.
6. Keep vendor processing within approved purpose, scope, location, retention, and exit terms.
7. Preserve legal/financial/audit evidence only under an approved schedule and access model.
8. Test deletion, export, restore, and legal hold rather than documenting intention only.

## Data classification

| Class        | Definition                                                                         | Examples in the Hub                                                                                         | Minimum handling                                                                                            |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Public       | Approved for unrestricted disclosure                                               | Public brand assets, published company URL                                                                  | Integrity review; no secrets/PII                                                                            |
| Internal     | Routine internal operating context with limited harm if disclosed                  | Non-sensitive project labels, general meeting titles, internal navigation metadata                          | Authenticated access; no public links by default                                                            |
| Confidential | Business/client/team information whose disclosure causes material harm             | Client/project/task/note/chat content, contracts, contact details, rates, attendance                        | Need-to-know/object access, secure transfer, vendor review, controlled export                               |
| Restricted   | Credentials, financial, HR/performance, termination, mailbox, or security evidence | Password hashes, tokens, salaries/rates, invoices/payments, reviews, leave/resignation, OAuth tokens, audit | Least privilege, encryption/hashed secret design, strong audit, retention/legal review, incident escalation |

Classification belongs to the record **and its parent context**. A filename or notification derived from a Restricted record must not be treated as merely Internal.

## Data-domain inventory

| Domain                | Data subjects                            | Purpose                                                         | Classification                            | Current access model                                     | Open governance item                                                       |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Identity/profile      | Staff, invitees                          | Authentication, directory, attribution                          | Confidential/Restricted                   | User/role/status plus directory/detail procedures        | Team-detail PII visibility and field minimization                          |
| People/HR             | Staff                                    | Leave, reviews, resignation, termination, employment operations | Restricted                                | Employee self-service; HR/Admin workflows; guard rules   | Retention, notice, reviewer access, legal hold                             |
| Client/contract       | Client contacts and staff                | Relationship and delivery administration                        | Confidential/Restricted                   | Authenticated users with module/resource rules           | Contact consent/source, contract retention/export                          |
| Delivery              | Staff and client context                 | Projects, boards, tasks, time, milestones, files                | Confidential                              | Project membership/leadership and authenticated surfaces | File ACL lifecycle, stale data, external sharing                           |
| Finance               | Clients, staff, vendors                  | Invoices, payments, expenses, P&L, budgets                      | Restricted                                | Admin-bound access; finance API double gate              | Currency/FX policy, retention, reconciliation/export                       |
| Chat/notes            | Staff and mentioned parties              | Collaboration and knowledge                                     | Confidential/Restricted by content        | Membership, author, visibility/share rules               | Retention, legal hold, private-DM expectations, export                     |
| Meetings/attendance   | Staff/attendees                          | Scheduling, video, attendance                                   | Confidential                              | Creator/attendee/role logic                              | Recording policy (none evidenced), attendance retention                    |
| Connected mailbox     | Staff and external correspondents        | Read/send mailbox workflow                                      | Restricted                                | Mailbox owner; feature disabled                          | Consent, provider scope, retention, token security, deletion               |
| AI interactions       | Staff and referenced records             | Summarization and authorized operations                         | Confidential/Restricted                   | Session context and tool authorization                   | Provider retention, prohibited data, evaluation, prompt/response retention |
| Audit/security        | Staff, token actors, request/device data | Accountability, security, troubleshooting                       | Restricted                                | Admin/audit surfaces                                     | Completeness, append-only, immutable archive, retention, access review     |
| Vendor telemetry/logs | Users/requests                           | Hosting, delivery, error diagnosis                              | Confidential/Restricted depending payload | Vendor/platform controls outside repository              | Logging minimization, retention, residency, support access                 |

## Data lifecycle controls

### Collection

- Every new field/event requires purpose, classification, owner, consumer, and retention trigger.
- Do not capture secret values, message bodies, HR text, or financial payloads in generic analytics/logs.
- AI context selection should minimize records and fields to the user's requested task.
- Product analytics should measure workflow adoption without individual productivity ranking.

### Use and access

- Continue role plus object/relationship authorization.
- Review the inconsistent team roster/detail exposure before relying on directory privacy.
- Require privileged MFA and periodic access review for Admin/HR/platform/vendor consoles.
- Treat support/debug access as time-bound privileged access with audit.
- Prevent note mentions, notifications, URLs, or AI summaries from granting or leaking access.

### Sharing and vendors

Before enabling or materially expanding a vendor:

1. Document categories/fields sent, purpose, frequency, and initiating user.
2. Review DPA/terms, subprocessors, hosting/data residency, retention, model-training use, security, breach notice, and deletion/return on exit.
3. Define technical minimization, encryption, scopes, and key ownership.
4. Record owner, approval date, renewal/review date, and exit/migration plan.
5. Update the vendor register and threat model.

### Retention

There is no approved retention schedule today. The following are **decision categories, not legal durations**:

| Data                                     | Retention trigger to decide                                               | Required owner input             |
| ---------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| Invite/reset/session security records    | Expiry plus short security investigation window                           | Security                         |
| Audit/API/webhook evidence               | Event date plus approved security/business evidence period                | Security + Legal/Privacy         |
| HR/reviews/leave/resignation/termination | End of employment or workflow plus jurisdictional employment requirement  | People + Legal                   |
| Invoices/payments/expenses/contracts     | Financial year/contract end plus accounting/tax/contract requirement      | Finance + Legal                  |
| Projects/tasks/time/client records       | Project/client closure plus support, contract, and knowledge needs        | Delivery + Client owner          |
| Chat/notes/meetings                      | Last activity or workspace lifecycle plus collaboration/legal-hold policy | Product + Legal/Privacy          |
| Connected mailbox data/tokens            | Disconnect/account removal plus minimal operational grace                 | Mailbox owner + Security/Privacy |
| AI prompts/responses/tool traces         | Request completion plus approved troubleshooting/evaluation window        | AI + Privacy/Security            |
| Uploaded files                           | Parent-record lifecycle or explicit owner deletion                        | Data owner + Platform            |
| Platform/vendor logs                     | Capture date plus minimum troubleshooting/security need                   | Platform + Security/Privacy      |

The approved schedule must specify normal deletion, backup aging, legal hold, export, exceptions, and evidence of execution.

### Deletion and correction

- Separate user deactivation from deletion; references may need pseudonymization rather than cascade loss.
- Define which records are authoritative and who may correct them.
- Preserve financial/audit integrity through restricted correction/reversal rather than silent overwrite.
- Ensure parent deletion does not orphan durable files, vendor data, search indexes, or audit references.
- Propagate deletion/disconnect to Gmail/Graph tokens, Ably state where relevant, AI/vendor retained data where contractually supported, and object storage.

### Export and portability

Proposed export package by subject/domain:

- profile and account state;
- leave/review/resignation records subject to third-party and legal redaction;
- authored/owned notes and relevant collaboration data under policy;
- API/audit records attributable to the subject where disclosure is permitted;
- machine-readable format plus human-readable index;
- source, capture date, classification, and redactions recorded.

Export authorization, identity verification, deadline, review, secure delivery, and request log are organizational processes not implemented today.

### Legal hold

An approved hold must suspend normal deletion for specifically scoped records, document authority/reason, restrict access, preserve chain of custody, and be lifted explicitly. No legal-hold mechanism is evidenced today.

## Privacy and AI

1. Do not send credentials, raw secrets, unnecessary HR narratives, private messages, or full mailbox content to the model by default.
2. Maintain an approved model/provider list and document training/retention/region terms.
3. Explain when AI generated a summary or recommendation and link source records.
4. Prohibit autonomous termination, compensation, performance scoring, permission changes, financial posting, and external communication without authorized human confirmation.
5. Record proposed action, approval/denial, execution result, and actor.
6. Evaluate prompt injection, cross-user data leakage, harmful inference, and cost before model/tool changes.
7. Provide a non-AI path for essential workflows.

## Individual/employee transparency

Before broad internal adoption, publish an employee-facing notice that explains:

- what categories are collected;
- why they are used;
- who can access them;
- which vendors/processors receive them;
- retention/deletion approach;
- whether AI is used and its limits;
- whether activity is monitored and what is explicitly **not** used for performance scoring;
- how to request access/correction or raise a concern;
- incident/contact path.

## Privacy incident handling

Treat unauthorized access, misdirected email/webhook, wrong-account mailbox linking, cross-user AI disclosure, lost file/database data, credential exposure, or excessive logging as a privacy/security incident.

1. Contain access or disable the integration.
2. Preserve evidence without expanding exposure.
3. Identify data categories, subjects, recipients, systems, time window, and whether data was merely accessible or actually accessed.
4. Engage the named security/privacy/legal owners to determine notification obligations.
5. Correct/rotate/delete/revoke as appropriate.
6. Record decisions and remediation; update the threat/risk registers.

Detailed mechanics: [runbooks](../operations/RUNBOOKS.md).

## Governance evidence required

- Approved data inventory and classification owner.
- Employee/customer notices and consent/contract basis where applicable.
- Retention, deletion, export, correction, and legal-hold procedures.
- Request and incident logs.
- Quarterly access review.
- Vendor DPA/subprocessor/residency/retention/exit records.
- Deletion and export test results.
- AI provider/evaluation/change records.
- Training/awareness record for privileged operators.

## Open decisions

| ID    | Decision                                                                | Owner roles                                 |
| ----- | ----------------------------------------------------------------------- | ------------------------------------------- |
| DG-01 | Applicable jurisdictions, legal bases, notices, and request obligations | Legal/Privacy + Leadership                  |
| DG-02 | Retention schedule by data domain, backup aging, and legal hold         | Legal/Privacy + People + Finance + Security |
| DG-03 | Team-directory/detail PII visibility                                    | People + Privacy + Product                  |
| DG-04 | Employee analytics and AI-use guardrails                                | People + Privacy + Leadership               |
| DG-05 | Vendor/model data residency, retention, and training-use requirements   | Privacy/Security + AI/Platform              |
| DG-06 | Audit archive and access policy                                         | Security + Legal/Privacy                    |
| DG-07 | Data export/deletion owner and service target                           | Privacy + Operations                        |

## Related documents

- [Data architecture](../architecture/DATA-ARCHITECTURE.md) · [Security architecture](../architecture/SECURITY-ARCHITECTURE.md) · [Threat model](../architecture/THREAT-MODEL.md) · [Risk register](../executive/RISK-REGISTER.md) · [Ownership RACI](OWNERSHIP-RACI.md)
