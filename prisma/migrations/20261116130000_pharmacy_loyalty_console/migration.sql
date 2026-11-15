BEGIN;

-- DEV-764: pharmacy loyalty owner console. Additive only: no existing points entry or program
-- version is updated or deleted, so every customer balance (the sum of its entries) is exactly
-- what it was before this migration.

-- New ledger kinds. A new enum value cannot be used in the transaction that adds it, so the
-- checks below compare "kind" as text.
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'EXPIRY';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'REDEMPTION_RELEASE';

-- Program versions now also carry the redemption value, the expiry period and the owner's khata
-- switch. Existing versions keep today's behaviour: 1 point redeems for PKR 1 (100 minor),
-- points never expire, and khata purchases earn once paid off (DEV-746).
ALTER TABLE "pharmacy_loyalty_program_versions"
  ADD COLUMN IF NOT EXISTS "redemptionValueMinor" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "expiryDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "khataEarns" BOOLEAN NOT NULL DEFAULT true;

-- A rule may never pay back more than the money spent, at the version's own redemption value.
-- Existing rows all have redemptionValueMinor = 100, so they satisfy the new check exactly as
-- they satisfied the old one.
ALTER TABLE "pharmacy_loyalty_program_versions"
  DROP CONSTRAINT IF EXISTS "pharmacy_loyalty_program_versions_rule_check",
  ADD CONSTRAINT "pharmacy_loyalty_program_versions_rule_check" CHECK (
    "version" > 0 AND "earnPoints" > 0 AND "perSpendMinor" > 0 AND
    "redemptionValueMinor" BETWEEN 1 AND 100000 AND
    ("expiryDays" IS NULL OR "expiryDays" BETWEEN 1 AND 3650) AND
    "earnPoints"::bigint * "redemptionValueMinor"::bigint <= "perSpendMinor"::bigint
  );

-- Adjustments and expiries are not tied to a sale. Every earlier kind still requires one (below).
ALTER TABLE "pharmacy_loyalty_points_entries"
  ALTER COLUMN "saleId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reversesEntryId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_loyalty_points_entries_reverses_fkey'
  ) THEN
    ALTER TABLE "pharmacy_loyalty_points_entries"
      ADD CONSTRAINT "pharmacy_loyalty_points_entries_reverses_fkey"
      FOREIGN KEY ("organizationId", "reversesEntryId")
      REFERENCES "pharmacy_loyalty_points_entries" ("organizationId", "id") ON DELETE RESTRICT;
  END IF;
END $$;

-- One expiry per earned lot; also how the expiry job finds lots it has not closed yet. Only an
-- EXPIRY entry may name a lot (sign check below), so the predicate needs no enum comparison:
-- an index predicate must be immutable, and an enum-to-text cast is not.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_loyalty_points_entries_expiry_lot_key"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "reversesEntryId")
  WHERE "reversesEntryId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "pharmacy_loyalty_points_entries_expires_idx"
  ON "pharmacy_loyalty_points_entries" ("expiresAt")
  WHERE "expiresAt" IS NOT NULL;

-- Every earlier shape is kept, now also requiring its sale. New shapes:
--  ADJUSTMENT: an owner or manager correction, signed, never zero, with a written reason.
--  EXPIRY: closes one earned lot (reversesEntryId, which no other kind may set); takes its
--  remaining points, possibly none.
--  REDEMPTION_RELEASE: returns the points of a redemption tender on a voided sale.
ALTER TABLE "pharmacy_loyalty_points_entries"
  DROP CONSTRAINT IF EXISTS pharmacy_loyalty_points_entries_sign_check,
  ADD CONSTRAINT pharmacy_loyalty_points_entries_sign_check CHECK (
    ("kind"::text = 'EARN' AND "saleId" IS NOT NULL AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL AND "reversesEntryId" IS NULL) OR
    ("kind"::text = 'REDEEM' AND "saleId" IS NOT NULL AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NULL) OR
    ("kind"::text = 'REFUND' AND "saleId" IS NOT NULL AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NULL) OR
    ("kind"::text = 'EARN_REVERSAL' AND "saleId" IS NOT NULL AND "points" < 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NOT NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NULL) OR
    ("kind"::text = 'KHATA_EARN' AND "saleId" IS NOT NULL AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" > 0 AND "earnStartMinor" >= 0 AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "programVersionId" IS NOT NULL AND "reversesEntryId" IS NULL) OR
    ("kind"::text = 'ADJUSTMENT' AND "saleId" IS NULL AND "points" <> 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NULL AND length(btrim("reason")) BETWEEN 3 AND 500) OR
    ("kind"::text = 'EXPIRY' AND "saleId" IS NULL AND "points" <= 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NOT NULL) OR
    ("kind"::text = 'REDEMPTION_RELEASE' AND "saleId" IS NOT NULL AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL AND "expiresAt" IS NULL AND "reversesEntryId" IS NULL)
  );

-- One release per redemption tender: its idempotency key is loyalty:release:<tenderId>, and
-- (organizationId, idempotencyKey) is already unique.

COMMIT;
