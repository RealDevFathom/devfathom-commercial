BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TYPE "PharmacyKhataEventKind" ADD VALUE IF NOT EXISTS 'OPENING_DEBIT';
ALTER TYPE "PharmacyKhataEventKind" ADD VALUE IF NOT EXISTS 'OPENING_CREDIT';
ALTER TABLE pharmacy_khata_events DROP CONSTRAINT IF EXISTS pharmacy_khata_events_shape_check;
ALTER TABLE pharmacy_khata_events ADD CONSTRAINT pharmacy_khata_events_shape_check CHECK (
  (kind='CHARGE' AND "memberId" IS NOT NULL AND "dueAt" IS NOT NULL AND "settlesChargeId" IS NULL) OR
  (kind='PAYMENT' AND "memberId" IS NULL AND "dueAt" IS NULL AND "settlesChargeId" IS NOT NULL) OR
  (kind='DISHONOURED_CHEQUE' AND "memberId" IS NULL AND "dueAt" IS NULL) OR
  (kind::text IN ('OPENING_DEBIT','OPENING_CREDIT') AND "memberId" IS NOT NULL AND "dueAt" IS NULL AND "settlesChargeId" IS NULL)
);
CREATE TABLE IF NOT EXISTS pharmacy_abuzar_openings (
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "sourceBranch" text NOT NULL,
  step text NOT NULL CHECK (step IN ('stock','balances')),
  "sourceId" text NOT NULL,
  "rowHash" text NOT NULL CHECK ("rowHash" ~ '^[a-f0-9]{64}$'),
  "openingLineId" text,
  "ledgerEntryId" text,
  "partyId" text,
  "unverifiedBatch" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("organizationId","sourceBranch",step,"sourceId"),
  UNIQUE ("organizationId","openingLineId"),
  UNIQUE ("organizationId","ledgerEntryId"),
  UNIQUE ("organizationId","branchId","partyId"),
  CHECK ((step='stock' AND "openingLineId" IS NOT NULL AND "ledgerEntryId" IS NULL AND "partyId" IS NULL)
      OR (step='balances' AND "ledgerEntryId" IS NOT NULL AND "openingLineId" IS NULL AND "partyId" IS NOT NULL AND NOT "unverifiedBatch")),
  FOREIGN KEY ("organizationId","branchId") REFERENCES pharmacy_branches("organizationId",id),
  FOREIGN KEY ("organizationId","openingLineId") REFERENCES pharmacy_opening_stock_lines("organizationId",id),
  FOREIGN KEY ("organizationId","ledgerEntryId") REFERENCES pharmacy_opening_ledger_entries("organizationId",id),
  FOREIGN KEY ("organizationId","partyId") REFERENCES pharmacy_abuzar_parties("organizationId","sourceId")
);
ALTER TABLE pharmacy_abuzar_openings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_abuzar_openings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='pharmacy_abuzar_openings'::regclass AND polname='tenant_read') THEN
    CREATE POLICY tenant_read ON pharmacy_abuzar_openings FOR SELECT USING
      ("organizationId"=nullif(current_setting('app.current_organization_id',true),''));
  END IF;
  IF NOT EXISTS (SELECT FROM pg_policy WHERE polrelid='pharmacy_abuzar_openings'::regclass AND polname='tenant_append') THEN
    CREATE POLICY tenant_append ON pharmacy_abuzar_openings FOR INSERT WITH CHECK
      ("organizationId"=nullif(current_setting('app.current_organization_id',true),''));
  END IF;
END $$;
COMMIT;
