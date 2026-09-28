# Super Admin console: information architecture

Status: proposed, for board review (WHA-1583) · Baseline: `13af3d1e` · Owner: UX consultant
Implements: SA-UX-1..11 (see `09-ux02-acceptance-criteria.md`)
Inputs: SA-AUDIT-01 gap analysis (WHA-1578, comment `3791efc2`, backlog SA-01..SA-12) and the
principles in `05-super-admin-principles.md`. This document is the **IA and screen map**. `05` is
the interaction rulebook (friction levels, words not enums, danger zones) and still applies to
every screen here.

## 0. Target and what exists

The target is one console that runs agencies, pharmacies and restaurants: tenant list,
entitlements per module, users and roles, billing, audit log, health, impersonate-with-audit,
feature flags, announcements.

The console already exists at `src/app/platform/(console)/*`, on host `admin.<base>`
(`src/lib/tenancy/host-routing.ts:103`). It uses its own `PlatformUser` identity with six roles
(`src/lib/platform/capabilities.ts:3-40`). Every write goes through `POST /api/platform/control` →
`executePlatformCommand` and writes one `PlatformAuditLog` row.

| Capability             | Today (SA-AUDIT-01)                                                                                  | IA home in this spec                                     | Backlog      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| Tenant list            | Partial. `organizations/page.tsx`; **no vertical column or filter**                                  | Tenants (§3.2)                                           | SA-01        |
| Entitlements           | Exists. Org detail modules/limits + `catalog/page.tsx`                                               | Tenant → Modules & limits (§3.4); Plans & modules (§3.6) | —            |
| Users & roles          | Partial. Org "People" section; `operators/page.tsx`; no cross-tenant search                          | Tenant → People (§3.5); People directory (§3.7)          | SA-03, SA-12 |
| Billing                | Partial. `commercial/page.tsx`; manual GRACE/SUSPENDED                                               | Billing (§3.8); Tenant → Billing                         | SA-11        |
| Audit log              | Partial. `audit/page.tsx`, 500-row cap, free text only, **not append-only**                          | Audit log (§3.10); Tenant → Activity                     | SA-04        |
| Health                 | Partial. `jobs/page.tsx`, `/api/health`; no heartbeat, no integration health                         | Health (§3.9)                                            | SA-08        |
| Impersonate with audit | Exists, needs hardening. `SupportAccessForm`, tenant banner; no global session list, any target role | Support sessions (§3.11)                                 | SA-07        |
| Feature flags          | **Missing**                                                                                          | Feature flags (§3.12)                                    | SA-09        |
| Announcements          | **Missing**                                                                                          | Announcements (§3.13)                                    | SA-10        |

The security items in SA-AUDIT-01 (SA-04 append-only ledger, SA-05 sensitive-command hardening,
SA-06 MFA, SA-07 support-session hardening) are **preconditions** for several screens here. The
UI must not promise what the server doesn't enforce. For example, the audit page must not say
"immutable" until SA-04 lands (it does today, `organizations/[id]/page.tsx:548`, `:562`, `:1931`).

---

## 1. Design stance

- **Certainty over speed** (`05`). Every screen answers: _which tenant, which vertical, what
  changes, who did it, can it be undone._
- **One console, three verticals, one grammar.** The vertical is a **filter and a label**, never
  a separate app. Every list that holds tenants or tenant data can be scoped to a vertical with
  the same control, and every tenant reference shows its vertical chip.
- **Tenant-centred.** Most work starts from a tenant. Cross-tenant pages (Health, Audit, People
  directory, Support sessions) always link back to the tenant page, and the tenant page shows a
  filtered slice of each of them.
- **Role-shaped.** Nav items the operator can't read are **hidden**, not disabled (today's
  behaviour, `read-policy.ts`). Actions the operator can't perform on a readable page are
  **shown disabled with the role that can**, e.g. _"Needs Super admin"_. That tells the support
  agent whom to ask.

---

