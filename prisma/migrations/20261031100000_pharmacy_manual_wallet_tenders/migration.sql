-- Phase 1 is manual evidence capture, never a provider/API approval.
ALTER TYPE "PharmacyTenderType" ADD VALUE 'RAAST';
ALTER TYPE "PharmacyTenderType" ADD VALUE 'JAZZCASH';
ALTER TYPE "PharmacyTenderType" ADD VALUE 'EASYPAISA';
ALTER TYPE "PharmacyOfflineAction" ADD VALUE 'MANUAL_OTC_SALE';
ALTER TABLE pharmacy_branches
  ADD COLUMN "manualPaymentSettings" JSONB,
  ADD COLUMN "manualPaymentRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pharmacy_tenders
  ADD COLUMN "payerName" TEXT,
  ADD COLUMN "referenceSkipped" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pharmacy_daily_closes ADD COLUMN "tenderTotals" JSONB;
-- Text comparisons avoid using a newly-added enum value in this migration's transaction.
-- Existing tender constraints, append-only guards, and RLS remain in force.
ALTER TABLE pharmacy_tenders ADD CONSTRAINT pharmacy_manual_tender_capture_check CHECK (
  type::text NOT IN ('RAAST', 'JAZZCASH', 'EASYPAISA') OR (
    "payerName" IS NOT NULL AND length(btrim("payerName")) BETWEEN 1 AND 100
    AND provider IS NOT NULL AND provider = 'MANUAL_MERCHANT'
    AND (("referenceSkipped" AND "providerRef" IS NULL)
      OR (NOT "referenceSkipped" AND "providerRef" IS NOT NULL AND "providerRef" ~ '^[0-9]{4,6}$'))
  )
);

-- Reuse statement reconciliation for already-posted POS receipts. Exactly one
-- target is still mandatory; the existing transaction FK and uniqueness remain.
ALTER TABLE pharmacy_bank_reconciliations
  ADD COLUMN "settlementBatchId" TEXT,
  ALTER COLUMN "transactionId" DROP NOT NULL;
ALTER TABLE pharmacy_bank_reconciliations
  ADD CONSTRAINT pharmacy_bank_reconciliation_target_check CHECK (
    ("transactionId" IS NOT NULL AND "settlementBatchId" IS NULL) OR
    ("transactionId" IS NULL AND "settlementBatchId" IS NOT NULL)
  ),
  ADD CONSTRAINT pharmacy_bank_reconciliations_settlement_fkey
    FOREIGN KEY ("organizationId", "settlementBatchId")
    REFERENCES pharmacy_settlement_batches ("organizationId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX pharmacy_bank_reconciliations_org_line_batch_key
  ON pharmacy_bank_reconciliations ("organizationId", "statementLineId", "settlementBatchId");
CREATE INDEX pharmacy_bank_reconciliations_org_batch_idx
  ON pharmacy_bank_reconciliations ("organizationId", "settlementBatchId");

-- Policy is enforced at insertion too, including direct database callers.
CREATE FUNCTION pharmacy_check_manual_tender_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings JSONB;
BEGIN
  IF NEW.type::text IN ('RAAST', 'JAZZCASH', 'EASYPAISA') THEN
    SELECT "manualPaymentSettings" INTO settings FROM pharmacy_branches
      WHERE id = NEW."branchId" AND "organizationId" = NEW."organizationId" AND active
      FOR SHARE;
    IF settings -> NEW.type::text IS NULL OR settings -> NEW.type::text = 'null'::jsonb THEN
      RAISE EXCEPTION 'manual merchant tender is not configured for this branch' USING ERRCODE = '23514';
    END IF;
    IF NEW."referenceSkipped" AND
       COALESCE(settings -> NEW.type::text ->> 'allowReferenceSkip', 'false') <> 'true' THEN
      RAISE EXCEPTION 'manual merchant tender reference is required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_manual_tender_policy_before_insert
  BEFORE INSERT ON pharmacy_tenders FOR EACH ROW EXECUTE FUNCTION pharmacy_check_manual_tender_policy();
