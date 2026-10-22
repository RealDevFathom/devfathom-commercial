# GitHub issue #350: already fixed

Issue #350 reported that the PH-A4 FEFO override tests reached
`requireCounterReceiptAccess`, whose `ctx.db.user.findUnique` lookup was absent
from that suite's deliberately small database mock.

The current code no longer has that coupling:

- `pharmacySales.addLine` starts at `src/server/routers/pharmacy-sales.ts:855` and
  obtains its tenant/branch scope with `scopeFor(ctx, input.branchId)` at line
  932. It does not call `requireCounterReceiptAccess`.
- The non-controlled path returns `addSaleLine(db, scope, input)` at
  `src/server/routers/pharmacy-sales.ts:937`, so PH-A4 override behavior does not
  require a user-model lookup.
- The focused PH-A4 fixture intentionally supplies only the models used by this
  path at `src/server/routers/pharmacy-sales.fefo-override.test.ts:47-61`; its
  non-controlled medicine lookup returns `null` at line 59.
- `requireCounterReceiptAccess` remains scoped to counter receipt/cart/tender
  operations. Its membership lookup is at
  `src/server/routers/pharmacy-sales.ts:327`, and its dedicated fixture includes
  `db.user.findUnique` at
  `src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts:85-93`.

Therefore the reported six crashes cannot occur on the current `addLine` path,
and adding `db.user` to the FEFO fixture would conceal rather than test the
existing separation of concerns. No production or test-code change is needed.
