# Sales CRM and Commercial Ledger

## Scope

The control desk supports the complete seller workflow from an unqualified lead to an activated customer agency and renewal. It intentionally records contracts and collections without pretending to be a payment processor or general ledger.

## Sales workflow

1. Create a `PlatformAccount` for the prospective agency.
2. Add leads and contacts.
3. Qualify the lead and open an opportunity.
4. Move the opportunity through pipeline stages; every change records a stage event.
5. Create one or more proposals and update status.
6. Schedule follow-ups with an owner and due date.
7. Mark the opportunity won and convert it into an `Organization`.
8. Complete package, contract, administrator, deployment, and activation details.

Conversion preserves the CRM links and adds the organization reference. It does not automatically activate the organization.

## Pipeline states

- Leads: `NEW`, `CONTACTED`, `QUALIFIED`, `UNQUALIFIED`, `CONVERTED`.
- Opportunities: `DISCOVERY`, `QUALIFIED`, `PROPOSAL`, `NEGOTIATION`, `WON`, `LOST`.
- Proposals: draft/sent/viewed/accepted/rejected/expired states from `ProposalStatus`.
- Follow-ups: open/completed/cancelled states from `FollowUpStatus`.

The dashboard aggregates open opportunity count/value; the CRM page presents stage columns and follow-up workload.

## Contract ledger

A contract records:

- organization and optional opportunity;
- unique number and human title;
- start/end/grace dates;
- status and billing interval;
- currency, contract value, and seat limit;
- notes and module lines;
- per-module seats and JSON limits.

Only contract states recognized by the entitlement resolver contribute licensed capability. Status changes are audited.

## Invoices and payments

An invoice records issue/due dates, currency, subtotal, tax, discount, total, balance, contract linkage, and status. A payment records amount, date, method/provider, external reference, notes, and status.

Recording a successful payment:

- creates a payment row;
- reduces invoice balance without going below zero;
- moves the invoice to `PAID` at zero balance or `PARTIALLY_PAID` otherwise;
- leaves an audit record.

Overdue and partially paid balances appear on the platform overview.

No webhook or external payment gateway is wired. If automatic collection is later required, provision the provider through the deployment integration process, add signed/idempotent webhooks, and preserve this ledger as the source of operational truth.

## Renewals

Renewals track:

- contract and organization;
- owner and due date;
- proposed start/end/value;
- workflow status;
- notes.

Active contracts ending inside the dashboard window appear in the renewal queue. A renewal record does not silently modify the original contract; operators explicitly create/update the next commercial record.

## Audit and correction

Commercial commands record actor, target, organization, before/after or metadata, success, and error. Avoid deleting posted records. Correct errors with status updates, additional payments/adjustments in notes, or replacement contracts/invoices under the finance operating policy.

## What is not implemented by design

- self-service checkout;
- automatic organization activation after payment;
- tax engine;
- general ledger/double-entry accounting;
- automatic card or bank collection;
- revenue recognition.

Those are external/product-scope decisions, not implied by the contract ledger.
