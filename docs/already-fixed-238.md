# Issue #238 — already fixed

Verified against repository HEAD `6f725250aa85ee57913df969cdc2368869f16dab`.

The reported cashier authorization mismatch is already resolved in the current code:

- `src/lib/vertical-catalog.ts:791-796` defines the canonical Cashier role with both
  `pharmacy:counter` and `pharmacy:orders`.
- `src/server/routers/pharmacy-prescriptions.ts:38-62` protects prescription-file operations
  without auditing sensitive upload input and permits an actor with either `pharmacy:orders` or
  the exact `pharmacy:dispense` grant.
- `src/server/routers/pharmacy-prescriptions.test.ts:160-185` covers a successful prescription
  image capture and verifies that authorization checks `pharmacy:orders`.
- `tests/pharmacy-capabilities.db.test.ts:268-281` verifies against persisted permissions that a
  cashier has `pharmacy:orders` while unrelated access remains denied, and also checks tenant
  isolation after switching the active organization.
- `src/lib/vertical-catalog.ts:714-718` documents that `pharmacy:dispense`, `pharmacy:safety`, and
  `pharmacy:catalogue-review` remain exact-grant-only and that wildcard denies still revoke them.

Therefore, the Capture prescription control is valid for the canonical cashier: the cashier can
upload and capture through `pharmacy:orders` without receiving clinical dispensing authority. No
product code or tests were changed. Per the issue instructions for this environment, no test suite
was executed.
