-- DEV-927: Marg and Tally imports treat a blank batch or expiry as "not recorded"
-- (no exception, stock stays sellable). A known expiry that has passed is still
-- refused, under its own BLOCKING bucket. Additive and idempotent.
BEGIN;
ALTER TYPE "PharmacyMigrationExceptionBucket" ADD VALUE IF NOT EXISTS 'EXPIRED_STOCK';
COMMIT;
