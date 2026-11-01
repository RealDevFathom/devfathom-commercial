-- Give each RUNNING scheduler claim a non-reusable generation identity. Existing
-- claims cannot be safely settled after deployment and will be lease-recovered.
ALTER TABLE "restaurant_jobs" ADD COLUMN "claimToken" TEXT;
