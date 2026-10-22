# GitHub issue #278: already fixed

Issue #278 is already resolved in the current code, so no production code or tests were changed.

## Evidence

- `src/app/api/restaurant/checkout/comp/reverse/route.ts:9-25` exposes an authenticated money-mutation endpoint for reversing a comp. It requires `payments:collect`, validates that the bill belongs to the device branch, resolves an approver, and passes the authenticated terminal session into the command.
- `src/lib/restaurant/bills.ts:1037-1112` implements the reversal transaction. It locks and looks up the bill within the supplied branch, permits reversal while the bill remains `OPEN` (without rejecting existing tenders), rejects a line outside that bill, records the acting operator, approving manager, reason, device, terminal session, capability, and target in the co-authorization audit, then restores the line and bill totals.
- `src/lib/restaurant/bills.test.ts:945-1018` contains focused database coverage for reversal after a partial tender. It verifies idempotent replay, restored totals, retained tender, and the co-authorization audit identities and reason.
- `src/lib/restaurant/terminal-checkout.db.test.ts:715-777` exercises the HTTP route and verifies that the reversal audit is linked to the authenticated terminal session, device, and active staff member.

These paths provide the authorised and audited reversal requested by the issue, including after a partial tender. The existing re-cut lock after tender remains independent and unchanged.
