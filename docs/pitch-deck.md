# Pitch-deck source

Use this Markdown as source for investor, partner, or customer presentations. Replace every `[VERIFY]` placeholder before publication. Do not invent traction, customers, savings, compliance, SLA, or benchmarks.

## Slide 1 — DevFathom Commercial

**One operating workspace for agencies and companies.**

Speaker note: The product combines delivery, client, people, finance, collaboration, meetings, insights, and administration in an organization-scoped web workspace.

## Slide 2 — The operating problem

Teams coordinate work across disconnected task, document, meeting, CRM, HR, finance, and chat tools.

Speaker note: Present this as the product thesis. Add customer interview evidence only after approval: `[VERIFY: interview count and source]`.

## Slide 3 — The product

One calm workspace, with a seller-operated control plane for activation, entitlements, support, and lifecycle.

Speaker note: Point to `README.md` and `docs/admin-platform/control-plane.md` as source evidence.

## Slide 4 — Why it can be trusted

- Organization-scoped access and forced PostgreSQL RLS.
- Role-aware authorization and audited support access.
- AWS staging with separate production preparation.

Speaker note: These are repository-backed controls, not a certification claim. Cite the RLS ADR, threat model, and AWS deployment record (`docs/deploy/aws.md`).

## Slide 5 — Current product surface

Projects, clients, finance, notes, team/HR, chat, insights, organization administration, REST/API docs, and Ask Fathom.

Speaker note: Mark Meetings and connected email as rollout-dependent. Meetings media endpoints are not live. Do not present planned tiers as shipped limits.

## Slide 6 — Commercial model

Tentative Studio, Scale, and Enterprise/contact-sales packaging.

Speaker note: Pricing, limits, support terms, and AI/meeting allowances are `[VERIFY: owner decision]`.

## Slide 7 — Enterprise path

Manual onboarding, optional dedicated environment, SSO/SCIM, custom domain/brand, and controlled implementation.

Speaker note: Customer IdP, DNS, dedicated environment, backup policy, and contract terms are gates, not universal defaults.

## Slide 8 — Roadmap

Near-term: complete Meetings application/media integration, complete and deploy production-readiness fixes, then connected email, richer finance/accounts, and tiered Insights. Later: in-house realtime and broader commercial packaging. Native mobile remains future scope.

Speaker note: Use the [status ledger](status-ledger.md) for release truth.

## Slide 9 — Proof points

- Source-backed module and route inventory.
- Tenant-isolation tests and release workflows in repository.
- AWS staging evidence.

Speaker note: `[VERIFY: current test run, staging URL, and approved metrics]`. Never turn a local build into production or customer evidence.

## Slide 10 — Ask

Partner: implementation/design partners for agency operating workflows. Customer: discovery for a controlled web rollout. Investor: `[VERIFY: approved traction and financing narrative]`.
