-- #448 / DEV-252: agency invoices take a discount alongside tax.
--
-- `discount` is a currency AMOUNT, like `tax`, and Decimal(12,2) like every other
-- invoice money column. The application derives it with the one shared
-- calculation (src/lib/finance/invoice-amounts.ts):
--   line amount = round_half_up(quantity x rate, 2)
--   subtotal    = sum(line amounts)
--   total       = subtotal - discount + tax
-- and refuses a negative value or a discount larger than the subtotal. These
-- CHECKs are the durable floor under that rule for any other writer.
--
-- Additive and safe on existing data: every existing row gets discount 0, which
-- satisfies both constraints whatever its subtotal (the ceiling binds only a
-- non-zero discount), so both are validated immediately.
-- Idempotent: the column and each constraint are added only when absent.

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "discount" DECIMAL(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"invoices"'::regclass AND conname = 'invoices_discount_nonnegative_ck'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_discount_nonnegative_ck" CHECK ("discount" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '"invoices"'::regclass AND conname = 'invoices_discount_within_subtotal_ck'
  ) THEN
    ALTER TABLE "invoices"
      ADD CONSTRAINT "invoices_discount_within_subtotal_ck"
      CHECK ("discount" = 0 OR "discount" <= "subtotal");
  END IF;
END
$$;
