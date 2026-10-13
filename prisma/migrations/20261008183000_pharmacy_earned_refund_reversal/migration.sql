-- Additive: existing entries, point curve, RLS and append-only trigger are unchanged.
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'EARN_REVERSAL';
ALTER TABLE pharmacy_loyalty_points_entries
  DROP CONSTRAINT pharmacy_loyalty_points_entries_sign_check,
  ADD CONSTRAINT pharmacy_loyalty_points_entries_sign_check CHECK (
    ("kind"::text = 'EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NULL AND "refundId" IS NULL) OR
    ("kind"::text = 'REDEEM' AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL) OR
    ("kind"::text = 'REFUND' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL) OR
    ("kind"::text = 'EARN_REVERSAL' AND "points" < 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NOT NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL)
  );
