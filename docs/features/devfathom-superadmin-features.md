# DevFathom: SuperAdmin and platform features, all verticals (technical)

Refreshed on **10 Nov 2026 (PKT)** from repo `RealDevFathom/devfathom-commercial`, branch **develop at `1906b53076286b2e1438eb821969c0d50e5575c6`** (committed 7 Nov 2026, 02:43 PKT). The previous edition used `47518cbf` (1 Nov). The full code inventory (pages, API routes, procedures, models) and the list of 378 open PRs are in the appendices of the business-features file, `devfathom-all-features.md`.

**Status key**
- **LIVE**: the code is on develop at `1906b530`. **LIVE does not mean QA passed it.** Known bugs are noted against the feature.
- **NEW**: merged since `47518cbf`.
- **OPEN PR #n**: in an unmerged open PR.
- **KNOWN BUG**: a defect in live code, with the PR that fixes it if one exists.
- **PLANNED**: only in plans or Linear, with no code.

**What changed since `47518cbf`**
- **New: AI settings and spend in the console** (#1238). There's a new `ai-settings` router and console panels on `/platform/settings`: AI mode, provider order, fallback, monthly caps, per-tier models, model prices, a monthly spend report and cap alerts (section 1.11).
- **Changed: pharmacy tenant creation** (#247). The bootstrap admin role gets `*` plus exact `pharmacy:safety`, and the first admin is assigned to the MAIN branch. Migrations backfill both for existing pharmacies.
- **Changed: module catalogue.** New procedure-to-module mappings: `pharmacySop` → `pharmacy-safety`, `pharmacyPackLabel` and `pharmacySupplierCompliance` → `pharmacy-procurement`, `pharmacyAccess` → `pharmacy-core`, and the `/pharmacy/sop` page → `pharmacy-safety`. A package without `pharmacy-safety` doesn't open pharmacy procedures.
- **Removed:** nothing.

**Read first**
- **SuperAdmin has no QA coverage.** **Cross-tenant isolation is untested** (QA has one tenant).
- **Production:** AI is off unless `AI_PROVIDER` is set, and production defaults to disabled. Ask Fathom 503 (DEV-583) and the expiry-advisor SQL were fixed in code by #1238, but not re-tested.
- Regulatory: the 2022 draft advertising rules and S.R.O. 1047(I)/2025 aren't verified, so this document doesn't cite them as settled.


## 1. Platform and SuperAdmin (all verticals: agency, restaurant, pharmacy, hotel)

The platform console is a separate app at `src/app/platform/(console)/*` with its own login. Write actions (except the AI settings in 1.11, which use the `ai-settings` tRPC router with platform read/write procedures) go through one command endpoint, `POST /api/platform/control` → `src/lib/platform/commands.ts` (65 command kinds). Reads are gated per page by `src/lib/platform/read-policy.ts`, and role capabilities live in `src/lib/platform/capabilities.ts`. Models: `PlatformUser, PlatformSession, PlatformRecoveryCode, PlatformSetting, PlatformModule, PlatformPackage, PlatformPackageModule, PlatformAccount, PlatformLead, PlatformContact, PlatformOpportunity, PlatformOpportunityStageEvent, PlatformProposal, PlatformFollowUp, PlatformContract, PlatformContractModule, PlatformInvoice, PlatformPayment, PlatformRenewal, PlatformJob, PlatformSupportSession, PlatformAuditLog, PlatformCameraBrandPreset`, plus the tenant-side `Organization*` models (16).

**Every row in this section is vertical-agnostic.** The same console creates and runs agency, restaurant, pharmacy and hotel tenants. Only three commands are vertical-specific: `organization.restaurant.setup`, `organization.pharmacy.placeholder.apply/lock` and `organization.hotelproperty.*`.

**Coverage warning: SuperAdmin has no QA coverage, and cross-tenant isolation has not been tested.** QA has a single tenant, so no one has tried reading tenant A's data from tenant B. Every row here is LIVE from code alone.

### 1.1 Operator access and roles
| Feature | Status | What it does, step by step / who / options / limits | Evidence |
|---|---|---|---|
| Operator sign-in | LIVE | (1) An operator opens `/platform/login` and enters email and password. (2) If MFA is on, they enter a 6-digit TOTP or a recovery code. (3) A platform session cookie is set, separate from tenant sessions. Repeated failures are rate-limited and return 429 "Too many sign-in attempts". **Who:** platform operators only; tenant users can't sign in here. | `platform/(auth)/login`; `api/platform/session`; `src/lib/platform/auth.ts`; `PlatformSession` |
| Operator MFA (TOTP + recovery codes) | LIVE | Enrolment happens at first sign-in. MFA is required for SUPER_ADMIN, OPERATIONS and SUPPORT, and enforced unless `PLATFORM_MFA_ENFORCE=false`. Recovery codes are hashed. QR-code enrolment UX is planned. | `api/platform/mfa`; `auth.ts:20,113`; `PlatformRecoveryCode` |
| Operator MFA reset | LIVE | A SuperAdmin resets a locked-out operator's MFA. The reset is audited. | command `operator.mfa.reset` |
| Operators screen: create, edit, deactivate | LIVE | Each operator gets one of six roles. **Guardrail:** the last active SUPER_ADMIN can't be deactivated or demoted. | `operators` page; `operator.upsert`; `commands.ts:4034-4062` |
| Operator roles | LIVE | **SUPER_ADMIN**: everything, plus tenant security writes. **OPERATIONS**: tenants, deployments and jobs (read and write), support sessions, catalogue read. **SALES**: CRM and commercial write, tenants read. **FINANCE**: commercial write, CRM read. **SUPPORT**: read tenants, deployments and jobs, and open support sessions. **AUDITOR**: read everything, including the audit ledger. | `capabilities.ts:3-40`; enum `PlatformRole` |
| Role-filtered console navigation | LIVE | The nav has 12 pages in 3 groups. Operations: Control room, Organizations, Deployments, Support sessions, Jobs, Health. Revenue: Sales CRM, Commercial, Modules & plans. Governance: Operators, Audit ledger, Platform settings. A page the role can't read redirects to that role's safe fallback page. | `read-policy.ts`; `page-access.ts` |
| Mutation origin check | LIVE | Every console write must come from the platform origin, which blocks CSRF. | `assertPlatformMutationOrigin` in `api/platform/*` |
| JWT cookie reissued on every read | KNOWN BUG, fix in PR #149 (Sev4) | | PR #149 |

### 1.2 Tenants (organizations): lifecycle
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Organizations list | LIVE | Lists every tenant with its vertical, status and package. | `organizations/page.tsx` |
| Create a tenant | LIVE | (1) From `/organizations/new`, choose a vertical (AGENCY, RESTAURANT, PHARMACY or HOSPITALITY), name, slug, timezone, currency and package. (2) The command creates the `Organization`, applies the package modules and limits, seeds that vertical's role templates and departments, and creates the first administrator. Slugs must be unique (db test). Timezones come from `timezones.ts`. A seat limit can be set only by SUPER_ADMIN. | `organization.create`; `commands.ts:976`; `commands.organization-create.test.ts` |
| Pharmacy bootstrap grants and MAIN assignment | LIVE **NEW** (#247) | When the vertical is PHARMACY, the bootstrap admin role is `*` plus exact `pharmacy:safety` (the wildcard never reaches exact-grant-only actions), and the first admin gets a `PharmacyBranchAssignment` to MAIN, so a solo pharmacy can file and review pharmacovigilance reports on day one. Migrations `20261101120000_pharmacy_owner_pv_safety` and `20261106120000_pharmacy_bootstrap_admin_branch_backfill` backfill existing tenants and keep explicit DENYs. | `src/lib/platform/commands.ts` bootstrapOrganization; `src/lib/vertical-catalog.ts` `PHARMACY_BOOTSTRAP_ADMIN_EXACT_GRANTS` |
| Edit a tenant | LIVE | Change the name, timezone, contact details and seat limit. | `organization.update` |
| Lifecycle states | LIVE | The states are PROSPECT, ONBOARDING, ACTIVE, GRACE, SUSPENDED, TERMINATED, PURGING and PURGED. An operator moves a tenant between them with `organization.transition`, and each change is written to `OrganizationLifecycleEvent`. | enum `OrganizationStatus`; `organization.transition` |
| Activation preflight (go-live gates) | LIVE | A tenant can't become ACTIVE until four gates pass: (1) a commercial package is set, (2) at least one module is enabled, (3) there is an active ADMIN user, (4) there is a READY production deployment. The org page shows each unmet gate with a link to fix it. Verticals add their own gates (pharmacy readiness, the hotel go-live checklist). | `src/lib/platform/activation-gates.ts`; `organizations/[id]/page.tsx` |
| Suspend / resume | LIVE | Runs as platform jobs SUSPEND and RESUME. | enum `PlatformJobType` |
| Data export | LIVE | An EXPORT_DATA job. | `jobs.ts` |
| Purge | LIVE | A PURGE_DATA job moves the tenant to PURGING, then PURGED. A db test covers it. | `jobs.purge.db.test.ts` |
| Usage counters | LIVE | `organization.usage` records or refreshes usage against limits. | `OrganizationUsageCounter` |
| Workspace requests (self-serve sign-up requests) | LIVE | A public `/api/workspace-requests` takes requests. Operators approve or reject them in `/api/platform/workspace-requests/[id]`. | routes + tests |
| Demo bootstrap | LIVE | Seeds demo tenants. There is also a separate restaurant demo cron. | `commands.demo-bootstrap.test.ts`; `api/cron/demo-restaurants`; `/demo/restaurants` |

### 1.3 Tenant identity, brand, domains, email, SSO, SCIM
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Brand (logo, colours, name) | LIVE | `organization.brand` sets the brand and queues an APPLY_BRAND job. Tenants preview it at `/brand/preview`. | `OrganizationBrand` |
| Custom domains | LIVE | Add, check status, retry verification, remove. CONFIGURE_DOMAIN runs as a job. | `organization.domain{,.status,.retry,.remove}`; `OrganizationDomain` |
| Outbound email settings | LIVE | Sets the tenant's sender name and address for system mail. | `organization.email`; `OrganizationEmailSettings` |
| SSO (OIDC and SAML) | LIVE | (1) Add an identity connection. (2) Test it with `organization.identity.test`. (3) Users sign in through `/api/auth/sso/oidc` or `/api/auth/sso/saml`. A SYNC_IDENTITY job syncs it. Only SUPER_ADMIN can do this (`organizations:security:write`). | `organization.identity{,.test,.remove}`; `OrganizationIdentityConnection`, `OrganizationSsoState`, `TenantSsoTicket` |
| SCIM provisioning | LIVE | (1) Issue a SCIM token, which is shown once. (2) The customer's IdP calls `/api/scim/v2/*` to create and deactivate users. Tokens can be revoked. Events are logged. | `organization.scim.token/.revoke`; `OrganizationScimToken`, `OrganizationScimEvent` |

### 1.4 Users, roles and permissions inside a tenant (operator side)
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Create or edit a tenant user; set their password | LIVE | Used for the first admin and for support fixes. The administrator's staff profile is created automatically (test). | `organization.user`, `organization.user.password`; `commands.administrator-staff-profile.test.ts` |
| Tenant roles | LIVE | Create, edit or remove a role. Each vertical's role templates are seeded on creation: AGENCY admin and member; the PHARMACY set; the HOSPITALITY set; the RESTAURANT set and restaurant job roles. | `organization.role{,.remove}`; `vertical-catalog.ts:729,766,885,1012,1268`; `OrganizationRole` |
| Per-role permission grants and denials | LIVE | | `organization.permission{,.remove}`; `OrganizationRolePermission`; `src/lib/abac/*` |

### 1.5 Plans, modules, limits and billing (catalogue admin)
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Module catalogue | LIVE | Create or edit modules. **AGENCY:** agency-core (mandatory), projects, clients, finance. **RESTAURANT:** restaurant-core, pos, menu, inventory, purchasing, workforce, sop, loyalty, insights, integrations. **PHARMACY:** pharmacy-core (mandatory), counter, inventory, procurement, dispensing, safety, finance, reports, crm. **HOSPITALITY:** hotel-core (mandatory), reservations, front-desk, folio, payments, night-audit, reports, channels, upsell, marketing, agents, maintenance, api, crs, banquets. | `catalog` page; `catalog.module.upsert`; `vertical-catalog.ts:466,495`; `PlatformModule` |
| Package catalogue | LIVE | Create or edit a package and its module list, using `catalog.package.upsert` and `catalog.package.module`. Packages inherit modules live, so a change flows to every tenant on that package (db test). | `PlatformPackage(Module)`; `package-inheritance.db.test.ts` |
| Restaurant packages | LIVE | **Essentials:** 1 location, 1 brand, 2 terminals, 4 devices, 5,000 orders a month, 2 registers, 10 operators, 1 stock location, SOP evidence kept 90 days. **Operations:** 5 locations, 3 brands, 10 terminals, 25 devices, 50,000 orders a month, 100 operators, 10 stock locations, 365-day evidence, 25,000 loyalty customers, 10 integrations, 24 months of insights. **Enterprise:** 100 locations, 25 brands, 250 terminals, 1,000 devices, 1M orders a month, 2,500 operators, 250 stock locations, 1,095-day evidence, 1M loyalty customers, 100 integrations, 60 months of insights. All three share an SOP template guardrail of 1,000. | `vertical-catalog.ts` |
| Pharmacy packages | LIVE | **Essentials:** 1 branch, 2 counters, 10 users. **Professional:** 5 branches, 10 counters, 50 users. **Chain:** every module, 100 branches, 500 counters, 2,500 users. | `PHARMACY_PACKAGES` |
| Hotel packages | LIVE (only core is built) | **Essentials:** 1 property, 50 rooms, 15 users. **Pro:** 3 properties, 250 rooms, 75 users. **Chain:** 100 properties, 10,000 rooms, 2,500 users. **Venue:** 1 property, 0 rooms, 25 users. | `HOSPITALITY_PACKAGES` |
| Agency plans | LIVE | Seat-based only. `AGENCY_LIMIT_KEYS` is empty. | |
| Per-tenant module switches | LIVE | Turn a module on or off for one tenant, or reset it to the package default. The tenant sidebar and routers respect the switch (`isModuleGranted`). | `organization.module{,.reset}`; `OrganizationModule`; `sidebar.tsx` |
| Per-tenant limit overrides | LIVE | Set or remove a limit (for example `pharmacy.branches.max` or `hotel.rooms.max`). If a limit is missing or invalid, it counts as 0, never as unlimited. | `organization.limit{,.remove}`; `OrganizationLimit` |
| Camera brand presets | LIVE | A catalogue of camera vendor presets (RTSP paths and so on) used by restaurant and pharmacy cameras. | `catalog.camerapreset{,.remove}`; `PlatformCameraBrandPreset` |
| AI credits / WhatsApp limit per tenant | PLANNED | No limit keys exist. | ask-fathom-plan.md |
| AI provider switch in SuperAdmin | PLANNED (DEV-576) | | |
| Commercial: contracts | LIVE | (1) Create a contract for a tenant with its modules (`PlatformContractModule`). (2) Change its status. The contract's modules become the tenant's entitlements (test). | `commercial.contract.create/.status`; `commands.contract-entitlements.test.ts` |
| Commercial: invoices and payments | LIVE | Raise a platform invoice, change its status, and record a payment by hand. There is no online gateway. | `commercial.invoice.*`, `commercial.payment.record` |
| Commercial: renewals | LIVE | | `commercial.renewal.create/.status` |

### 1.6 Sales CRM
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Leads | LIVE | Create a lead and update its status. | `crm.lead.*` |
| Accounts and contacts | LIVE | | `crm.account.create`, `crm.contact.create` |
| Opportunities | LIVE | Pipeline stages, with a history of each stage change. | `crm.opportunity.create/.stage`; `PlatformOpportunityStageEvent` |
| Convert an opportunity into a tenant | LIVE | A won deal creates the organization, then the contract. | `crm.opportunity.convert`; test |
| Proposals and follow-ups | LIVE | | `crm.proposal.*`, `crm.followup.*` |

### 1.7 Deployments, jobs, health, settings
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Deployments | LIVE | Shared or dedicated deployments (Vercel target), with status PROVISIONING, READY, DEGRADED and so on. An operator can create, update, or attach a tenant to the shared deployment. | `deployments` page; `deployment.create/.update`, `organization.deployment.shared`; `OrganizationDeployment` |
| Job queue | LIVE | Job types: PROVISION_SHARED, PROVISION_DEDICATED, CONFIGURE_DOMAIN, APPLY_BRAND, SYNC_IDENTITY, EXPORT_DATA, PURGE_DATA, SUSPEND, RESUME, pharmacy.camera.snapshot.v1, camera.evidence.retention.v1. Operators can create, retry or cancel jobs. | `jobs` page; `job.*`; `src/lib/platform/jobs.ts`; `PlatformJob` |
| Job worker cron | LIVE | `vercel.json` runs `/api/platform/jobs/process` every 5 minutes. **This is the only scheduled cron in `vercel.json`.** | `vercel.json` |
| Outbound-effects drain | LIVE (scheduling unclear) | `/api/cron/outbound-effects` drains each tenant's outbox. Its comment says "every minute", but it isn't in `vercel.json`, so it needs an external scheduler. | `src/lib/side-effects/drain.ts`; `OutboundEffect` |
| Health page | LIVE | Platform health overview. | `health` page; `platform-health.overview`; `/api/health`, `/api/ready`, `/api/live` |
| Control room (overview) | LIVE | | `platform/(console)/page.tsx` |
| Platform settings | LIVE | Key/value settings. | `setting.upsert`; `PlatformSetting` |
| Sanitised command errors; provisioning validation; logo link name | OPEN PR #1066, #1174, #1175 | | |
| Job types added | LIVE **NEW** | The pharmacy SOP auto-schedule parent and per-branch child jobs run on the existing job queue. | `src/lib/pharmacy/sop-auto-schedule-job.ts`; `src/lib/restaurant/job-handlers.ts` |

### 1.8 Support sessions
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Open a support session in a tenant | LIVE | (1) An operator with `support:write` (SUPER_ADMIN, OPERATIONS or SUPPORT) picks a tenant, optionally a tenant user, a reason (10-500 characters) and a duration (5-60 minutes). (2) The platform host gives them a one-use launch link, which redirects to the tenant host with a support cookie. (3) The session expires automatically or can be ended early with an end reason. Both platform and tenant audit logs record it. | `support` page; `api/platform/support`; `api/support-session`; `src/lib/tenancy/support-session.ts`; `PlatformSupportSession` |
| **Checked in code (2 Nov 2026): it is impersonation of a tenant administrator** | | `createSupportSession` resolves the target user and refuses unless that user is `role === 'ADMIN'` and ACTIVE/ON_LEAVE. When no user is given, it uses the oldest active admin. `tenant-actor.ts` then builds a full tenant session as that admin (`isSupportSession: true`, `platformUserId`, `supportReason`). The support cookie takes precedence over any tenant JWT and is ignored on the shared host. **There is no read-only mode: the operator has every permission that admin has, writes included.** Mitigations: one active session per operator per tenant (older ones are ended); session start is written to `platformAuditLog`; tenant audit rows carry `supportSessionId`; every tenant ADMIN gets an in-app notification in the same transaction, and if that notification can't be saved, access is not granted; a banner shows in `app-shell.tsx`; the tenant must be ONBOARDING, ACTIVE or GRACE. Untested across tenants (no QA). | `src/lib/tenancy/support-session.ts`; `src/lib/tenancy/tenant-actor.ts`; `src/server/audit.ts` |

### 1.9 Audit
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Platform audit ledger | LIVE | Every console command, including failed ones (test), with secrets redacted (test). Only AUDITOR and SUPER_ADMIN can read it. | `audit` page; `PlatformAuditLog`; `commands.failure-audit.test.ts`; `audit-secret-redaction.test.ts` |
| Tenant audit logs are not append-only | KNOWN BUG, fix in PR #171 (Sev3) | Tenants can UPDATE or DELETE their own audit rows. | PR #171 |

### 1.10 Vertical setup from the console
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| Restaurant setup | LIVE | Sets up a restaurant tenant's first branch, brand and defaults. | `organization.restaurant.setup` |
| Pharmacy readiness gates and placeholder apply/lock | LIVE | | `organization.pharmacy.placeholder.apply/.lock`; org detail page |
| Hotel property deactivate, reactivate, recover | LIVE | | `organization.hotelproperty.*`; `src/lib/platform/hotel-property-maintenance.ts` |
| Register, update or remove tenant cameras | LIVE | | `organization.camera.*` |
| Agency setup | LIVE (no special command) | Agency uses the generic create command. | |


### 1.11 AI settings and spend (Ask Fathom and every AI feature) — NEW
| Feature | Status | Detail | Evidence |
|---|---|---|---|
| AI mode switch | LIVE **NEW** | Auto (routed chain), Force Anthropic, Force OpenAI, Force Bedrock, or **Disabled**. Disabled also stops the weekly owner summary. Environment `AI_PROVIDER` must also be set for AI to run at all. | `ai-settings.get/setMode` (`platformReadProcedure`/`platformWriteProcedure`); enum `AISettingsMode`; `AISetting`; `src/components/platform/ai-settings-console.tsx` on `/platform/settings` |
| Provider order and fallback | LIVE **NEW** | Default order Anthropic → OpenAI → Bedrock. Fallback can be turned off so only the first provider is tried. Failover happens on availability errors only. Azure is never in this list; it remains only as a legacy, explicit-only selector. Saad ordered Azure removed from all code on 10 Nov 2026; planned for the next Codex batch (DEV-755 / #1437). | `ai-settings.setProviderOrder/setFallbackEnabled`; `src/lib/ai/router.ts` `candidateChain` |
| Monthly spend caps per provider | LIVE **NEW** | Defaults: Anthropic $190, OpenAI $190, Bedrock $300 per Asia/Karachi calendar month. Enforcement compares unrounded amounts. | `ai-settings.setMonthlyCap`; `src/lib/ai/model-defaults.ts` `DEFAULT_MONTHLY_CAPS_USD`; `src/lib/ai/spend.ts` |
| Per-tier model overrides | LIVE **NEW** | Pick the model for each tier (cheap, standard, deep) per provider; `reset` returns to the defaults. | `ai-settings.setTierModel/reset`; `DEFAULT_MODELS` |
| Model price table | LIVE **NEW** | List prices per million tokens are built in; a SuperAdmin price row overrides them. | `ai-settings.listModelPrices/upsertModelPrice`; `AIModelPrice` |
| Monthly AI spend report | LIVE **NEW** | Spend by provider for the current Karachi month, SUPER_ADMIN only. **Note:** the tRPC procedure is `publicProcedure`; the SUPER_ADMIN check is inside `readMonthlyAIUsage()` (CTO to confirm this is intended). | `platform-ai-usage.currentMonth`; `src/lib/ai/usage.ts`; `src/components/platform/ai-usage-panel.tsx`; `AIProviderUsage` |
| Cap alerts to SuperAdmins | LIVE **NEW** | Once per provider per month at 80% ("near cap") and once at 100% ("cap reached"), as console notifications. Alerts never fail an AI call. | `src/lib/ai/usage.ts` `maybeCreateAIBudgetAlert`; `AIBudgetAlertMonth`, `PlatformNotification` |
| Per-pharmacy AI credits and WhatsApp allowances set from the console | PLANNED | Saad's decision. No per-organization credit or WhatsApp limit key exists yet. | |

## Vertical setup rows moved from the business-feature files

| Feature | Status | Evidence |
|---|---|---|
| WhatsApp limit of 5,000 a month per pharmacy, set by SuperAdmin | PLANNED | `/workspace/plan/ask-fathom-plan.md`. Rechecked 10 Nov: there is still no limit key in `PHARMACY_LIMIT_KEYS` |
| Activation blocked until checklist done | LIVE | SuperAdmin activation of a hotel org refuses while any checklist step is open. [src/lib/platform/commands.ts evaluateHotelReadiness] |
| Hotel org created with first property | LIVE | When SuperAdmin creates a hotel org, it gets a first property, a manager assignment and default meal plans. [src/lib/platform/commands.ts hotelProperty.create] |
| Hotel org template and staging seed | OPEN PR #964 (salvage; hotel build paused) | SuperAdmin hotel template and demo data with hotel roles. Work exists only on a local, unreviewed branch and hotel building is paused (Saad, 22 Oct 15:28 PKT). Nothing is on develop or in an open PR. [/workspace/plan/hotel-build-plan.md M8 fix/hotel-template-seed] |
