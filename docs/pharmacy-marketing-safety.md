# Pharmacy marketing quality webhooks

Configure `PHARMACY_WHATSAPP_ORGANIZATION_ID`, `PHARMACY_WHATSAPP_PHONE_NUMBER_ID`
and `PHARMACY_WHATSAPP_BUSINESS_ACCOUNT_ID` with the tenant, sender and its owned
WhatsApp Business Account. The existing app secret must also be configured for
signature verification. A shared app signature does not establish account ownership.

Quality events must name that account in `entry.id`. Any supplied `waba_info.waba_id`
and sender identifiers must agree with the configured binding. Missing account
configuration, ambiguous identity, foreign events and missing/invalid `entry.time`
are ignored. Account-level events without a sender identifier apply to the configured
sender only after account ownership is established.

Subscribe to both `account_update` and `phone_number_quality_update`. Phone-scoped
events require a matching sender ID, or an exact `display_phone_number` match to
`PHARMACY_WHATSAPP_DISPLAY_PHONE_NUMBER`. Configure the display number exactly as
Meta reports it; phone-scoped evidence without a sender binding is ignored, even
when the account matches. Contradictory identifiers are always rejected.

YELLOW/RED scores and explicit blocking, restriction, violation, disablement,
ban, FLAGGED and DOWNGRADE events pause marketing. Event names are matched
exactly; UNBLOCKED and UNFLAGGED alone neither pause nor resume sending.

For integrations supplying measured block-rate telemetry, the signed quality
value may include `previous_block_rate` and `block_rate`, both finite fractions
from 0 to 1 for comparable observation windows. A numeric increase pauses even
with GREEN quality. Both rates are retained in the audit evidence. Missing,
equal or falling rates alone do not change the gate. These are optional
normalized telemetry fields, not a claim that Meta includes block-rate metrics
in its standard quality webhook. If the provider omits them, only its quality
and restriction signals are available; delivery failures are never treated as
recipient blocks.

`entry.time` is retained as the provider occurrence time, with a stable event key
derived from the account, sender, timestamp and quality evidence. Updates apply
atomically only when newer than the stored state. At the same provider timestamp,
degraded evidence can pause marketing, but GREEN evidence cannot clear a pause.
Exact retries leave the state unchanged. A later GREEN event can resume marketing.

Every applied event appends a `PHARMACY_MARKETING` audit record with the sender,
reason, occurrence time and event key in the same tenant transaction. Retries
and stale events append nothing. Audit failure rolls back the state change.

An active pharmacy owner with CRM access can also recover through the
`pharmacyMarketing.qualityState` and `pharmacyMarketing.resumeQuality` tRPC
procedures. Read the state with `{ branchId }`, then submit `{ branchId, senderId,
expectedEventKey, reason }` to resume; use the event key returned by the read
and a reason of 10–500 characters. A changed event key or unpaused state rejects
the override. The override and actor/reason audit commit together. Provider time
and event identity are preserved, so retries remain ignored and newer degraded
evidence can pause again. This is an owner API recovery path.

Paused preview, capture and sandbox operations return the provider pause reason
through the existing campaign action error display.

Existing campaigns whose saved `frequencyCap` omits `monthlyMax` use 2 per
customer in a rolling 30 days. No saved weekly setting changes. The workspace
shows this rollout notice and each campaign review shows its effective monthly
limit before approval or capture. New drafts can configure the monthly limit.
