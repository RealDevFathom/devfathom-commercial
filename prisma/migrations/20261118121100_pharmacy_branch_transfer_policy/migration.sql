-- DEV-908: recorded stock transfers between branches of the same owner.
-- organizations.pharmacyBranchTransfersEnabled is the owner's switch for the
-- feature; it defaults to off. pharmacy_interbranch_transfers gains who
-- received the stock at the destination and the premises licence in force at
-- each end when it left, so both sides of a transfer carry a full record.
-- No new table, so row-level security is unchanged.
BEGIN;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "pharmacyBranchTransfersEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "pharmacy_interbranch_transfers"
  ADD COLUMN IF NOT EXISTS "receivedById" TEXT,
  ADD COLUMN IF NOT EXISTS "fromLicenceNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "toLicenceNumber" TEXT;

COMMIT;
