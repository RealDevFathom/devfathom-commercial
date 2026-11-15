-- DEV-166: an invoice payment posts an INCOME transaction so Finance revenue,
-- profit, P&L and dashboard figures (all read from the transactions ledger)
-- include money received against invoices. The link lets a deleted payment
-- remove its revenue entry with it. The transactions table already has
-- tenant row-level security; this only adds a nullable column.
BEGIN;

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "paymentId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "transactions_paymentId_key" ON "transactions"("paymentId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'transactions_paymentId_fkey'
       AND conrelid = '"transactions"'::regclass
  ) THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "transactions_paymentId_fkey"
      FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMIT;
