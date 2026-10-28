# FBR POS mock integration

Set `FBR_MODE=mock` on the server to opt in. Unset disables submission. No network
transport, POS registration, credentials, legal tax mapping, or live fiscalization
is implemented. The adapter accepts a domain snapshot, not an unverified PRAL
wire payload. This is the minimal FBR lane of `/workspace/research/specs/tax-integration.md`.

Paid pharmacy sale completion writes its invoice snapshot to `fiscal_invoice_outbox`
in the same transaction as settlement. The USIN is derived from tenant, branch,
and sale identity and remains stable on retry. Mock submission is deterministic
and local; its result is stored on the sale for receipt reads and reprints.

Failures stay pending with exponential backoff (5 seconds through 1 hour), with
no retry-count cutoff. An organization administrator can invoke
`pharmacySales.retryFbrInvoices({ branchId })` after the due time. Each invocation
processes up to 20 due invoices; repeat for a backlog. This minimal queue has no
background scheduler. Organization identity comes from the authenticated session;
branch membership is checked before dispatch. Claims use `FOR UPDATE SKIP LOCKED`.
Errors are persisted as a generic code to avoid leaking credentials or buyer data.

The receipt preview and browser paper show the saved mock FBR number and a QR
encoding that exact string. Browser paper uses a 7 × 7 mm QR. Pending receipts
show a pending label without a QR. Mock receipts explicitly state they are not
valid for tax verification. Fiscal receipts use the browser/OS print fallback:
the shared raw thermal contract does not support QR yet.

Apply the normal Prisma migrations before enabling mock mode. The outbox has
forced tenant RLS, a composite tenant/branch/sale foreign key and tenant-scoped
sale/USIN uniqueness. Existing sale RLS is preserved. A future live adapter must
be dispatched outside the settlement transaction, implement USIN idempotency,
and verify the official FBR wire contract and mandatory receipt fields first.

The mock snapshot omits tax fields pending confirmation of the FBR contract; keep
the receipt text "not valid for tax verification" until those requirements are met.
The tenant-only outbox policy has no platform-admin bypass. When a platform-wide
retry worker is introduced, add the `app.is_platform_admin` policy clause while
preserving forced RLS and tenant isolation.
