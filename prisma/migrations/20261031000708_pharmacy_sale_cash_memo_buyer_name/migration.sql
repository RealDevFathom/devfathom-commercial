-- #708 Sindh cash memo (Sindh Drugs Rules r.18): the buyer's name printed on the memo,
-- and the owner policy that can make it mandatory for walk-in sales.
-- Additive only: both columns are nullable/defaulted and existing rows are untouched.
ALTER TABLE "pharmacy_sales" ADD COLUMN "buyerName" TEXT;

ALTER TABLE "pharmacy_sales"
  ADD CONSTRAINT pharmacy_sales_buyer_name_check
  CHECK ("buyerName" IS NULL OR (length(btrim("buyerName")) BETWEEN 1 AND 120));

-- A reprint from sale history must show the same memo. Once a receipt number is
-- issued, the buyer name printed on it can no longer change.
CREATE FUNCTION pharmacy_sale_buyer_name_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."receiptNumber" IS NOT NULL AND NEW."buyerName" IS DISTINCT FROM OLD."buyerName" THEN
    RAISE EXCEPTION 'ISSUED_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_sale_buyer_name_immutable_guard
  BEFORE UPDATE ON "pharmacy_sales"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_sale_buyer_name_immutable();

-- Owner policy: false keeps walk-in sales nameless (the r.18 default the counter ships with).
ALTER TABLE "pharmacy_branches"
  ADD COLUMN "cashMemoBuyerNameRequired" BOOLEAN NOT NULL DEFAULT false;
