-- DEV-166: an invoice payment posts an INCOME transaction so Finance revenue,
-- profit, P&L and dashboard figures (all read from the transactions ledger)
-- include money received against invoices. The link lets a deleted payment
-- remove its revenue entry with it. The transactions table already has
-- tenant row-level security; this only adds a nullable column.
BEGIN;

-- The backfill below spans every tenant; transactions and payments FORCE RLS.
SELECT set_config('app.is_platform_admin', 'true', true);

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

  -- Tenant integrity: a ledger row may only reference a payment in its own
  -- organization (same composite pattern as the other tenant FKs).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_transactions_paymentId_payments_fk'
       AND conrelid = '"transactions"'::regclass
  ) THEN
    ALTER TABLE "transactions"
      ADD CONSTRAINT "tenant_transactions_paymentId_payments_fk"
      FOREIGN KEY ("organizationId", "paymentId") REFERENCES "payments" ("organizationId", "id")
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- Backfill: payments recorded before this change posted no revenue, so an
-- already-paid invoice still reported $0. Post one INCOME row per unlinked
-- payment. Skip a payment when unlinked INCOME already appears to cover its
-- invoice (hand-entered workaround or seeded "Payment for INV-..." rows) so
-- money is never counted twice, and skip cancelled invoices, whose intent is
-- unknown for historical data. Re-running inserts nothing new.
INSERT INTO "transactions"
  ("id", "organizationId", "type", "amount", "currency", "description",
   "projectId", "clientId", "paymentId", "date", "createdAt", "updatedAt")
SELECT 'payment_income_' || p."id",
       p."organizationId",
       'INCOME',
       p."amount",
       p."currency",
       'Payment for ' || i."invoiceNumber",
       i."projectId",
       i."clientId",
       p."id",
       p."paidAt",
       NOW(),
       NOW()
  FROM "payments" AS p
  JOIN "invoices" AS i
    ON i."id" = p."invoiceId"
   AND i."organizationId" = p."organizationId"
 WHERE i."status" <> 'CANCELLED'
   AND NOT EXISTS (
     SELECT 1 FROM "transactions" AS linked WHERE linked."paymentId" = p."id"
   )
   AND NOT EXISTS (
     SELECT 1
       FROM "transactions" AS manual
      WHERE manual."organizationId" = p."organizationId"
        AND manual."type" = 'INCOME'
        AND manual."paymentId" IS NULL
        AND (
          manual."description" ~ ('(^|[^0-9A-Za-z])' || i."invoiceNumber" || '($|[^0-9A-Za-z])')
          OR (
            manual."clientId" = i."clientId"
            AND manual."currency" = p."currency"
            AND manual."amount" IN (p."amount", i."total")
            AND manual."date" BETWEEN p."paidAt" - INTERVAL '31 days'
                                  AND p."paidAt" + INTERVAL '31 days'
          )
        )
   )
ON CONFLICT ("paymentId") DO NOTHING;

COMMIT;
