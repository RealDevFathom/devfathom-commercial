# Compliance posture

This document states product boundaries, not legal advice, certification, or a compliance attestation.

## Repository-backed controls

- **IMPLEMENTED** — Organization scoping, forced RLS, role/capability checks, module gates, audit paths, consent/privacy records, append-only operational histories, and controlled support access exist in repository scope. Evidence: [`docs/admin-platform/security-threat-model.md`](../admin-platform/security-threat-model.md), [`docs/restaurant/data-model.md`](../restaurant/data-model.md), [`tests/restaurant-m8-governance.test.ts`](../../tests/restaurant-m8-governance.test.ts).
- **IMPLEMENTED** — SOP records can capture assignments, occurrences, proof/evidence, verification decisions, and escalations. These controls can support a customer process; they do not certify the process. Evidence: [`docs/product/modules/sop.md`](../product/modules/sop.md).

## Pakistan tax and FBR boundary

- **PLANNED LEGAL/TAX REVIEW (WHA-243 legal/domain review)** — Determine applicable registration, invoice/receipt fields, tax rates, fiscal-device or real-time reporting duties, retention, branch/province rules, and who submits to FBR or other authorities.
- Current bills, receipts, taxes, closes, and operator-confirmed card tenders are operational records. No FBR integration, fiscal certification, tax engine, or automatic filing is claimed. Evidence: [`docs/product/modules/checkout.md`](../product/modules/checkout.md), [`docs/admin-platform/commercial-ledger.md`](../admin-platform/commercial-ledger.md).

## Data protection boundary

- **PLANNED LEGAL/PRIVACY REVIEW (WHA-243 legal/domain review)** — Establish controller/processor roles, lawful basis/consent wording, notices, retention/deletion, data-subject requests, subprocessors, cross-border transfers, breach process, and contract terms under applicable Pakistan law and customer obligations.
- Repository controls are technical evidence only. They do not prove legal compliance or production operating effectiveness.

## HACCP and SOP boundary

- **PLANNED DOMAIN REVIEW (WHA-243 legal/domain review)** — Customers may configure SOPs and evidence for food-safety workflows, but templates, critical limits, monitoring frequency, corrective actions, verification, records, and staff competence require qualified customer/domain ownership.
- No HACCP certification, food-safety compliance, regulator approval, or guaranteed hazard control is claimed.