## 2. Global frame

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ [F] Fathom Platform · PRODUCTION   [All ▾ Agency Pharmacy Restaurant]   ⌘K Search… │
│                                            ● 2 support sessions   Zara M. · Ops ▾   │
├──────────────┬──────────────────────────────────────────────────────────────────────┤
│ Home         │  (identity bar when inside a tenant)                                 │
│              │  Chai Chowk · Restaurant · Active · Shared cloud · org_7Hq2…  [Copy] │
│ TENANTS      │  ─────────────────────────────────────────────────────────────────── │
│  Tenants     │  Overview · Modules & limits · People · Access · Deployment ·        │
│  People      │  Billing · Activity                                                  │
│  Support     │                                                                      │
│              │                                                                      │
│ PRODUCT      │                                                                      │
│  Plans & mod │                                                                      │
│  Feature fl. │                                                                      │
│  Announcem.  │                                                                      │
│              │                                                                      │
│ REVENUE      │                                                                      │
│  Billing     │                                                                      │
│  Sales CRM   │                                                                      │
│              │                                                                      │
│ OPERATIONS   │                                                                      │
│  Health      │                                                                      │
│  Jobs        │                                                                      │
│  Deployments │                                                                      │
│              │                                                                      │
│ GOVERNANCE   │                                                                      │
│  Audit log   │                                                                      │
│  Operators   │                                                                      │
│  Settings    │                                                                      │
└──────────────┴──────────────────────────────────────────────────────────────────────┘
```

### 2.1 Top bar

- **Environment label**: `PRODUCTION` in a danger-toned pill, `STAGING` in warning, `LOCAL` in
  neutral. It's always visible so no one mutates production thinking it's staging.
- **Vertical scope** (segmented control: `All · Agency · Pharmacy · Restaurant`). It's stored in
  the URL (`?vertical=pharmacy`) so views are shareable, and it persists across pages in session
  storage. It filters Home, Tenants, People, Health, Audit, Billing, Support, Flags and
  Announcements. When a scope is active, a chip under the page title says `Pharmacy only ×`.
  Inside a tenant, the control is replaced by the tenant's own vertical (read-only).
- **Command palette** (`⌘K` / `Ctrl+K`): one box that finds
  - tenants by name, slug or short ID
  - tenant users by exact email (SA-12; audited query)
  - pages ("Feature flags")
  - actions in context ("Suspend Chai Chowk…" opens the review dialog; it never runs directly)
- **Active support sessions**: a live count, linking to §3.11. It's hidden at 0.
- **Operator menu**: name, role in words (`Operations`, not `OPERATIONS`), MFA status, sign out.

### 2.2 Navigation (replaces `read-policy.ts:6-56`)

Five groups in plain words. There are no number prefixes and no "Runbook /" eyebrow (`05` §9).
The 9px labels become 11px (`platform-shell.tsx:75`).

| Group      | Item             | Route                     | Read capability            | New?                         |
| ---------- | ---------------- | ------------------------- | -------------------------- | ---------------------------- |
| —          | Home             | `/platform`               | `platform:overview:read`   | Renamed from Control room    |
| Tenants    | Tenants          | `/platform/organizations` | `organizations:read`       | Renamed                      |
| Tenants    | People           | `/platform/people`        | `organizations:read`       | **New** (SA-12)              |
| Tenants    | Support sessions | `/platform/support`       | `support:read` (new)       | **New** (SA-07)              |
| Product    | Plans & modules  | `/platform/catalog`       | `catalog:read`             | Renamed from Modules & plans |
| Product    | Feature flags    | `/platform/flags`         | `flags:read` (new)         | **New** (SA-09)              |
| Product    | Announcements    | `/platform/announcements` | `announcements:read` (new) | **New** (SA-10)              |
| Revenue    | Billing          | `/platform/commercial`    | `commercial:read`          | Renamed from Commercial      |
| Revenue    | Sales CRM        | `/platform/crm`           | `crm:read`                 | —                            |
| Operations | Health           | `/platform/health`        | `health:read` (new)        | **New** (SA-08)              |
| Operations | Jobs             | `/platform/jobs`          | `jobs:read`                | —                            |
| Operations | Deployments      | `/platform/deployments`   | `deployments:read`         | —                            |
| Governance | Audit log        | `/platform/audit`         | `audit:read`               | Renamed from Audit ledger    |
| Governance | Operators        | `/platform/operators`     | `operators:read`           | —                            |
| Governance | Settings         | `/platform/settings`      | `settings:read`            | —                            |

Routes keep their current paths so bookmarks and `page-access.ts` rules stay valid; only labels
and grouping change.

### 2.3 Role visibility (read)

`●` = sees the page. `○` = sees a tenant-filtered or redacted version. Blank = hidden.

| Page             | Super admin | Operations |  Sales   | Finance | Support  |        Auditor        |
| ---------------- | :---------: | :--------: | :------: | :-----: | :------: | :-------------------: |
| Home             |      ●      |     ●      |    ●     |    ●    |    ●     |           ●           |
| Tenants          |      ●      |     ●      |    ●     |    ●    |    ●     |           ●           |
| People           |      ●      |     ●      |          |         |    ●     | ○ (no contact fields) |
| Support sessions |      ●      |     ●      |          |         |    ●     |           ●           |
| Plans & modules  |      ●      |     ●      |    ●     |    ●    |    ●     |           ●           |
| Feature flags    |      ●      |     ●      |          |         | ○ (read) |           ●           |
| Announcements    |      ●      |     ●      | ○ (read) |         |    ●     |           ●           |
| Billing          |      ●      |            |    ●     |    ●    |          |           ●           |
| Sales CRM        |      ●      |            |    ●     |    ●    |          |           ●           |
| Health           |      ●      |     ●      |          |         |    ●     |           ●           |
| Jobs             |      ●      |     ●      |          |         |    ●     |           ●           |
| Deployments      |      ●      |     ●      |          |         |    ●     |           ●           |
| Audit log        |      ●      |            |          |         |          |           ●           |
| Operators        |      ●      |            |          |         |          |                       |
| Settings         |      ●      |            |          |         |          |                       |

New capabilities (`support:read`, `flags:read/write`, `announcements:read/write`, `health:read`,
and the `organizations:security:write` split from SA-05) are added to
`PLATFORM_ROLE_CAPABILITIES`. The matrix above is the proposal; owner decision **D-S1** confirms
it.

---

## 3. Screens

### 3.1 Home

Replaces "Control room / live ledger · Platform position".

- **Vertical tiles** (three cards, one per vertical, plus `All` when unscoped): active tenants,
  in trial, in grace, suspended; contracted monthly value. Tapping a figure opens Tenants with that
  filter.
- **Needs attention** (one list, most urgent first). Every row is a sentence with a link:
  - _3 tenants in grace period · oldest 12 days_ → Billing, filtered
  - _Job queue: 14 failed in 24h · oldest waiting 2h_ → Health
  - _Print bridge offline at 2 restaurants_ → Health, integrations
  - _2 support sessions active · one ends in 4 min_ → Support sessions
  - _Pharmacy reference data 3 days old at 5 tenants_ → Health
  - _Renewals due in 14 days: 6_ → Billing
- **Recent activity**: the last 10 audit sentences (`05` §6 format), with **View audit log**.
- No marketing metrics ("Open pipeline") on Home for roles without `crm:read`.

### 3.2 Tenants (list)

The list is the most used screen. It's a table that scrolls inside its container (contract §6).

| Column           | Content                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| Tenant           | Display name + slug (muted). Tap opens the tenant                                                            |
| Vertical         | Chip: `Agency` / `Pharmacy` / `Restaurant` (neutral tone; the vertical is not a state)                       |
| Status           | Lifecycle pill in words: Trial, Active, Grace, Suspended, Terminated                                         |
| Plan             | Package name + module count (`Growth · 9 modules`)                                                           |
| Branches / seats | `3 branches · 41 users` (vertical-appropriate noun: branches, outlets, workspaces)                           |
| Health           | Worst integration state: `OK` / `Degraded` / `Down`, with the reason on hover and in text for screen readers |
| Billing          | `Paid` / `Due in 5 d` / `Overdue 12 d`                                                                       |
| Last active      | Relative time                                                                                                |

- **Filters** apply as you choose them, with no Apply button (`05` §8): vertical (also driven by
  the top bar), status, plan, health, billing state, region, deployment mode, created date.
- **Saved views**: `Grace period`, `Suspended`, `Trials ending this week`, `Health issues`, plus
  personal ones. Stored per operator.
- Pagination by cursor, 50 per page. The `take 250` cap goes away.
- **+ New tenant** opens the six-step stepper from `05` §5, whose first step is **vertical**
  (Agency / Pharmacy / Restaurant). That choice drives the module defaults, the department list
  (SA-03) and the readiness checklist (SA-02).
- No bulk actions in v1. Suspending or changing many tenants at once is a disruptive action with
  a large blast radius; it goes through a job with a review screen if it's ever needed.

### 3.3 Tenant (detail)

The identity bar from `05` §1 is pinned on every tab. The 13 anchor links
(`organizations/[id]/page.tsx:335-362`) become seven real tabs, each with its own URL
(`/platform/organizations/{id}/modules`), so the operator can link a colleague to the exact view.

| Tab                  | Holds (today's anchors → new home)                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Overview**         | Profile, Brand; readiness checklist per vertical (SA-02); key figures (branches, users, last activity); health summary; active announcements for this tenant |
| **Modules & limits** | Modules, Limits (§3.4)                                                                                                                                       |
| **People**           | People (§3.5)                                                                                                                                                |
| **Access**           | Identity (SSO), SCIM, Domains, Email                                                                                                                         |
| **Deployment**       | Deployment; feature-flag overrides for this tenant (§3.12)                                                                                                   |
| **Billing**          | Commercial (contract, invoices, payments, renewal)                                                                                                           |
| **Activity**         | Audit (filtered to this tenant), Lifecycle history, support sessions for this tenant, and the **Danger zone** (suspend, terminate, purge) at the bottom      |

`05` has five tabs; this adds **People** and **Billing** as tabs because the brief lists both as
top-level capabilities and they are the two most visited sections after Modules.

The **Danger zone** sits at the bottom of Activity, behind a divider, with destructive-variant
buttons named with verbs (`Suspend Chai Chowk`). Each uses the friction level in `05` §2.

### 3.4 Entitlements (tenant → Modules & limits)

Today, resolution runs package → contract → override (`organizations/[id]/page.tsx:243`). The
screen shows that resolution rather than hiding it.

```
Module                  Source            State        Limit                 Usage
─────────────────────── ───────────────── ──────────── ───────────────────── ─────────────────
Restaurant POS          Package: Growth   ● On         Terminals 4           ▓▓▓░ 3 / 4
Kitchen display         Package: Growth   ● On         Screens 2             ▓▓░░ 1 / 2
Delivery                Override ↺        ○ Off        —                     —
Pharmacy counter        Not available for Restaurant tenants (hidden unless "Show all")
```

- Rows are grouped: **Core** (all verticals) then the tenant's **vertical modules**. Modules of
  other verticals are hidden, with a "Show modules for other verticals" toggle that shows them
  disabled with the reason (the server's `verticalForModuleKey` guard).
- **Source** column: `Package: Growth`, `Contract #C-219`, or `Override` with a **↺ Reset to
  plan** action (`organization.module.reset`).
