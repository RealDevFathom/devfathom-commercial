-- CEO-JVCORE-20261025: pharmacy general-journal voucher documents.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyJournalVoucherPurpose" AS ENUM ('NONTRADE_OPERATING_ACCRUAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyJournalVoucherStatus" AS ENUM ('DRAFT', 'CANCELLED', 'POSTED', 'REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_journal_vouchers" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "purpose" "PharmacyJournalVoucherPurpose" NOT NULL,
  "status" "PharmacyJournalVoucherStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "currency" "Currency" NOT NULL DEFAULT 'PKR',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "createKey" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3),
  "postedByUserId" TEXT,
  "postCommandKey" TEXT,
  "postPayloadHash" TEXT,
  "journalEntryId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "cancelledByUserId" TEXT,
  "cancelReason" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reversedByUserId" TEXT,
  "reversalReason" TEXT,
  "reverseCommandKey" TEXT,
  "reversePayloadHash" TEXT,
  "reversalEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_journal_vouchers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_journal_vouchers_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_journal_vouchers_entry_fkey" FOREIGN KEY ("organizationId", "journalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_journal_vouchers_reversal_fkey" FOREIGN KEY ("organizationId", "reversalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_journal_vouchers_version_check" CHECK ("version" >= 1),
  CONSTRAINT "pharmacy_journal_vouchers_text_check" CHECK (
    length(btrim("reference")) BETWEEN 1 AND 80
    AND length(btrim("reason")) BETWEEN 1 AND 500
    AND length(btrim("evidenceReference")) BETWEEN 1 AND 160
  ),
  CONSTRAINT "pharmacy_journal_vouchers_state_check" CHECK (
    ("status" = 'DRAFT' AND "journalEntryId" IS NULL AND "reversalEntryId" IS NULL AND "cancelledAt" IS NULL)
    OR ("status" = 'CANCELLED' AND "journalEntryId" IS NULL AND "cancelledAt" IS NOT NULL AND "cancelReason" IS NOT NULL)
    OR ("status" = 'POSTED' AND "journalEntryId" IS NOT NULL AND "postCommandKey" IS NOT NULL AND "reversalEntryId" IS NULL)
    OR ("status" = 'REVERSED' AND "journalEntryId" IS NOT NULL AND "reversalEntryId" IS NOT NULL AND "reverseCommandKey" IS NOT NULL AND "reversalReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_id_key" ON "pharmacy_journal_vouchers"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_branch_id_key" ON "pharmacy_journal_vouchers"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_reference_key" ON "pharmacy_journal_vouchers"("organizationId", "reference");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_create_key" ON "pharmacy_journal_vouchers"("organizationId", "createKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_post_command_key" ON "pharmacy_journal_vouchers"("organizationId", "postCommandKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_reverse_command_key" ON "pharmacy_journal_vouchers"("organizationId", "reverseCommandKey");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_entry_key" ON "pharmacy_journal_vouchers"("organizationId", "journalEntryId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_org_reversal_entry_key" ON "pharmacy_journal_vouchers"("organizationId", "reversalEntryId");
CREATE INDEX IF NOT EXISTS "pharmacy_jv_org_branch_status_idx" ON "pharmacy_journal_vouchers"("organizationId", "branchId", "status", "occurredAt");

CREATE TABLE IF NOT EXISTS "pharmacy_journal_voucher_lines" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "voucherId" TEXT NOT NULL,
  "lineNumber" INTEGER NOT NULL,
  "accountCode" "FinanceAccountCode" NOT NULL,
  "side" "FinanceJournalSide" NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "memo" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_journal_voucher_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_journal_voucher_lines_voucher_fkey" FOREIGN KEY ("organizationId", "branchId", "voucherId") REFERENCES "pharmacy_journal_vouchers"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_journal_voucher_lines_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_journal_voucher_lines_number_check" CHECK ("lineNumber" >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_jv_lines_org_voucher_line_key" ON "pharmacy_journal_voucher_lines"("organizationId", "voucherId", "lineNumber");
CREATE INDEX IF NOT EXISTS "pharmacy_jv_lines_org_branch_voucher_idx" ON "pharmacy_journal_voucher_lines"("organizationId", "branchId", "voucherId");

-- Vouchers are never deleted, and a voucher that has left DRAFT keeps its
-- financial identity: only the forward lifecycle columns may change.
CREATE OR REPLACE FUNCTION guard_pharmacy_journal_voucher()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy journal vouchers cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId"
     OR OLD."branchId" IS DISTINCT FROM NEW."branchId"
     OR OLD."createKey" IS DISTINCT FROM NEW."createKey" THEN
    RAISE EXCEPTION 'pharmacy journal voucher identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'pharmacy journal voucher % is final', OLD."id" USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'POSTED' AND (
       NEW."status" <> 'REVERSED'
       OR OLD."reference" IS DISTINCT FROM NEW."reference"
       OR OLD."purpose" IS DISTINCT FROM NEW."purpose"
       OR OLD."version" IS DISTINCT FROM NEW."version"
       OR OLD."currency" IS DISTINCT FROM NEW."currency"
       OR OLD."occurredAt" IS DISTINCT FROM NEW."occurredAt"
       OR OLD."reason" IS DISTINCT FROM NEW."reason"
       OR OLD."evidenceReference" IS DISTINCT FROM NEW."evidenceReference"
       OR OLD."journalEntryId" IS DISTINCT FROM NEW."journalEntryId"
       OR OLD."postCommandKey" IS DISTINCT FROM NEW."postCommandKey"
       OR OLD."postPayloadHash" IS DISTINCT FROM NEW."postPayloadHash"
     ) THEN
    RAISE EXCEPTION 'posted pharmacy journal voucher % is immutable', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_journal_vouchers_guard ON "pharmacy_journal_vouchers";
CREATE TRIGGER pharmacy_journal_vouchers_guard
BEFORE UPDATE OR DELETE ON "pharmacy_journal_vouchers"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_journal_voucher();

-- Voucher lines change only while their voucher is a DRAFT.
CREATE OR REPLACE FUNCTION guard_pharmacy_journal_voucher_line()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  voucher_status "PharmacyJournalVoucherStatus";
  row_org TEXT := COALESCE(NEW."organizationId", OLD."organizationId");
  row_voucher TEXT := COALESCE(NEW."voucherId", OLD."voucherId");
BEGIN
  SELECT "status" INTO voucher_status FROM "pharmacy_journal_vouchers"
    WHERE "organizationId" = row_org AND "id" = row_voucher;
  IF voucher_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'pharmacy journal voucher lines are immutable outside DRAFT' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_journal_voucher_lines_guard ON "pharmacy_journal_voucher_lines";
CREATE TRIGGER pharmacy_journal_voucher_lines_guard
BEFORE INSERT OR UPDATE OR DELETE ON "pharmacy_journal_voucher_lines"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_journal_voucher_line();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_journal_vouchers', 'pharmacy_journal_voucher_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_branch_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true)))) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = current_setting(''app.current_branch_id'', true))))',
      table_name
    );
  END LOOP;
END $$;

COMMIT;
