CREATE TYPE "PharmacyGeneralJournalStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED');
CREATE TYPE "PharmacyGeneralJournalPurpose" AS ENUM ('NONTRADE_OPERATING_ACCRUAL');

CREATE TABLE "pharmacy_general_journal_documents" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "purpose" "PharmacyGeneralJournalPurpose" NOT NULL,
  "status" "PharmacyGeneralJournalStatus" NOT NULL DEFAULT 'DRAFT',
  "amountMinor" INTEGER NOT NULL,
  "currency" "Currency" NOT NULL DEFAULT 'PKR',
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "evidence" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createKey" TEXT NOT NULL,
  "createPayloadHash" TEXT NOT NULL,
  "postKey" TEXT,
  "postPayloadHash" TEXT,
  "reverseKey" TEXT,
  "reversePayloadHash" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "postedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "reversedAt" TIMESTAMP(3),
  "journalEntryId" TEXT,
  "reversalEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_general_journal_documents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_general_journal_documents_amount_check" CHECK ("amountMinor" > 0),
  CONSTRAINT "pharmacy_general_journal_documents_occurred_at_check" CHECK ("occurredAt" >= TIMESTAMP '2000-01-01 00:00:00' AND "occurredAt" < TIMESTAMP '2100-01-01 00:00:00'),
  CONSTRAINT "pharmacy_general_journal_documents_evidence_check" CHECK (length(btrim("evidence")) > 0),
  CONSTRAINT "pharmacy_general_journal_documents_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "pharmacy_general_journal_documents_visibility_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_general_journal_documents_entry_fkey" FOREIGN KEY ("organizationId", "journalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_general_journal_documents_reversal_fkey" FOREIGN KEY ("organizationId", "reversalEntryId") REFERENCES "finance_journal_entries"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_general_journal_documents_org_id_key" ON "pharmacy_general_journal_documents"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_general_journal_documents_org_reference_key" ON "pharmacy_general_journal_documents"("organizationId", "reference");
CREATE UNIQUE INDEX "pharmacy_general_journal_documents_org_create_key" ON "pharmacy_general_journal_documents"("organizationId", "createKey");
CREATE INDEX "pharmacy_general_journal_documents_scope_idx" ON "pharmacy_general_journal_documents"("organizationId", "branchId", "status", "occurredAt");

ALTER TABLE "pharmacy_general_journal_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_general_journal_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_general_journal_documents"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

CREATE OR REPLACE FUNCTION prevent_pharmacy_general_journal_posted_mutation() RETURNS trigger AS $$
BEGIN
  IF (OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED', 'REVERSED')) OR
    (OLD.status = 'REVERSED' AND NEW.status <> 'REVERSED') THEN
    RAISE EXCEPTION 'posted pharmacy journal voucher status cannot regress';
  END IF;
  IF OLD.status IN ('POSTED', 'REVERSED') AND (
    NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR
    NEW."branchId" IS DISTINCT FROM OLD."branchId" OR NEW.reference IS DISTINCT FROM OLD.reference OR
    NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor" OR
    NEW.currency IS DISTINCT FROM OLD.currency OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt" OR
    NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.reason IS DISTINCT FROM OLD.reason OR
    NEW."journalEntryId" IS DISTINCT FROM OLD."journalEntryId" OR
    NEW."postedAt" IS DISTINCT FROM OLD."postedAt" OR
    NEW."postKey" IS DISTINCT FROM OLD."postKey" OR
    NEW."postPayloadHash" IS DISTINCT FROM OLD."postPayloadHash" OR
    (OLD.status = 'POSTED' AND NEW.status = 'POSTED' AND (
      NEW."reversalEntryId" IS DISTINCT FROM OLD."reversalEntryId" OR
      NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" OR
      NEW."reverseKey" IS DISTINCT FROM OLD."reverseKey" OR
      NEW."reversePayloadHash" IS DISTINCT FROM OLD."reversePayloadHash"
    )) OR
    (OLD.status = 'REVERSED' AND (
      NEW."reversalEntryId" IS DISTINCT FROM OLD."reversalEntryId" OR
      NEW."reversedAt" IS DISTINCT FROM OLD."reversedAt" OR
      NEW."reverseKey" IS DISTINCT FROM OLD."reverseKey" OR
      NEW."reversePayloadHash" IS DISTINCT FROM OLD."reversePayloadHash"
    ))
  ) THEN RAISE EXCEPTION 'posted pharmacy journal vouchers are immutable'; END IF;

  -- A posted voucher must name its own fixed-shape posting. This also prevents
  -- an arbitrary same-tenant finance entry from being attached to the document.
  IF NEW.status IN ('POSTED', 'REVERSED') AND NOT EXISTS (
    SELECT 1 FROM "finance_journal_entries" entry
    WHERE entry."organizationId" = NEW."organizationId"
      AND entry.id = NEW."journalEntryId"
      AND entry."sourceKind" = 'PHARMACY_JOURNAL_VOUCHER'
      AND entry."sourceId" = NEW.id
      AND entry."branchId" = NEW."branchId"
      AND entry.currency = NEW.currency
      AND entry."occurredAt" = NEW."occurredAt"
      AND entry."reversesEntryId" IS NULL
      AND (SELECT COUNT(*) FROM "finance_journal_lines" line
           WHERE line."organizationId" = NEW."organizationId" AND line."entryId" = entry.id) = 2
      AND EXISTS (SELECT 1 FROM "finance_journal_lines" line
                  WHERE line."organizationId" = NEW."organizationId" AND line."entryId" = entry.id
                    AND line."accountCode" = 'OPERATING_EXPENSE' AND line.side = 'DEBIT'
                    AND line."amountMinor" = NEW."amountMinor" AND line."branchId" = NEW."branchId")
      AND EXISTS (SELECT 1 FROM "finance_journal_lines" line
                  WHERE line."organizationId" = NEW."organizationId" AND line."entryId" = entry.id
                    AND line."accountCode" = 'MANUAL_NONTRADE_ACCRUAL' AND line.side = 'CREDIT'
                    AND line."amountMinor" = NEW."amountMinor" AND line."branchId" = NEW."branchId")
  ) THEN
    RAISE EXCEPTION 'pharmacy journal voucher must link its canonical posting';
  END IF;

  -- The finance journal's unique reversesEntryId index and deferred exact-
  -- negation trigger make this the one canonical additive reversal.
  IF NEW.status = 'REVERSED' AND (
    NEW."reversalEntryId" IS NULL OR NEW."reversedAt" IS NULL OR
    NEW."reverseKey" IS NULL OR NEW."reversePayloadHash" IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM "finance_journal_entries" reversal
      WHERE reversal."organizationId" = NEW."organizationId"
        AND reversal.id = NEW."reversalEntryId"
        AND reversal."reversesEntryId" = NEW."journalEntryId"
        AND reversal."sourceKind" = 'PHARMACY_JOURNAL_VOUCHER'
        AND reversal."sourceId" = NEW.id
    )
  ) THEN
    RAISE EXCEPTION 'pharmacy journal voucher must link its canonical reversal';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_general_journal_posted_immutable" BEFORE UPDATE ON "pharmacy_general_journal_documents"
FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_general_journal_posted_mutation();
