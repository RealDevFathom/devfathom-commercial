BEGIN;

-- Establish one durable cutover across tenants, including concurrent settlements.
-- Legacy receipt history cannot prove that an original was never delivered.
SELECT set_config('app.is_platform_admin', 'true', true);
LOCK TABLE "pharmacy_sales" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION initialize_pharmacy_receipt_print_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."receiptNumber" IS NOT NULL AND NEW."completedAt" IS NOT NULL THEN
    IF TG_OP = 'UPDATE' THEN
      IF OLD."receiptNumber" IS NOT NULL AND OLD."completedAt" IS NOT NULL THEN
        RETURN NEW;
      END IF;
    END IF;
    -- Only issuance observed after the cutover establishes original eligibility.
    -- This runs in the settlement transaction with the caller's tenant RLS.
    INSERT INTO "pharmacy_receipt_print_states"
      ("id", "organizationId", "branchId", "saleId", "copyCount", "updatedAt")
    VALUES
      ('receipt_print_' || NEW."id", NEW."organizationId", NEW."branchId", NEW."id", 0, NOW())
    ON CONFLICT ("organizationId", "branchId", "saleId") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_receipt_print_state_on_issue ON "pharmacy_sales";
CREATE TRIGGER pharmacy_receipt_print_state_on_issue
AFTER INSERT OR UPDATE OF "receiptNumber", "completedAt" ON "pharmacy_sales"
FOR EACH ROW EXECUTE FUNCTION initialize_pharmacy_receipt_print_state();

-- Reserve the original ordinal for every previously issued receipt, without
-- inventing a dispatch event or altering an already authoritative copy count.
INSERT INTO "pharmacy_receipt_print_states"
  ("id", "organizationId", "branchId", "saleId", "copyCount", "updatedAt")
SELECT 'receipt_print_' || "id", "organizationId", "branchId", "id", 1, NOW()
FROM "pharmacy_sales"
WHERE "receiptNumber" IS NOT NULL
ON CONFLICT ("organizationId", "branchId", "saleId") DO NOTHING;

COMMIT;
