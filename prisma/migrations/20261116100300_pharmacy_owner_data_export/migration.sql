BEGIN;

-- DEV-93: the owner's full data export ("no lock-in") runs as a platform job.
-- No new table: the job row is the request, its result names the archive, and
-- platform_jobs already keeps its control-plane-only row-level security.
ALTER TYPE "PlatformJobType" ADD VALUE IF NOT EXISTS 'pharmacy.owner.data_export.v1';

COMMIT;
