-- DEV-690: bonus-scheme check at goods-in. A missing free-unit delivery and a
-- lapsed distributor scheme become their own GRN review exceptions.
BEGIN;

ALTER TYPE "PharmacyReceivingExceptionKind" ADD VALUE IF NOT EXISTS 'BONUS_SHORTAGE';
ALTER TYPE "PharmacyReceivingExceptionKind" ADD VALUE IF NOT EXISTS 'SCHEME_EXPIRED';

COMMIT;
