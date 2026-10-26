-- Record that an approved resignation's scheduled offboarding has been applied.
-- This prevents a historical resignation from deactivating a deliberately
-- reactivated user on a later worker run.
ALTER TABLE "resignations" ADD COLUMN "offboardedAt" TIMESTAMP(3);
