-- #398: until the mark-paid workflow, a status-only change could set an invoice
-- PAID without recording a payment (and the seed did the same), so the invoice's
-- balance — always derived from its payment rows — still showed the whole total
-- as owed beside a "Paid" status.
--
-- Reconcile each such invoice with ONE payment for exactly the unrecorded
-- shortfall. The PAID status is kept as recorded by the person who set it; the
-- payment is dated when the invoice was marked paid and labelled so it can be told
-- apart from a real receipt. Deleting it from the payments panel reopens the
-- invoice, exactly like deleting any other payment. Invoices that are not PAID, or
-- whose payments already cover the total, are not touched, and the deterministic
-- id makes a re-run a no-op.
BEGIN;

-- Payments and invoices force row-level security; the migration acts for every tenant.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO payments
  (id, "organizationId", "invoiceId", amount, currency, method, note, "paidAt", "createdAt")
SELECT 'pay398_' || md5(i.id || ':20261023090000'),
       i."organizationId",
       i.id,
       i.total - COALESCE(recorded.paid, 0),
       i.currency,
       'Marked paid (no payment recorded)',
       'Backfilled to match the invoice''s PAID status (#398)',
       COALESCE(i."paidAt", i."updatedAt"),
       CURRENT_TIMESTAMP
FROM invoices i
LEFT JOIN (
  SELECT "invoiceId", SUM(amount) AS paid FROM payments GROUP BY "invoiceId"
) recorded ON recorded."invoiceId" = i.id
WHERE i.status = 'PAID'
  AND i.total - COALESCE(recorded.paid, 0) >= 0.01
ON CONFLICT (id) DO NOTHING;

COMMIT;
