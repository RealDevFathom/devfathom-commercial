-- WHA-330: additive, legacy-compatible settlement replay and per-unit evidence.
-- Existing rows remain version 0; this migration performs no backfill.

ALTER TABLE "restaurant_money_idempotency_keys"
  ADD COLUMN "canonicalPayloadHash" TEXT,
  ADD COLUMN "resultPayload" JSONB,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD CONSTRAINT "restaurant_money_idempotency_payload_hash_ck"
    CHECK ("canonicalPayloadHash" IS NULL OR "canonicalPayloadHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "restaurant_money_idempotency_finalized_ck"
    CHECK (
      ("resultPayload" IS NULL AND "completedAt" IS NULL)
      OR ("canonicalPayloadHash" IS NOT NULL AND "resultRef" IS NOT NULL
          AND "resultPayload" IS NOT NULL AND "completedAt" IS NOT NULL)
    );

CREATE FUNCTION guard_restaurant_money_idempotency_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money idempotency record is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD."resultRef" IS NULL AND OLD."resultPayload" IS NULL AND OLD."completedAt" IS NULL
     AND (to_jsonb(NEW) - ARRAY['resultRef', 'resultPayload', 'completedAt', 'updatedAt'])
         = (to_jsonb(OLD) - ARRAY['resultRef', 'resultPayload', 'completedAt', 'updatedAt'])
     AND (
       (OLD."canonicalPayloadHash" IS NULL AND NEW."resultRef" IS NOT NULL
        AND NEW."resultPayload" IS NULL AND NEW."completedAt" IS NULL)
       OR
       (OLD."canonicalPayloadHash" IS NOT NULL AND NEW."resultRef" IS NOT NULL
        AND NEW."resultPayload" IS NOT NULL AND NEW."completedAt" IS NOT NULL)
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'money idempotency record is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER restaurant_money_idempotency_immutable
BEFORE UPDATE OR DELETE ON "restaurant_money_idempotency_keys"
FOR EACH ROW EXECUTE FUNCTION guard_restaurant_money_idempotency_mutation();

ALTER TABLE "restaurant_tax_transaction_snapshots"
  ADD COLUMN "evidenceVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "evidencePayload" JSONB,
  ADD CONSTRAINT "restaurant_tax_snapshot_evidence_version_ck"
    CHECK (("evidenceVersion" = 0 AND "evidencePayload" IS NULL)
           OR ("evidenceVersion" = 1 AND "evidencePayload" IS NOT NULL));

ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  ADD COLUMN "evidenceVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "allocationKind" TEXT,
  ADD COLUMN "billLineId" TEXT,
  ADD COLUMN "unitOrdinal" INTEGER,
  ADD CONSTRAINT "restaurant_tax_bucket_evidence_version_ck"
    CHECK (
      ("evidenceVersion" = 0 AND "allocationKind" IS NULL
       AND "billLineId" IS NULL AND "unitOrdinal" IS NULL)
      OR
      ("evidenceVersion" = 1
       AND "allocationKind" IN ('MERCHANDISE', 'SERVICE_CHARGE')
       AND (("allocationKind" = 'MERCHANDISE' AND "billLineId" IS NOT NULL
             AND "unitOrdinal" IS NOT NULL AND "unitOrdinal" >= 0)
            OR ("allocationKind" = 'SERVICE_CHARGE' AND "billLineId" IS NULL
                AND "unitOrdinal" IS NULL)))
    );

DROP INDEX "restaurant_tax_bucket_snapshot_rule_category_key";

CREATE UNIQUE INDEX "restaurant_tax_bucket_v0_aggregate_key"
  ON "restaurant_tax_rate_bucket_snapshots"("snapshotId", "ruleVersionId", "paymentCategory")
  WHERE "evidenceVersion" = 0;

CREATE UNIQUE INDEX "restaurant_tax_bucket_v1_allocation_key"
  ON "restaurant_tax_rate_bucket_snapshots"(
    "snapshotId", "billLineId", "unitOrdinal", "ruleVersionId",
    "paymentCategory", "allocationKind"
  ) NULLS NOT DISTINCT
  WHERE "evidenceVersion" = 1;

-- Preserve the existing tenant policies and explicitly retain both RLS modes.
ALTER TABLE "restaurant_money_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_money_idempotency_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_transaction_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_transaction_snapshots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_rate_bucket_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tax_rate_bucket_snapshots" FORCE ROW LEVEL SECURITY;
