-- Loyalty 3/6: configurable category earning, redemption floor, tiers and expiry.
-- The EXPIRE/REVERSAL/ADJUST enum values were committed by 20261023132000, so the
-- constraints below may name them.

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

-- Source lots (docs/loyalty-3.md): a lot is an EARN or a positive ADJUST. EXPIRE and
-- REVERSAL debit one named lot, which must be an entry of the same tenant, branch and
-- customer; EARN_REVERSAL may name the EARN it reverses.
ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD CONSTRAINT "pharmacy_loyalty_points_entries_lot_key"
    UNIQUE ("organizationId", "branchId", "customerId", "id"),
  ADD CONSTRAINT "pharmacy_loyalty_points_entries_source_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "customerId", "sourceEntryId")
    REFERENCES "pharmacy_loyalty_points_entries" ("organizationId", "branchId", "customerId", "id")
    ON DELETE RESTRICT;

-- One shape per kind, so a malformed ledger event cannot be stored. Existing rows
-- (EARN, REDEEM, REFUND, EARN_REVERSAL) already satisfy their unchanged shapes; an
-- earning row must carry an expiry only when it is written from now on (below).
ALTER TABLE "pharmacy_loyalty_points_entries"
  DROP CONSTRAINT IF EXISTS "pharmacy_loyalty_points_entries_sign_check";
ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD CONSTRAINT "pharmacy_loyalty_points_entries_sign_check" CHECK (
    ("kind" = 'EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0
      AND "tenderId" IS NULL AND "refundId" IS NULL AND "sourceEntryId" IS NULL) OR
    ("kind" = 'REDEEM' AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL
      AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "sourceEntryId" IS NULL
      AND "expiresAt" IS NULL) OR
    ("kind" = 'REFUND' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL
      AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL AND "sourceEntryId" IS NULL
      AND "expiresAt" IS NULL) OR
    ("kind" = 'EARN_REVERSAL' AND "points" < 0 AND "requestedPoints" IS NULL
      AND "netPaidMinor" IS NOT NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NOT NULL
      AND "refundId" IS NOT NULL AND "expiresAt" IS NULL) OR
    ("kind" IN ('EXPIRE', 'REVERSAL') AND "points" < 0 AND "sourceEntryId" IS NOT NULL
      AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NULL
      AND "refundId" IS NULL AND "expiresAt" IS NULL) OR
    ("kind" = 'ADJUST' AND "points" <> 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL
      AND "tenderId" IS NULL AND "refundId" IS NULL AND "sourceEntryId" IS NULL
      AND (("points" > 0 AND "expiresAt" IS NOT NULL) OR ("points" < 0 AND "expiresAt" IS NULL)))
  );

-- Points expire six calendar months after earning by default: every EARN written from
-- now on carries its expiry. NOT VALID leaves earlier awards, earned before expiry
-- existed, as non-expiring rather than expiring them retroactively.
ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD CONSTRAINT "pharmacy_loyalty_points_entries_earn_expiry_check"
    CHECK ("kind" <> 'EARN' OR "expiresAt" IS NOT NULL) NOT VALID;
