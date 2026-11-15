BEGIN;
ALTER TYPE "PharmacyKhataEventKind" ADD VALUE IF NOT EXISTS 'PAYMENT_REVERSAL';
-- Retain every existing event shape; add a distinct reversal, never a dishonoured cheque.
ALTER TABLE pharmacy_khata_events DROP CONSTRAINT IF EXISTS pharmacy_khata_events_shape_check;
ALTER TABLE pharmacy_khata_events ADD CONSTRAINT pharmacy_khata_events_shape_check CHECK (
  (kind = 'CHARGE' AND "memberId" IS NOT NULL AND "dueAt" IS NOT NULL AND "settlesChargeId" IS NULL) OR
  (kind = 'PAYMENT' AND "memberId" IS NULL AND "dueAt" IS NULL AND "settlesChargeId" IS NOT NULL) OR
  (kind = 'DISHONOURED_CHEQUE' AND "memberId" IS NULL AND "dueAt" IS NULL) OR
  (kind::text = 'PAYMENT_REVERSAL' AND "memberId" IS NULL AND "dueAt" IS NULL AND "settlesChargeId" IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS pharmacy_loyalty_program_versions (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  version INTEGER NOT NULL CHECK (version > 0), mode TEXT NOT NULL CHECK (mode IN ('PERCENT', 'STEP')),
  "rewardPoints" INTEGER NOT NULL CHECK ("rewardPoints" > 0),
  "spendMinor" INTEGER NOT NULL CHECK ("spendMinor" > 0),
  "khataEnabled" BOOLEAN NOT NULL, "actorId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", version),
  CHECK ("rewardPoints"::bigint * 100 <= "spendMinor")
);
CREATE TABLE IF NOT EXISTS pharmacy_loyalty_migrations (
  "organizationId" TEXT PRIMARY KEY, "actorId" TEXT NOT NULL, "sourceCount" INTEGER NOT NULL,
  "sourcePoints" BIGINT NOT NULL, "branchTotals" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pharmacy_loyalty_wallets (
  "organizationId" TEXT NOT NULL, "customerId" TEXT NOT NULL, points BIGINT NOT NULL,
  PRIMARY KEY ("organizationId", "customerId"),
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers("organizationId", id) ON DELETE RESTRICT
);
ALTER TABLE pharmacy_loyalty_points_entries ADD COLUMN IF NOT EXISTS "programVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "collectionId" TEXT, ADD COLUMN IF NOT EXISTS "earnStartMinor" INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pharmacy_loyalty_program_version_fk') THEN
    ALTER TABLE pharmacy_loyalty_points_entries ADD CONSTRAINT pharmacy_loyalty_program_version_fk
      FOREIGN KEY ("organizationId", "programVersionId") REFERENCES pharmacy_loyalty_program_versions("organizationId", id) ON DELETE RESTRICT;
  END IF;
END $$;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_loyalty_program_versions','pharmacy_loyalty_migrations','pharmacy_loyalty_wallets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', t);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pharmacy_loyalty_program_versions','pharmacy_loyalty_migrations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname=t||'_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change()', t||'_immutable', t);
    END IF;
  END LOOP;
END $$;
-- Serialize reconciliation with every posting. Keep all existing ledger RLS policies intact.
CREATE OR REPLACE FUNCTION pharmacy_loyalty_wallet_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pharmacy-loyalty:' || NEW."organizationId", 0));
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION pharmacy_loyalty_wallet_post() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pharmacy_loyalty_migrations WHERE "organizationId"=NEW."organizationId") THEN
    INSERT INTO pharmacy_loyalty_wallets ("organizationId", "customerId", points)
      VALUES (NEW."organizationId", NEW."customerId", NEW.points)
      ON CONFLICT ("organizationId", "customerId") DO UPDATE
        SET points=pharmacy_loyalty_wallets.points + EXCLUDED.points;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pharmacy_loyalty_wallet_lock') THEN
    CREATE TRIGGER pharmacy_loyalty_wallet_lock BEFORE INSERT ON pharmacy_loyalty_points_entries
      FOR EACH ROW EXECUTE FUNCTION pharmacy_loyalty_wallet_lock();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pharmacy_loyalty_wallet_post') THEN
    CREATE TRIGGER pharmacy_loyalty_wallet_post AFTER INSERT ON pharmacy_loyalty_points_entries
      FOR EACH ROW EXECUTE FUNCTION pharmacy_loyalty_wallet_post();
  END IF;
END $$;
-- No rates, wallets, or migration approvals are seeded. Activation is an audited owner action.
COMMIT;
