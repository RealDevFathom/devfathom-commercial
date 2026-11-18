# Organization Lifecycle, Export, and Purge

## State machine

```text
PROSPECT
  ├─ ONBOARDING
  └─ TERMINATED

ONBOARDING
  ├─ ACTIVE
  ├─ SUSPENDED
  └─ TERMINATED

ACTIVE
  ├─ GRACE
  ├─ SUSPENDED
  └─ TERMINATED

GRACE
  ├─ ACTIVE
  ├─ SUSPENDED
  └─ TERMINATED

SUSPENDED ── ACTIVE | TERMINATED
TERMINATED ── PURGING
PURGING ── PURGED (worker only)
PURGED (terminal)
```

The control plane exposes only allowed next states. Every transition requires operator capability; sensitive transitions require a reason and create `OrganizationLifecycleEvent` plus platform audit.

## Access by state

- `ONBOARDING`, `ACTIVE`, `GRACE`: the organization may authenticate and operate. On the shared host these are exactly the states that make a workspace eligible for selection; every other state is excluded before the picker is rendered, and the lifecycle is re-checked again at selection rather than trusted from the pending intent.
- `PROSPECT`: not a usable workspace.
- `SUSPENDED`: tenant authentication/actor resolution fails; deployment health is marked unavailable; active support is revoked.
- `TERMINATED`: data retained but tenant access blocked.
- `PURGING`: retention-approved purge is queued/runnable.
- `PURGED`: tenant data deleted, control evidence retained.

## Activation

Activation is manual. Before `ACTIVE`, verify:

- package and seat ceiling;
- at least one active administrator;
- deployment mode;
- contract/module state;
- required production deployment/provisioning plan;
- identity/domain state when contractually required.

The transition can enqueue `PROVISION_SHARED` or `PROVISION_DEDICATED`.

### Pharmacy approval (DEV-905)

A super admin approves a pharmacy by hand from `/platform/approvals` or the organization page
(`organization.pharmacy.approve`, capability `organizations:security:write`). Owner decision,
18 Nov: approval may be given whatever the pharmacy's state. The checks it does not meet are
shown, must be confirmed by name, and are stored with the approval (`platformApprovedAt`, the
approver, the note and the unmet checks) and in the platform audit ledger. An `ONBOARDING`
pharmacy becomes `ACTIVE`.

While the approval is in effect (`ONBOARDING`, `ACTIVE` or `GRACE`), the gates in
`src/lib/pharmacy/platform-approval.ts` do not refuse the pharmacy, on ordinary and regulated
operations alike: organization not active, the activation preflight, and the branch regulatory gate
(profile, licence, qualified person, and the profile's presence-hours and schedule limits). Per-sale
rules are unchanged and run on every sale: the pharmacist dispensing grant, the pharmacist-attached
prescription and signed review for an Rx line, the controlled-medicine witness PIN and register,
refund and discount approvals, stock, tax and money. A later suspension or termination is not
overridden. `organization.pharmacy.approval.withdraw` (or a placeholder lock) clears the approval
and restores every check; a pharmacy the approval made active returns to `ONBOARDING`. Only the
platform control plane can write the approval columns; a database trigger refuses any other
transaction.

## Suspension and resume

Suspension enqueues a `SUSPEND` job. The worker marks non-decommissioned deployments degraded and revokes active support sessions. Resume enqueues `RESUME`, restores deployment state to ready, and records health timestamps.

Lifecycle access checks remain authoritative even if a provider deployment has not yet changed state.

## Export

`EXPORT_DATA` requires private Blob storage. The worker captures a bounded organization snapshot containing organization metadata, users, clients, projects, tasks, invoices, transactions, and audit records; writes a private JSON object; and stores path, URL, time, and record count in the job result.

Exports are platform jobs, not public links. Operations must add download authorization/expiry policy around any distribution workflow and should delete artifacts according to the data policy.

## Termination and purge

Termination records the retention/purge schedule. `PURGE_DATA` refuses to run unless:

- organization status is `PURGING`;
- `purgeScheduledAt` exists; and
- the retention timestamp has elapsed.

The worker introspects tenant tables, computes a foreign-key-safe deletion order, deletes rows by `organizationId`, marks the organization `PURGED`, and records deleted row counts in the lifecycle event.

Control-plane tables needed for legal/audit evidence are excluded from tenant deletion. Blob/provider cleanup beyond the implemented database/export object path must be included in the approved production retention runbook.

## Legal hold

The schema does not invent a legal-hold policy. If a hold applies, operators must not transition to `PURGING` or schedule the job. Add an explicit hold field and dual-control workflow before automating legal-hold decisions.
