-- DEV-773: fractional bills freeze per-unit tax buckets keyed by their source order
-- item, so settlement can record per-tender tax facts and refunds can reverse them.
-- Additive and idempotent: existing rows keep their kinds and a NULL source item.
BEGIN;

ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  ADD COLUMN IF NOT EXISTS "sourceOrderItemId" TEXT;

ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  DROP CONSTRAINT IF EXISTS "restaurant_tax_bucket_evidence_version_ck";
ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  ADD CONSTRAINT "restaurant_tax_bucket_evidence_version_ck"
    CHECK (
      ("evidenceVersion" = 0 AND "allocationKind" IS NULL
       AND "billLineId" IS NULL AND "sourceOrderItemId" IS NULL AND "unitOrdinal" IS NULL)
      OR
      ("evidenceVersion" = 1
       AND "allocationKind" IN ('MERCHANDISE', 'FRACTIONAL_MERCHANDISE', 'SERVICE_CHARGE')
       AND (("allocationKind" = 'MERCHANDISE' AND "billLineId" IS NOT NULL
             AND "sourceOrderItemId" IS NULL
             AND "unitOrdinal" IS NOT NULL AND "unitOrdinal" >= 0)
            OR ("allocationKind" = 'FRACTIONAL_MERCHANDISE' AND "billLineId" IS NULL
                AND "sourceOrderItemId" IS NOT NULL
                AND "unitOrdinal" IS NOT NULL AND "unitOrdinal" >= 0)
            OR ("allocationKind" = 'SERVICE_CHARGE' AND "billLineId" IS NULL
                AND "sourceOrderItemId" IS NULL AND "unitOrdinal" IS NULL)))
    );

-- Fractional buckets have no bill line, so the source order item joins the v1 key.
DROP INDEX IF EXISTS "restaurant_tax_bucket_v1_allocation_key";
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tax_bucket_v1_allocation_key"
  ON "restaurant_tax_rate_bucket_snapshots"(
    "snapshotId", "billLineId", "sourceOrderItemId", "unitOrdinal", "ruleVersionId",
    "paymentCategory", "allocationKind"
  ) NULLS NOT DISTINCT
  WHERE "evidenceVersion" = 1;

ALTER TABLE "restaurant_tax_rate_bucket_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_rate_bucket_snapshots" FORCE ROW LEVEL SECURITY;

COMMIT;
