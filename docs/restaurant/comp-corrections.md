# Reversing a retained comp

New complimentary items remain unavailable in the MVP. To correct a retained comp,
POST `/api/restaurant/checkout/uncomp` through an authenticated terminal session with
an active operator and a device-scoped `Idempotency-Key` header. The operator needs
`orders:complimentary`; the approver must authenticate and hold `coauth:approve`.
A solo owner can approve with their own freshly verified PIN under the existing
owner reauthentication rules.

The request uses the retained comp schema:

```json
{
  "billId": "bill-id",
  "billLineId": "line-id",
  "reason": "Comp applied to the wrong item",
  "approving": {
    "staffProfileId": "manager-id",
    "type": "PIN",
    "secret": "manager-pin"
  }
}
```

The bill must be OPEN in the terminal's branch and its business day must remain
open. Partial tenders do not prevent correction. The command restores the line's
comp amount and recalculates service charge over payable lines at the order's
pinned policy rate, allocating exact cents deterministically and preserving the
original split allocation cap. Tax remains a live
quote until settlement. Existing tenders, discounts and loyalty points returned
by the original comp are preserved.

The original comp reason and approval remain on the line. A separate approval
record identifies the reversal, original approval, restored principal, service
delta, operator, approver, device, terminal session and reason. The database supplies
the audit timestamp. All writes share the terminal transaction, taking the order lock before the bill
lock to serialize against tender, re-cut and cancellation.

The response contains `billId`, `billLineId` and `replayed`. A retry of the same
command returns `replayed: true` without another correction or approval record.
Reusing the key for another payload or command is a conflict. Settled and void
bills cannot be corrected through this endpoint; re-cut tender locks also remain
in force.
