# DevFathom for agencies: a plain-language guide

> **Who this is for:** agency owners, managers and staff.
> **Status: IMPLEMENTED (repository scope).** Source-checked against code at `6e425380`, the base of PR #58; see [repository evidence](#repository-evidence). This is not a deployment or plan-availability claim. Anything marked **TODO(confirm)** still needs checking in the running app.
> **TODO(confirm):** language. This guide is in English only. Do we also need Urdu or Roman Urdu? (Open question 6 in the docs survey.)

Words in *italics* are explained in the [agency glossary](agency-glossary.md).

---

## 1. What DevFathom does for an agency

An agency is a business that does work for clients, for example design, software or marketing work. **TODO(confirm):** which kinds of agency we sell to.

DevFathom gives an agency one place to run the business:

- **Clients**, and the **projects** you do for them
- **Boards and tasks** to plan the work, and **time entries** to record time spent
- **Invoices, payments and expenses** to bill clients and track money
- **Your team**: staff list, leave, performance reviews and resignations
- **Meetings, notes, chat and email**

DevFathom also has products for pharmacies and restaurants. They run on the same platform, but this guide covers only the agency product. Hotel features are not covered.

**Your data stays private.** Each *organization* in DevFathom is kept separate from every other organization at the database level. Staff in another business cannot see your clients, projects or invoices.

---

## 2. A map of the main areas

| Area | What it is for | Notes |
|---|---|---|
| **Dashboard** | A quick view of what is going on | Active projects, tasks, work finished this week, pending leave and upcoming deadlines. Admins also see this month's income and expenses, unpaid invoices and a revenue chart. |
| **Clients** | Your list of clients, their contacts and contracts | Only Admins can add or change clients |
| **Projects** | Projects, *boards* and *tasks* | You can import boards from Trello |
| **Finance** | *Invoices*, *payments*, income and expenses, recurring expenses, budget vs actual, and a profit-and-loss report | Admins only |
| **Team** | Your staff list and team statistics | The team-wide statistics are for Admins; everyone can see their own |
| **HR** | *Leave requests*, performance *reviews*, *resignations* | |
| **Meetings** | Plan and record meetings | |
| **Notes** | Written notes, with version history and sharing | A note can be linked to a client or a project |
| **Chat** | Team *channels* and messages, updated live | |
| **Email** | Connect your own Gmail or Outlook mailbox and read, send and reply from inside DevFathom | Each person connects their own mailbox |
| **Reviews** | Staff performance reviews | HR or Admins run review cycles; staff fill in the reviews they are given. These are not client reviews. |
| **Organization** | Settings for the whole organization, roles and permissions | Usually for admins |
| **Settings** | Your own profile and preferences, plus your organization's plan details | TODO(confirm): exactly which settings each role sees |
| **Audit logs** | A record of who did what, and when | Admins only |
| **API docs** | For technical staff who connect other tools | Admins manage *API tokens* and *webhooks* |

---

## 3. Getting started

### Step 1: Get your organization created
The DevFathom platform team creates organizations and decides which *modules* each organization has, and any limits that apply.
- **TODO(confirm):** whether agencies can sign up on their own.
- The agency-specific catalog has four modules: **Agency Core** (required), plus **Projects**, **Clients** and **Finance**, which can be switched on or off. Shared features such as Chat, Meetings, HR, Email, API access and Audit logs have separate module controls, so the areas below depend on your organization's enabled modules. Agency plans count users (seats) for the whole organization; the catalog defines no additional agency-specific numeric limits. TODO(confirm): prices and seat numbers per package.

### Step 2: The first admin signs in
- The platform team creates the first admin with a temporary password. The admin must change it on first sign-in. **TODO(confirm):** the approved way to deliver that temporary password.
- Never share a login with anyone, and never write a password in a document or chat.

