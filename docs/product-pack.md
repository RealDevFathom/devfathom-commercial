# Product and commercial pack

Status: **SOURCE-BACKED WORKING PACK**. This is positioning material, not a price sheet or a claim of market traction.

## Product brief

DevFathom Commercial gives an agency or company one organization-scoped web workspace for projects, clients, finance, people, notes, chat, meetings, insights, and administration. A seller-operated control desk handles manual activation, commercial records, entitlements, support access, and lifecycle operations.

The wedge is operational coherence: fewer disconnected tools, shared context, and a controlled tenant boundary. The product is not yet a self-serve SaaS checkout or a replacement claim for every adjacent system.

Evidence: [`README.md`](../README.md), [`admin-platform/control-plane.md`](admin-platform/control-plane.md), [`admin-platform/commercial-ledger.md`](admin-platform/commercial-ledger.md).

## ICP and personas

| Persona | Job to be done | Relevant proof in repo |
| --- | --- | --- |
| Agency founder / operator | See delivery, clients, people, and cash in one operating surface | Dashboard, projects, clients, finance, team routes |
| Delivery lead | Coordinate tasks, notes, chat, meetings, and client context | Projects, notes, chat, meetings modules |
| Finance/admin owner | Track invoices, transactions, and P&L while controlling access | Finance routes and organization roles |
| Seller / implementation operator | Activate organizations, configure packages, domains, support, and lifecycle | Platform control desk and platform jobs |
| Enterprise IT / security lead | Require tenant controls, SSO/SCIM, domain options, and a controlled rollout | SSO/SCIM routes, RLS ADR, white-label docs |

These are product hypotheses grounded in the module and control-plane shape; they are not validated customer research.

## Problem and solution

Fragmented work across task trackers, documents, chat, meetings, CRM, HR, and finance creates duplicated context and inconsistent operating views. DevFathom’s proposed solution is a single web workspace with organization-scoped data, module entitlements, role-aware access, and a platform team that controls activation and enterprise configuration.

## Feature catalog

| Area | Current status | Commercial language |
| --- | --- | --- |
| Workspace dashboard | **IMPLEMENTED** | Available in the web workspace |
| Projects, Kanban, tasks, comments, Trello importer | **IMPLEMENTED** | Available; verify customer workflow fit |
| Clients and engagements | **IMPLEMENTED** | Available |
| Finance: invoices, transactions, P&L | **IMPLEMENTED / PARTIAL** | Available as an operating ledger; not an automated payments product |
| Notes and rich editing | **IMPLEMENTED** | Available |
| Team and HR | **IMPLEMENTED / PARTIAL** | Available; depth and policy fit require discovery |
| Chat and realtime | **PARTIAL** | Ably when configured; fallback exists; in-house realtime is planned |
| Ask Fathom | **PARTIAL** | Provider-adapter based, credit usage; AWS is current environment |
| Email | **PARTIAL** | Capture-safe delivery exists; connected inbox roadmap follows Meetings |
| Meetings | **PARTIAL / BLOCKED** | Wave-1 schema/reconciliation PR #23 merged and staging-verified; Cowork login/dashboard/responsive checks passed but admin discovery has an unresolved attendee-filter/list-policy defect; self-hosted media endpoints and public production rollout are not live |
| SSO / SCIM / custom domains | **PARTIAL** | Code and contracts exist; customer IdP/DNS rollout is a gate |
| Native mobile | **FUTURE** | Not in current scope |

## Packaging decision sheet

Tentative tiers only; no prices or limits are final.

| Tier | Intended fit | Candidate boundary | Decision state |
| --- | --- | --- | --- |
| Studio | Small teams needing the core operating workspace | Core modules and shared environment | **PLANNED** |
| Scale | Growing teams needing broader collaboration and connected inboxes | More modules, integrations, and usage allowance | **PLANNED** |
| Enterprise | Contracted organizations with IT/security requirements | Dedicated environment option, SSO, custom domain, implementation/support | **PLANNED / CONTACT SALES** |

Owner decisions still required: included modules, seats, AI credit policy, meetings limits, support model, data retention, and price. Do not publish numeric limits or price.

## Enterprise offer

The evidence-backed offer is a controlled implementation: manual activation, organization-scoped data, optional dedicated environment, SSO/SCIM paths, custom-domain/brand configuration, audited support access, and an agreed rollout gate. Dedicated infrastructure, customer IdP, DNS, sender, backup policy, and any SLA remain deployment-time decisions.

## Customer lifecycle

1. Discover operating pain, current tools, security constraints, and success criteria.
2. Seller creates and configures the organization; activation is manual.
3. Agree modules/package and shared versus dedicated topology.
4. Configure administrators, identity, domain/brand, data import, and operating policies.
5. Verify tenant isolation, access, critical workflows, and customer acceptance.
6. Operate with support access and audit evidence; review adoption and expansion needs.

## Sales FAQ and objections

**Is this self-serve?** Not yet. Organization activation is manual through the platform control desk.

**Does DevFathom provide email mailboxes?** No. The roadmap supports connected Gmail, Outlook, and generic IMAP/SMTP inboxes.

**Is Meetings live?** The Wave-1 schema/reconciliation PR is merged and staging-verified. The self-hosted media service is not live, and `meet.devfathom.com` and `turn.devfathom.com` remain future endpoints.

**Is there a mobile app?** No native app is in current scope. The current product is web-only, with responsive browser behavior where implemented.

**Can you promise savings, compliance, or an SLA?** Not from repository evidence. Use an owner-approved contract or validated study.

**Where does it run?** AWS. Staging runs on AWS (see `docs/deploy/aws.md`); the AWS production environment is not created yet. Public custom domains are not attached: `www.devfathom.com` remains the GoDaddy marketing site and `admin.devfathom.com` is DNS-unconfigured. PR #33 hardening is merged to `main`; production is **NOT PUBLICLY CUT OVER**.
