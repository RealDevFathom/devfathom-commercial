# Pharmacy SMS fallback (#723)

Utility messages (refill-due, order-ready, khata-due) can go by SMS when WhatsApp
cannot be used. SMS stays transactional. Staff-selected SMS refill captures use SMS
directly; WhatsApp captures and khata reminders use SMS as a fallback.

## When SMS is sent

| Message     | WhatsApp path                       | SMS fallback triggers                                                                                                                                  |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refill due  | `processDueWhatsAppRefillReminders` | staff selected SMS at capture, customer has no WhatsApp consent, or WhatsApp failed **permanently** at send time or through a signed delivery callback |
| Khata due   | `processDueWhatsAppKhataReminders`  | no WhatsApp consent or a permanent WhatsApp failure                                                                                                    |
| Order ready | none yet                            | `notifyOrderReadyBySms`, run after a staff `ready` transition commits, sends only to customers **without** WhatsApp consent                            |

"WhatsApp consent" is the gate the reminder jobs already use: `whatsappOptIn === true`
and a granted, unrevoked `REMINDERS/WHATSAPP` patient consent. A transient or unknown
WhatsApp outcome (`UNKNOWN`, timeouts, 5xx) never triggers SMS. Signed delivery
callbacks enable fallback only for known permanent error codes (131026, 131031,
132001, 132015, 132016); unknown or transient codes do not. The next scheduled
reminder run sends the fallback in local daytime if it is still due, using the
same SMS dedupe key as a send-time failure. Confirmed WhatsApp delivery prevents
later failure replays from enabling SMS.

SMS additionally requires a granted, unrevoked `REMINDERS/SMS` patient consent and that
the customer has not replied STOP by SMS (`pharmacy_customers.smsOptIn = false`). The
refill and khata jobs keep every existing gate (tenant binding, pharmacy vertical,
lifecycle, `pharmacy-crm` entitlement, 08:00–22:00 local hours, one refill reminder per
customer per day, one khata reminder per customer per day). Each SMS is claimed in
`pharmacy_message_logs` with `channel = 'SMS'` before the gateway is called
(at-most-once), using its own dedupe key (`sms:<whatsapp key>`, `sms:order-ready:<id>`).
Refill and khata SMS also carry a per-customer, per-local-day key
(`refill-sms:<customer>:<day>`, `khata-sms:<customer>:<day>`), so a customer gets at
most one SMS of each kind per day even when several captures are due.
Refill batches exclude captures with no currently eligible channel before the
batch limit is applied. A capture remains eligible for a later run if consent
is granted before its run-out date.

## STOP / START

`POST /api/pharmacy/sms/webhook` accepts the provider-neutral envelope
`{ "messages": [{ "id", "from", "text", "receivedAt" }] }` signed with
`X-SMS-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. It fails closed without
`PHARMACY_SMS_WEBHOOK_SECRET`, and the host tenant must equal
`PHARMACY_SMS_ORGANIZATION_ID`. The keyword list is the WhatsApp one (STOP, UNSUBSCRIBE,
band karo, بند …). STOP sets `smsOptIn = false` for every active customer whose
full normalized phone number matches the sender, including shared family phones.
START updates the same matches. Each message is claimed once and acknowledged once.
STOP is sticky until START; START clears it but does not grant consent by itself — the staff-recorded `REMINDERS/SMS` consent still rules.
Other text is ignored; SMS has no order intake.

Every utility SMS ends with "Reply STOP to opt out." (or the Urdu equivalent).

## Message content and privacy

Khata SMS includes the account display name and outstanding amount in PKR. SMS
can be visible on a lock screen or shared phone, so these financial details may
be visible to others with access to the recipient's device. Account names have
links removed, whitespace collapsed and a 40-character cap. Refill SMS includes
only the refill due date; no SMS template includes medicine names or links.

The webhook signature covers the raw body without a separate timestamp. Replay
protection uses the `sms-in:<provider message id>` claim; acknowledgements are
sent only for messages less than 24 hours old.

## Configuration

| Variable                       | Meaning                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `PHARMACY_SMS_PROVIDER`        | `mock` (default, no network) or `aggregator` (PK aggregator, chosen later; sending refused until its adapter is approved) |
| `PHARMACY_SMS_ORGANIZATION_ID` | Organization that owns the SMS sender. Unset = SMS fallback disabled                                                      |
| `PHARMACY_SMS_SENDER_ID`       | Masking / sender id registered with the aggregator                                                                        |
| `PHARMACY_SMS_WEBHOOK_SECRET`  | HMAC secret for the inbound webhook                                                                                       |
| `PHARMACY_SMS_LANGUAGE`        | `en` (default) or `ur` template language                                                                                  |

Refill and khata SMS run inside the existing reminder jobs using the SMS tenant
binding independently of WhatsApp templates, sender binding, or provider selection.
A disabled WhatsApp configuration does not itself bypass a customer's WhatsApp consent.

The order-ready SMS is scheduled after the staff response and transaction commit,
as the acting staff user. Sanitized reason codes are logged if scheduling or
pre-claim work fails. The existing `/api/pharmacy/whatsapp/reminders` scheduler also
processes unclaimed ready-order notices, so quiet-hour notices (22:00–08:00 local)
are deferred until a daytime run. The scheduler scans and sends as a current
active staff reader with order permission. It rechecks order status, branch,
tenant lifecycle, entitlements and channel consent.
Collected or cancelled orders are not notified, and an existing SMS claim prevents
another send. Keep this scheduler running for SMS-only tenants as well.