### Step 3: Turn on two-step sign-in
DevFathom supports *two-step sign-in (2FA)* with an authenticator app and backup recovery codes. Each person turns it on for their own account; it is off until they do.
- **TODO(confirm):** where the option sits on screen, and whether an admin can require it for everyone.

### Step 4: Invite your team
1. An Admin sends each person an *invitation*.
2. Give each person a role: **Admin**, **HR** or **Employee** (see [section 5](#5-roles-who-can-do-what)), and a department (Leadership, Engineering, Product, Quality, Marketing or Design).
3. If someone forgets their password, they can reset it themselves.

Larger agencies may be able to use *SSO* (sign in with your company account) and *SCIM* (add and remove users automatically). **TODO(confirm):** which plans include SSO and SCIM.

### Step 5: Add your work
1. Add your clients (Admins only).
2. Create a project for each piece of client work.
3. Already using Trello? Import your Trello boards instead of building them again.

### Step 6 (optional): Connect other tools
An Admin can create *API tokens* and *webhooks* so other systems can talk to DevFathom, when those modules are enabled. The **API docs** area explains how.

### Setup checklist
- [ ] Organization created and modules switched on
- [ ] First admin signed in
- [ ] Two-step sign-in set up
- [ ] Team invited, each person with the right role
- [ ] Clients added
- [ ] Projects created, or imported from Trello

---

## 4. Daily workflows

These are the everyday jobs in the agency product. Exact button and screen names still need checking. **TODO(confirm):** add screenshots (see [section 7](#7-notes-and-limits)).

### Start the day
1. Open the **Dashboard** to see what needs attention.
2. Check **Chat** for messages from your team.

### Run a project
1. Open the client, then the project.
2. On the project *board*, add *tasks* and give each one to a team member.
3. Move tasks across the board as the work moves forward.
4. Record time spent as *time entries*. Time is typed in by hand as hours; there is no timer.

### Bill a client
Billing is for Admins.
1. In **Finance**, create an *invoice* for the client. You can also create one from a client's contract. Invoices are **not** built from time entries.
2. Email the invoice to the client from DevFathom.
3. When the client pays, record the *payment* against the invoice. Unpaid invoices past their due date can be marked overdue.

### Meetings and notes
1. Plan the meeting in **Meetings**.
2. Write down what was decided in **Notes**.

### Talk to the team
Use **Chat** *channels* for team conversations. New messages appear live, with no page refresh needed.

### Leave and other HR tasks
1. An employee asks for time off with a *leave request*.
2. HR or an Admin approves or declines it. Staff can see their leave balance and a team leave calendar.
3. Performance *reviews* and *resignations* are also handled in the HR area. Any active staff member can hand in a resignation; HR or an Admin reviews it (HR cannot review an Admin's resignation).

### Find anything
Use **search** to find projects, tasks, clients and notes.

### Check what happened
An Admin can open **Audit logs**, when that module is enabled, to see who changed what, and when.

---

## 5. Roles: who can do what

Every user in your organization has one of three basic roles:

The table describes baseline access when the relevant modules are enabled. Custom roles and permission overrides can change capability-based access; a person's basic role alone does not guarantee their effective permissions.

| Role | What they can do |
|---|---|
| **Admin** | Everything in the organization: settings, inviting people and changing roles, clients and contracts, all of Finance, the team-wide statistics and the revenue figures on the dashboard. Also everything HR can do. |
| **HR** | People matters: see and approve leave, set leave balances, run performance review cycles, see and review resignations, and lay off staff (but not an Admin). HR does **not** see Finance. |
| **Employee** | Day-to-day work: projects, boards and tasks, time entries, chat, notes, meetings and their own email. Request leave, fill in their own reviews, hand in a resignation, and see their own statistics. |

**Ready-made organization roles.** On top of the three basic roles, a newly provisioned agency starts with an **Organization administrator** role granting all agency capabilities. The catalog also defines **Administrator** and **Member** templates, but agency provisioning does not instantiate those templates or create a Member role. There are no agency-specific job roles (such as "designer" or "account manager") in the product today.

**Fine-tuning access.** Your organization can also:
- create **custom roles** with their own list of *permissions*, and
- give or remove a permission for **one person** with a *permission override*.

**DevFathom staff are separate.** The DevFathom platform team uses its own accounts and roles, which are not part of your user list. To help with a problem, DevFathom support can open a *support session* in your organization.
- **TODO(confirm):** whether customers are told about support sessions or must approve them, and where those sessions are recorded.

---

## 6. Reports and growth features

**What exists today:**
- **Dashboard**: projects, tasks, deadlines and pending leave; Admins also see income, expenses, unpaid invoices and a revenue chart.
- **Team statistics** (Admins): per person, open and overdue tasks, tasks finished this week and last week, how long tasks take, meetings attended, notes, projects, comments and a daily activity trend. Each person can see their own figures.
- **Finance** (Admins): invoices, payments, budget vs actual and a profit-and-loss report.
- **Audit logs** (Admins): a record of changes, when the module is enabled.

**Still to confirm:**
- **TODO(confirm):** whether reports can be exported (for example, to a spreadsheet).
- **Growth features:** there are none for agencies today. The growth and marketing tools belong to the pharmacy and restaurant products. TODO(confirm): whether any are planned.
- DevFathom's own sales CRM (leads, opportunities) belongs to the DevFathom platform team and lives in the separate platform area, not in your agency workspace.

---

## 7. Notes and limits

- **Screenshots:** none yet. The agency test data (`seed-agency-e2e`) is a possible source, but it is **not approved** for docs screenshots. TODO(confirm): which demo organization to use. Ping Inky to wake staging before taking any. Never show logins in screenshots.
- **Not covered here:** hotel features (out of scope), and the pharmacy and restaurant products (they have their own guides).
- **Getting help:** **TODO(confirm):** the support contact for agency customers.

---

## Related docs

- [Docs index](../README.md)
- [DevFathom technical overview](../technical-overview.md)
- [Agency glossary](agency-glossary.md)
- [Restaurant administrator guide](restaurant-administrator-guide.md)
- [Identity, authentication and authorization](../admin-platform/identity-access.md) (technical)
- [Modules, packages, contracts and limits](../admin-platform/entitlements.md) (technical)

## Repository evidence

These are code references for the implemented behavior described here, not evidence of a live customer deployment:

- [Agency modules, departments, role templates and limit keys](../../src/lib/vertical-catalog.ts), [shared module controls](../../src/lib/module-catalog.ts) and [entitlement resolution](../../src/lib/entitlements.ts).
- [Organization provisioning and first-admin access](../../src/lib/platform/commands.ts), with coverage in [agency onboarding regression tests](../../tests/agency-onboarding-regression.test.ts) and [organization creation tests](../../src/lib/platform/commands.organization-create.test.ts).
- [Baseline role policies](../../src/lib/abac/policies.ts), [custom permissions and overrides](../../src/lib/abac/index.ts), [procedure access checks](../../src/server/trpc.ts), [audit-log access](../../src/server/routers/audit.ts), [API tokens](../../src/server/routers/api-tokens.ts) and [webhooks](../../src/server/routers/webhooks.ts).
- [Team invitations](../../src/server/routers/team.ts), [invitation acceptance](../../src/server/routers/invitations.ts), [password resets](../../src/server/routers/password-reset.ts), [two-step sign-in](../../src/server/routers/two-factor.ts) and [support sessions](../../src/lib/tenancy/support-session.ts).
- [Agency workflows](../../tests/agency-e2e/agency-acceptance.spec.ts), [clients and contracts](../../src/server/routers/clients.ts), [projects and time entries](../../src/server/routers/projects.ts), [finance](../../src/server/routers/finance.ts), [team statistics](../../src/server/routers/team-stats.ts) and [resignations](../../src/server/routers/resignations.ts).
