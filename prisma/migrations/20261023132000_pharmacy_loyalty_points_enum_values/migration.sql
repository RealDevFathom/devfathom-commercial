-- Commit new enum values before constraints in the following migration reference them.
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'EXPIRE';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'REVERSAL';
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'ADJUST';
