-- Loyalty 3/6: configurable category earning, redemption floor, tiers and expiry.
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'EXPIRE';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'REVERSAL';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'ADJUST';

ALTER TABLE "pharmacy_loyalty_settings"
  ADD COLUMN "medicineEarnPoints" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "nonDrugEarnPoints" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "earnBlockMinor" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN "pointValueMinor" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "minimumRedemptionPoints" INTEGER NOT NULL DEFAULT 200,
  ADD COLUMN "pointsExpiryMonths" INTEGER NOT NULL DEFAULT 6,
  ADD COLUMN "goldTierEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "goldTierThresholdMinor" INTEGER NOT NULL DEFAULT 5000000,
  ADD COLUMN "goldTierMultiplier" INTEGER NOT NULL DEFAULT 2,
  ADD CONSTRAINT "pharmacy_loyalty_settings_points_check" CHECK (
    "medicineEarnPoints" >= 0 AND "nonDrugEarnPoints" >= 0 AND
    "earnBlockMinor" > 0 AND "pointValueMinor" > 0 AND
    "minimumRedemptionPoints" > 0 AND "pointsExpiryMonths" > 0 AND
    "goldTierThresholdMinor" >= 0 AND "goldTierMultiplier" >= 1
  );

ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "sourceEntryId" TEXT;
CREATE INDEX "pharmacy_loyalty_points_entries_expiry_idx"
  ON "pharmacy_loyalty_points_entries" ("organizationId", "branchId", "customerId", "expiresAt");

-- Preserve the append-only ledger while admitting the new signed event kinds.
ALTER TABLE "pharmacy_loyalty_points_entries"
  DROP CONSTRAINT IF EXISTS "pharmacy_loyalty_points_entries_sign_check";
ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD CONSTRAINT "pharmacy_loyalty_points_entries_sign_check" CHECK (
    ("kind" = 'EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NULL AND "refundId" IS NULL) OR
    ("kind" = 'REDEEM' AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL) OR
    ("kind" = 'REFUND' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL) OR
    ("kind" IN ('EARN_REVERSAL','EXPIRE','REVERSAL') AND "points" < 0) OR
    ("kind" = 'ADJUST' AND "points" <> 0)
  );
