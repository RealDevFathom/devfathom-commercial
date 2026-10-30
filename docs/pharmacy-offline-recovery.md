# Recovering a rejected offline command

A failed replay rolls back the sale, stock, quota, receipt and command log together.
Retry the original command when the failure is repairable. To abandon a permanently
failed command, a manager can explicitly record its rejection before replaying the
next command. Sequence gaps remain forbidden.

Send `POST /api/pharmacy/counter/reject` with `{ "command": <original replay body>,
"reason": "<review reason>" }`. Use the live manager session, enrolled device bearer
credential, actor-bound `X-Terminal-Session`, original `Idempotency-Key` and original
`X-Command-Signature` headers. The manager must have `admin:access` and the tenant
must have the pharmacy-counter module enabled. The signature covers the original
command, without the surrounding recovery body. A nonempty reason is required.

Recovery records that exact command as `REJECTED`, retaining its original payload,
sequence and printed receipt number. It writes a `pharmacyOffline.rejectCommand`
audit event with the manager, device, branch, sequence and reason in the same
transaction. It creates no sale and consumes no stock, quota or receipt number.
An identical recovery retry returns the existing rejection; an accepted command
cannot be rejected. After the server confirms recovery, retain the rejected command
for review locally and resume replay at the next sequence. Do not renumber a printed
receipt; obtain a fresh receipt lease if the old lease is no longer usable.

An exhausted legacy device sequence remains exhausted: its durable cursor can hold
`2147483648`, while commands retain their positive PostgreSQL integer sequence.
Enroll a replacement counter for new work rather than resetting or wrapping the
existing device's sequence. Existing command retries remain idempotent.
