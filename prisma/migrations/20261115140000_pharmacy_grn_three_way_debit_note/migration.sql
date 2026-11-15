-- DEV-691: GRN <-> purchase order <-> distributor bill three-way match, with a
-- draft debit note a person confirms.
--
-- pharmacy_goods_receipt_lines   + billedPacks, billedBatchNumber,
--                                  billedPrintedExpiry: the distributor bill's
--                                  own line, captured for the match. Nullable;
--                                  nothing is backfilled.
-- PharmacyReceivingExceptionKind + BILLED_SHORTAGE, BATCH_CONFLICT,
--                                  EXPIRY_CONFLICT.
-- pharmacy_receipt_debit_notes   One DRAFT per posted receipt that has a
--                                  claim. Only the decision columns may change,
--                                  once, from DRAFT to CONFIRMED or DISCARDED
--                                  (trigger). Never deleted.
-- pharmacy_receipt_debit_note_lines
--                                  APPEND-ONLY claims, each tied to the match
--                                  exception that justifies it.
--
-- Both new tables carry forced RLS with the pharmacy tenant-plus-optional-branch
-- clause and the app.is_platform_admin control-plane escape. Idempotent.
BEGIN;

ALTER TYPE "PharmacyReceivingExceptionKind" ADD VALUE IF NOT EXISTS 'BILLED_SHORTAGE';
ALTER TYPE "PharmacyReceivingExceptionKind" ADD VALUE IF NOT EXISTS 'BATCH_CONFLICT';
ALTER TYPE "PharmacyReceivingExceptionKind" ADD VALUE IF NOT EXISTS 'EXPIRY_CONFLICT';

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN IF NOT EXISTS "billedPacks" INTEGER,
  ADD COLUMN IF NOT EXISTS "billedBatchNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "billedPrintedExpiry" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "pharmacy_goods_receipt_lines"
    ADD CONSTRAINT "pharmacy_grl_billed_check" CHECK (
      ("billedPacks" IS NULL OR "billedPacks" >= 0) AND
      ("billedBatchNumber" IS NULL OR length(btrim("billedBatchNumber")) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyReceiptDebitNoteStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DISCARDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyReceiptDebitNoteReason" AS ENUM ('BILLED_SHORTAGE', 'PRICE_OVERCHARGE', 'WRONG_ITEM');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_receipt_debit_notes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "goodsReceiptId" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "status" "PharmacyReceiptDebitNoteStatus" NOT NULL DEFAULT 'DRAFT',
  "totalMinor" INTEGER NOT NULL,
  "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "decidedByUserId" TEXT,
  "decisionNote" TEXT,
  CONSTRAINT "pharmacy_receipt_debit_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_rdn_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_rdn_org_receipt_key" UNIQUE ("organizationId", "goodsReceiptId"),
  CONSTRAINT "pharmacy_rdn_receipt_fkey"
    FOREIGN KEY ("organizationId", "branchId", "goodsReceiptId")
    REFERENCES "pharmacy_goods_receipts" ("organizationId", "branchId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_rdn_supplier_fkey"
    FOREIGN KEY ("organizationId", "supplierId")
    REFERENCES "pharmacy_suppliers" ("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_rdn_identity_check" CHECK (
    length(btrim("branchId")) > 0 AND length(btrim("goodsReceiptId")) > 0 AND
    length(btrim("supplierId")) > 0
  ),
  CONSTRAINT "pharmacy_rdn_total_check" CHECK ("totalMinor" > 0),
  CONSTRAINT "pharmacy_rdn_decision_check" CHECK (
    ("status" = 'DRAFT' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL AND "decisionNote" IS NULL)
    OR ("status" <> 'DRAFT' AND "decidedAt" IS NOT NULL AND "decidedByUserId" IS NOT NULL
        AND length(btrim("decidedByUserId")) > 0
        AND ("decisionNote" IS NULL OR length("decisionNote") <= 1000))
  )
);
CREATE INDEX IF NOT EXISTS "pharmacy_rdn_org_branch_status_idx"
  ON "pharmacy_receipt_debit_notes" ("organizationId", "branchId", "status", "raisedAt");

CREATE TABLE IF NOT EXISTS "pharmacy_receipt_debit_note_lines" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "debitNoteId" TEXT NOT NULL,
  "receivingExceptionId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "reason" "PharmacyReceiptDebitNoteReason" NOT NULL,
  "detail" TEXT NOT NULL,
  "packs" INTEGER NOT NULL,
  "pricePerPackMinor" INTEGER NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_debit_note_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_rdnl_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_rdnl_org_note_line_key" UNIQUE ("organizationId", "debitNoteId", "lineNumber"),
  CONSTRAINT "pharmacy_rdnl_note_fkey"
    FOREIGN KEY ("organizationId", "debitNoteId")
    REFERENCES "pharmacy_receipt_debit_notes" ("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_rdnl_exception_fkey"
    FOREIGN KEY ("organizationId", "receivingExceptionId")
    REFERENCES "pharmacy_receiving_exceptions" ("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_rdnl_identity_check" CHECK (
    length(btrim("branchId")) > 0 AND length(btrim("detail")) > 0
  ),
  CONSTRAINT "pharmacy_rdnl_money_check" CHECK (
    "lineNumber" > 0 AND "packs" > 0 AND "pricePerPackMinor" > 0 AND "amountMinor" > 0
  )
);
CREATE INDEX IF NOT EXISTS "pharmacy_rdnl_org_exception_idx"
  ON "pharmacy_receipt_debit_note_lines" ("organizationId", "receivingExceptionId");

-- The claim is computed once, from recorded numbers. A person confirms or
-- discards it; nobody edits the amount on the way.
CREATE OR REPLACE FUNCTION pharmacy_assert_receipt_debit_note_decision_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
     OR NEW."goodsReceiptId" IS DISTINCT FROM OLD."goodsReceiptId"
     OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
     OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
     OR NEW."raisedAt" IS DISTINCT FROM OLD."raisedAt" THEN
    RAISE EXCEPTION 'a receipt debit note may only be confirmed or discarded, not rewritten' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'a decided receipt debit note cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_receipt_debit_note_decision_only ON "pharmacy_receipt_debit_notes";
CREATE TRIGGER pharmacy_receipt_debit_note_decision_only
BEFORE UPDATE ON "pharmacy_receipt_debit_notes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_receipt_debit_note_decision_only();

CREATE OR REPLACE FUNCTION pharmacy_reject_receipt_debit_note_line_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receipt debit note lines are append-only' USING ERRCODE = '23514';
END $$;
DROP TRIGGER IF EXISTS pharmacy_receipt_debit_note_lines_append_only ON "pharmacy_receipt_debit_note_lines";
CREATE TRIGGER pharmacy_receipt_debit_note_lines_append_only
BEFORE UPDATE ON "pharmacy_receipt_debit_note_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_receipt_debit_note_line_change();

DROP TRIGGER IF EXISTS pharmacy_receipt_debit_notes_no_delete ON "pharmacy_receipt_debit_notes";
CREATE TRIGGER pharmacy_receipt_debit_notes_no_delete BEFORE DELETE ON "pharmacy_receipt_debit_notes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
DROP TRIGGER IF EXISTS pharmacy_receipt_debit_note_lines_no_delete ON "pharmacy_receipt_debit_note_lines";
CREATE TRIGGER pharmacy_receipt_debit_note_lines_no_delete BEFORE DELETE ON "pharmacy_receipt_debit_note_lines"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

-- ── Row level security ──────────────────────────────────────────────────────
ALTER TABLE "pharmacy_receipt_debit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_receipt_debit_notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_receipt_debit_notes";
CREATE POLICY tenant_branch_isolation ON "pharmacy_receipt_debit_notes"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );

ALTER TABLE "pharmacy_receipt_debit_note_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_receipt_debit_note_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation_select ON "pharmacy_receipt_debit_note_lines";
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_receipt_debit_note_lines" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );
DROP POLICY IF EXISTS tenant_branch_isolation_insert ON "pharmacy_receipt_debit_note_lines";
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_receipt_debit_note_lines" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );

COMMIT;
