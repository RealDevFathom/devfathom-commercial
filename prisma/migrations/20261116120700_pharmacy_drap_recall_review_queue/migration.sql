-- DEV-692: DRAP recall alerts land in a review queue. A parsed alert never
-- recalls or quarantines stock by itself; a person confirms (or dismisses) the
-- draft. Adds the DRAP_WEB adapter for the daily recall-alert page fetch and a
-- per-organization daily run marker.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PharmacyDrapReviewStatus') THEN
    CREATE TYPE "PharmacyDrapReviewStatus" AS ENUM ('PENDING_REVIEW','CONFIRMED','DISMISSED');
  END IF;
END $$;

ALTER TABLE "pharmacy_drap_ingests"
  ADD COLUMN IF NOT EXISTS "recallPayload" JSONB,
  ADD COLUMN IF NOT EXISTS "reviewStatus" "PharmacyDrapReviewStatus",
  ADD COLUMN IF NOT EXISTS "reviewedById" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

-- Recalls ingested before the review queue already opened their recall notice
-- and quarantine; record them as confirmed by the person who ingested them.
UPDATE "pharmacy_drap_ingests"
SET "reviewStatus" = 'CONFIRMED',
    "reviewedById" = "ingestedById",
    "reviewedAt" = "createdAt",
    "reviewNote" = 'Confirmed at ingest (before the DEV-692 review queue).'
WHERE "kind" = 'RECALL' AND "recallNoticeId" IS NOT NULL AND "reviewStatus" IS NULL;

UPDATE "pharmacy_drap_ingests"
SET "reviewStatus" = 'PENDING_REVIEW'
WHERE "kind" = 'RECALL' AND "recallNoticeId" IS NULL AND "reviewStatus" IS NULL;

-- The original adapter CHECK was declared inline (system-named); drop it by definition.
DO $$ DECLARE c record; BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"pharmacy_drap_ingests"'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%adapter%'
  LOOP
    EXECUTE format('ALTER TABLE "pharmacy_drap_ingests" DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE "pharmacy_drap_ingests"
  ADD CONSTRAINT "pharmacy_drap_ingests_adapter_check" CHECK ("adapter" IN ('FILE','MANUAL','DRAP_WEB'));

ALTER TABLE "pharmacy_drap_ingests" DROP CONSTRAINT IF EXISTS "pharmacy_drap_ingests_review_check";
ALTER TABLE "pharmacy_drap_ingests"
  ADD CONSTRAINT "pharmacy_drap_ingests_review_check" CHECK (
    ("kind" = 'PRICE' AND "reviewStatus" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL)
    OR ("kind" = 'RECALL' AND "reviewStatus" = 'PENDING_REVIEW'
        AND "recallNoticeId" IS NULL AND "reviewedById" IS NULL AND "reviewedAt" IS NULL)
    OR ("kind" = 'RECALL' AND "reviewStatus" = 'CONFIRMED' AND "recallNoticeId" IS NOT NULL
        AND length(btrim("reviewedById")) > 0 AND "reviewedAt" IS NOT NULL)
    OR ("kind" = 'RECALL' AND "reviewStatus" = 'DISMISSED' AND "recallNoticeId" IS NULL
        AND length(btrim("reviewedById")) > 0 AND "reviewedAt" IS NOT NULL
        AND length(btrim("reviewNote")) > 0)
  );

CREATE INDEX IF NOT EXISTS "pharmacy_drap_ingests_organizationId_kind_reviewStatus_idx"
  ON "pharmacy_drap_ingests"("organizationId", "kind", "reviewStatus");

CREATE TABLE IF NOT EXISTS "pharmacy_drap_recall_feed_runs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "businessDate" DATE NOT NULL,
  "alertsSeen" INTEGER NOT NULL,
  "draftsCreated" INTEGER NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_drap_recall_feed_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_drap_recall_feed_runs_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_drap_recall_feed_runs_count_check" CHECK ("alertsSeen" >= 0 AND "draftsCreated" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_drap_recall_feed_runs_organizationId_businessDate_key"
  ON "pharmacy_drap_recall_feed_runs"("organizationId", "businessDate");

ALTER TABLE "pharmacy_drap_recall_feed_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_drap_recall_feed_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_drap_recall_feed_runs";
CREATE POLICY tenant_isolation ON "pharmacy_drap_recall_feed_runs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
