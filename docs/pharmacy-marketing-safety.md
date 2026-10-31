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

`entry.time` is retained as the provider occurrence time, with a stable event key
derived from the account, sender, timestamp and quality evidence. Updates apply
atomically only when newer than the stored state. At the same provider timestamp,
degraded evidence can pause marketing, but GREEN evidence cannot clear a pause.
Exact retries leave the state unchanged. A later GREEN event can resume marketing.

Paused preview, capture and sandbox operations return the provider pause reason
through the existing campaign action error display.
