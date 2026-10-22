# Loyalty 5/6 — refill reminders

## Scope and parallel-build note

This branch implements only refill reminder delivery on top of
`PharmacyRefillReminderCapture`, `PatientConsent`, and the existing pharmacy
message outbox/log. It does not implement points, vouchers, tiers, or another
loyalty ledger. **Rebase this branch onto the applicable loyalty sibling branch
after that sibling lands**; the migration and service are intentionally additive.

## Design

- The scheduler reads only due `CAPTURED` rows (`reminderAt <= now`). It then
  re-enters the capture's organization RLS context and locks the exact
  organization/branch/capture tuple before deciding.
- The latest consent version for the capture's channel must grant `REMINDERS`.
  Missing or revoked consent produces `SKIPPED` with a stable reason.
- `pharmacy_refill_reminder_preferences` is a per-patient, per-organization
  preference dedicated to refill reminders. It deliberately does not reuse the
  customer-wide WhatsApp flag or any points/voucher preference. `STOP REFILL`
  records a keyword opt-out; the service also exposes `LINK` as a source for the
  authenticated/signed link handler.
- An eligible capture and its `pharmacy_message_logs` `PENDING` row are written
  in one tenant transaction. The deterministic `refill-capture:<captureId>` key
  makes the claim idempotent. State proceeds `CAPTURED -> QUEUED -> SENT`; an
  ineligible capture proceeds `CAPTURED -> SKIPPED` with `statusReason`.
- The scheduler never calls a WhatsApp provider. The existing live-send block
  remains untouched; only the current outbox worker may deliver and then call
  `markRefillReminderSent` after provider acknowledgement.

## Template and data minimization

`refill_reminder_bilingual_v1` is transactional Urdu/English content. Its
queued payload contains only a reminder date, the `STOP REFILL` keyword, and
the opt-out path. Patient name, phone, medicine, strength, quantity, dosage,
directions, and other clinical details are not copied into the message payload.
Routing retains only the existing tenant, branch, patient, and capture foreign
keys required to resolve the recipient under consent at dispatch time.

## Authorization and isolation

Staff preference changes use the central `can()` path through
`capabilityProcedure('pharmacy:counter')`; central explicit `DENY` therefore
wins. Keyword requests are patient-originated webhook events rather than staff
mutations. The new table carries `organizationId` with the standard
`current_setting` default and enabled plus forced RLS. Scheduler work is
tenant-scoped, and branch identity participates in both the eligibility lock
and transition update.

## Follow-ups

1. Wire the signed/authenticated opt-out URL handler to
   `setRefillReminderPreference(..., source: 'LINK')`; do not place a raw patient
   identifier in the URL.
2. Register the bilingual template with the selected WhatsApp provider before
   enabling its existing dispatcher. Live sending remains blocked in this lane.
3. Have the outbox acknowledgement path invoke `markRefillReminderSent`; failed
   transport attempts remain owned by the existing outbox retry lifecycle.
4. Rebase onto the sibling loyalty branch and regenerate Prisma artifacts in
   the integration environment.

## Verification approach

Focused Vitest coverage is supplied for due selection, missing/revoked consent,
independent opt-out, per-capture idempotency, minimum-PHI payloads, and tenant /
branch scoping. Per the parallel-build request, dependencies were not installed,
Prisma was not generated, and tests were not executed in this Codex environment.