- **State** toggle. Turning **on** is reversible: one click, Undo toast, audit entry. Turning
  **off** is disruptive: a review dialog that states the consequence (_"3 terminals stop taking
  orders at the next sync"_) and asks for a reason. Today it's one click with a hard-coded reason
  (`organizations/[id]/page.tsx:782-809`).
- **Limits** edit inline with a stepper. Lowering a limit below current usage shows the
  consequence (_"4 in use; the 5th and later can't be added. Nothing is removed."_).
- **Usage** is shown as a bar with the number. Manual usage counters (`organization.usage`) are
  labelled `Set manually · {date}`.
- A **Plan comparison** link opens the package's module list side by side with this tenant's, so
  a salesperson can see what an upgrade adds.

### 3.5 Tenant → People

- A table: name, email, role, department (vertical-aware after SA-03), status, MFA, last active.
- Row actions, by friction level:
  - Change role, deactivate: disruptive (review + reason).
  - **Reset password** is replaced by **Send password reset link**. The operator never sees or
    types a tenant user's password (`05` §5). Needs `organizations:security:write` (SA-05) and a
    reason.
  - **Start support session as this user** (§3.11). Enabled for tenant admins; for other roles it
    needs Super admin (SA-07).

### 3.6 Plans & modules (catalog)

- Two tabs: **Plans** (packages) and **Modules**.
- Plans: one card per package with a vertical chip, price, module list and tenant count. Editing
  a plan that has tenants shows _"Changes apply to 42 tenants at their next renewal"_ or _"now"_,
  per the catalog rule.
- Modules: key, name, vertical, which plans include it, and how many tenants have it on.

### 3.7 People directory (cross-tenant, SA-12)

- Exact-email search first (privacy: no browsing all users across tenants). Results show tenant +
  vertical chip, role, status, last active. Tapping opens the tenant's People tab with the user
  highlighted.
- Every search is audited (`people.lookup`, with the query hashed).
- A second tab **Operators** links to Governance → Operators for platform staff. It isn't
  duplicated.

### 3.8 Billing

- Tabs: **Overview** (MRR by vertical, overdue total, renewals due), **Invoices**, **Payments**,
  **Contracts**, **Renewals**.
- **Dunning state** per tenant: `Paid` → `Overdue` → `Grace` → `Suspended`, with the date of the
  next automatic step when SA-11 automates it. Until then the column reads `Manual` and the next
  step is a button (a disruptive action with review).
- Moving a tenant to Suspended for non-payment always shows the consequence and a reason, and
  sends the tenant an announcement (§3.13) when D-S4 allows it.

### 3.9 Health (SA-08)

Three sections, each a table with a status column in words and tone:

1. **Platform**: web (from `/api/health`, `/api/ready`), database, job worker **heartbeat**
   (`Last run 40 s ago` / `No run for 12 min` in danger), queue age, failed jobs in 24 h.
2. **Integrations across tenants**: one row per integration type, with counts
   (`OK 118 · Degraded 3 · Down 2`). Expanding a row lists the tenants affected. Types: custom
   domains, SSO, SCIM, email, restaurant print bridge, restaurant devices, webhooks, pharmacy
   reference data connector, payment adapter (per vertical), fiscal (FBR/PRA) submission once it
   exists.
3. **Terminals** (restaurant POS/KDS, pharmacy counters): devices online, devices offline >15 min,
   devices with offline queues older than 1 h, revoked devices. It uses the connection states
   from `08` so the words match what cashiers see.

Every red row links to a runbook note and to the tenant(s). Health is read-only; fixes happen on
the tenant or job pages.

### 3.10 Audit log (SA-04)

- One row per event, written as a **sentence**: _"Zara M. (Operations) turned off Delivery for
  Chai Chowk — reason: contract ended · 28 Sep 14:02"_. Actor and target are names, with IDs
  behind copy buttons.
- Filters: tenant, vertical, actor, action group (Lifecycle, Modules, People, Access, Billing,
  Support, Flags, Announcements, Settings), outcome (Success / Denied / Failed), date range.
- Cursor pagination instead of the 500-row cap (`audit/page.tsx:32`). **Export CSV** for the
  current filter (`audit:read`), which is itself audited.
- A row opens a **detail drawer**: raw action code, before/after values, request ID, IP, and the
  support session ID when relevant.
- **Denied** attempts are shown (the command path already audits failures). They're how an
  auditor spots probing.
- The word "immutable" appears only after SA-04's append-only trigger ships and its DB test
  passes.

### 3.11 Support sessions: impersonate with audit (SA-07)

**Start** (from Tenant → People → a user row, or ⌘K "Support session for…"):

1. **Who**: the target user (tenant admins are listed first; other roles need Super admin,
   SA-07).
2. **Why**: a reason of 10–500 characters (today's rule), plus a ticket reference field.
3. **How long**: 15 / 30 / 60 minutes (today's options).
4. **Mode**: **Read-only** (default, once SA-07 adds it) or **Can make changes** (needs a
   second confirm: _"Changes you make are recorded as you, on behalf of {user}"_).
5. **Review → Start session** opens the tenant app in a new tab via the one-use launch ticket.

**While active:**

- The tenant app shows the existing banner (`components/layout/app-shell.tsx:218-224`) with a live
  countdown, the operator's name, the mode, and **End now**.
- The console top bar shows the session count (§2.1). The operator's own sessions are listed
  first on the Support sessions page.
- Tenant admins are notified (in-app announcement to that tenant's admins, and email when D-S2
  allows it): _"Fathom support (Zara M.) is viewing your account until 14:32. Reason: …"_.

**Support sessions page:**

- Active sessions: operator, tenant + vertical, target user, mode, started, **time left**, reason,
  **End session** (force-end, `support:write`, audited, invalidates the tenant cookie on the next
  request).
- History: the same columns plus how it ended (`Expired` / `Ended by operator` / `Ended by
tenant` / `Force-ended by {name}`), and a link to the tenant-side audit entries made during it.

### 3.12 Feature flags (SA-09)

Flags control **release**; modules control **what's paid for**. The page says so in its
description, so no one uses a flag to give away a module.

- **List**: key, name, description, owner, **default** (On/Off), **rollout** (`Off`, `On for 3
tenants`, `Pharmacy only`, `On for all`), last changed, and an age warning for flags on for all
  for >90 days (_"Ready to remove from code"_).
- **Flag detail**:
  - Default state.
  - **Targeting**, evaluated top to bottom, the first match wins: per-tenant overrides, then
    per-vertical rules, then default. The UI shows the rule order explicitly.
  - An **evaluation preview**: pick a tenant and see the result and which rule decided it.
  - **Kill switch**: one button that sets every rule to Off. It's a disruptive action (review +
    reason) and is audited.
- Changing a flag that affects more than one tenant shows the count first (_"Turns on for 118
  pharmacy tenants"_).
- Tenant → Deployment shows that tenant's effective flags, read-only, with a link to each flag.

### 3.13 Announcements (SA-10)

- **Composer**: title (≤80 chars), body (≤280, plain text + one link), **severity** (`Info`,
  `Maintenance`, `Incident`), **audience** (All tenants / a vertical / chosen tenants / tenant
  admins only), **where** (Back office, Terminals, or both), **window** (start, end; default end
  = start + 24 h), dismissible (Info only; Maintenance and Incident can't be dismissed while
  active).
- A **live preview** of the tenant banner and the terminal banner side by side, in light and dark.
- **Review → Schedule** shows the audience count: _"Shows to 41 pharmacy tenants, 212 users, 63
  counters"_.
- **List**: Scheduled, Active, Ended, with the ability to end an active one early (audited).
- **Tenant side**:
  - Back office: a banner under the top bar in the app shell. Info = info tone, Maintenance =
    warning, Incident = danger. The dismiss state is stored per user.
  - Terminals (POS, KDS, counter): only Maintenance and Incident appear, in the 36px banner row
    from `08`, **below** any connection banner (connection state always wins, because it changes
    what the cashier can do). The text is truncated to one line, with **More** opening a sheet.

---

## 4. Friction map for console actions

Every write uses the three levels in `05` §2.

| Action                                                             | Level        | Extra                                            |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------ |
| Turn a module on, raise a limit, edit profile/brand                | Reversible   | Undo toast (10 s)                                |
| Turn a module off, lower a limit below usage, change a user's role | Disruptive   | Consequence + reason                             |
| Send password reset link, mint SCIM token, change SSO              | Disruptive   | Reason; `organizations:security:write` (SA-05)   |
| Start a support session                                            | Disruptive   | §3.11 flow                                       |
| Flag change affecting >1 tenant, kill switch                       | Disruptive   | Tenant count + reason                            |
| Announcement to all tenants or Incident severity                   | Disruptive   | Audience count                                   |
| Suspend a tenant                                                   | Disruptive   | _"312 users lose access now"_ + reason           |
| Terminate or purge a tenant, delete an IdP                         | Irreversible | Typed slug + reason + second approver (**D-S3**) |
| Demote or deactivate the last Super admin                          | Blocked      | Refused with the reason (SA-05)                  |

---

## 5. Owner decisions

| ID   | Decision                                                               | Recommended default                                  |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| D-S1 | Role visibility matrix (§2.3)                                          | As proposed                                          |
| D-S2 | Notify tenant admins by email when a support session starts            | In-app always; email for "Can make changes" sessions |
| D-S3 | Second approver for terminate/purge                                    | Required in production                               |
| D-S4 | Automatic tenant announcement when suspended for non-payment           | Yes, to tenant admins only                           |
| D-S5 | Keep Sales CRM inside the console, or move it to a separate tool later | Keep, under Revenue                                  |
