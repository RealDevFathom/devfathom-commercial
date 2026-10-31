# Customer service portal (#762)

Share `/pharmacy/customer` on the pharmacy's verified tenant host through SMS,
WhatsApp or a QR code. The public page and manifest no longer require a staff
login. Customer identity is established separately through an SMS code sent to
the phone on the existing customer/patient record. Unknown or ambiguous phone
numbers receive the same neutral response and never establish a session.

Configure the tenant-bound Twilio SMS sender using the four
`PHARMACY_CUSTOMER_SMS_*` variables in `.env.example`. The integration uses the
[Messages API](https://www.twilio.com/docs/messaging/api/message-resource).
No delivery provider, test codes, or customer sessions are enabled implicitly.
Live SMS delivery requires deployment credentials and a registered sender.
`PLATFORM_ENCRYPTION_KEY` is also required: phone numbers and OTP codes are
encrypted in the existing `OutboundEffect` queue. Delivery starts after the
neutral 202 response; the outbound-effects cron retries provider failures and
skips expired, consumed or superseded codes. Keep that cron enabled for delivery
retries, staged photo cleanup and expired OTP/session removal, even for inactive
customers. Delivered or terminal SMS payloads are cleared by the worker.
Private image storage must also be configured using the existing storage adapter.

In **Prescriptions → Customer requests**, an administrator with dispensing
permission verifies the branch settings with their own operator PIN: enable the
portal, configure OTP/session limits and loyalty wording, and verify the store's
Raast ID/IBAN and account title. The only current offer is a configurable delivery
fee waiver, so no product catalogue or drug advertising enters the portal.
The solo Owner / Operator can review their own branch queue with their own PIN;
no second staff account is required. Existing ABAC DENY rules remain effective.

Customers can view and print their completed itemised receipts, submit a previous
purchase for refill review, upload a private Rx photo, see their branch loyalty
balance after consent, and view their payer khata balances with verified Raast
instructions and an account reference. They make the transfer in their bank app.
The pharmacy confirms receipt through the existing payment workflow before the
ledger changes; a customer browser cannot credit an account by asserting payment.

Refill/photo requests persist with a retry key and content fingerprint. The
pharmacist queue records PIN-verified approval or decline and can load the
customer's photo into the existing prescription capture form. Fulfilment requires
an approved request and a completed dispensing sale for the same customer and
branch. For a photo request the sale must reference that original Rx. Existing
sales cannot fulfil multiple requests. A refill sale must include the original
medicines and presentations in the same canonical quantities; split sale lines
are aggregated so different pack sizes can still satisfy the request. Existing
RX-03 SIGN, consent, authorization limits, stock and settlement checks still run
at the counter. Portal approval alone never dispenses or changes money/stock.

The additive SQL migration owns composite foreign keys, FORCE RLS and immutable
portal audit events. OTP failures commit durable attempt counters; verification
and session creation share a locked transaction. Sessions store only token hashes,
use HttpOnly/SameSite cookies, and recheck active customer, branch, host tenant and
registered phone on every operation. Staff credentials cannot authorize customer
reads, and customer cookies cannot authorize pharmacist actions.
Audit events also reject `TRUNCATE`. Photos upload outside the customer-locking
transaction, after a delayed cleanup job commits. Request linking locks that job
and refuses already-claimed staging records; cleanup preserves linked images and
removes unused uploads from rollback or concurrent idempotent retries.

Targeted verification: customer policy, transport, UI, proxy, prescription capture,
staff PIN and PostgreSQL tests. The DB test uses `TEST_DATABASE_URL` and creates an
isolated schema, applying only the portal migrations to minimal dependency fixtures.
It exercises concurrent OTP consumption and refill retries, lockout persistence,
expiry, replay, revocation, RLS, composite FKs and audit immutability.
