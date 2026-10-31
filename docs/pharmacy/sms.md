# Pharmacy SMS fallback (#723)

Utility messages (refill-due, order-ready, khata-due) can go by SMS when WhatsApp
cannot be used. SMS is a **fallback only** and stays transactional.

## When SMS is sent

| Message | WhatsApp path | SMS fallback triggers |
| --- | --- | --- |
| Refill due | `processDueWhatsAppRefillReminders` | customer has no WhatsApp consent, or the WhatsApp send failed **permanently** (`FAILED`, a definitive provider error) |
| Khata due | `processDueWhatsAppKhataReminders` | same as refill |
| Order ready | none yet | `notifyOrderReadyBySms`, run after a staff `ready` transition commits, sends only to customers **without** WhatsApp consent |

"WhatsApp consent" is the gate the reminder jobs already use: `whatsappOptIn === true`
and a granted, unrevoked `REMINDERS/WHATSAPP` patient consent. A transient or unknown
WhatsApp outcome (`UNKNOWN`, timeouts, 5xx) never triggers SMS, so a customer cannot
receive both messages.

SMS additionally requires a granted, unrevoked `REMINDERS/SMS` patient consent and that
the customer has not replied STOP by SMS (`pharmacy_customers.smsOptIn = false`). The
refill and khata jobs keep every existing gate (tenant binding, pharmacy vertical,
lifecycle, `pharmacy-crm` entitlement, 08:00–22:00 local hours, one refill reminder per
customer per day, one khata reminder per customer per day). Each SMS is claimed in
`pharmacy_message_logs` with `channel = 'SMS'` before the gateway is called
(at-most-once), using its own dedupe key (`sms:<whatsapp key>`, `sms:order-ready:<id>`).

## STOP / START

`POST /api/pharmacy/sms/webhook` accepts the provider-neutral envelope
`{ "messages": [{ "id", "from", "text", "receivedAt" }] }` signed with
`X-SMS-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. It fails closed without
`PHARMACY_SMS_WEBHOOK_SECRET`, and the host tenant must equal
`PHARMACY_SMS_ORGANIZATION_ID`. The keyword list is the WhatsApp one (STOP, UNSUBSCRIBE,
band karo, بند …). STOP sets `smsOptIn = false` (sticky until START); START clears it but
does not grant consent by itself — the staff-recorded `REMINDERS/SMS` consent still rules.
Other text is ignored; SMS has no order intake.

Every utility SMS ends with "Reply STOP to opt out." (or the Urdu equivalent).

## Configuration

| Variable | Meaning |
| --- | --- |
| `PHARMACY_SMS_PROVIDER` | `mock` (default, no network) or `aggregator` (PK aggregator, chosen later; sending refused until its adapter is approved) |
| `PHARMACY_SMS_ORGANIZATION_ID` | Organization that owns the SMS sender. Unset = SMS fallback disabled |
| `PHARMACY_SMS_SENDER_ID` | Masking / sender id registered with the aggregator |
| `PHARMACY_SMS_WEBHOOK_SECRET` | HMAC secret for the inbound webhook |
| `PHARMACY_SMS_LANGUAGE` | `en` (default) or `ur` template language |

Refill and khata SMS run inside the existing WhatsApp reminder jobs. The order-ready SMS
runs inline after `pharmacyOrdering.transition` (`action: 'ready'`) commits, as the acting
staff user, because customer orders are RLS-visible only to the customer or `pharmacy:orders`
staff. It is best effort: a gateway error never fails or undoes the transition, and an order
marked ready during quiet hours (22:00–08:00 local) gets no SMS.
