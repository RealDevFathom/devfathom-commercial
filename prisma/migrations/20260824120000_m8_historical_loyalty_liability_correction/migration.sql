-- WHA-134 / M8 correction D: store historical loyalty liability once per
-- organization and local calendar date. The nullable fact link preserves
-- compatibility with base-version readers and writers during rolling rollout.

BEGIN;
SET LOCAL app.is_platform_admin = 'true';

DO $$
DECLARE
    invalid_timezone_count INTEGER;
BEGIN
    SELECT COUNT(*)::integer
      INTO invalid_timezone_count
      FROM "organizations" AS organization
     WHERE EXISTS (
               SELECT 1
                 FROM "restaurant_insight_daily_rollups" AS rollup
                WHERE rollup."organizationId" = organization."id"
           )
       AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_timezone_names AS timezone
                WHERE timezone.name = organization."timezone"
           );

    IF invalid_timezone_count > 0 THEN
        RAISE EXCEPTION
            'WHA-134 precondition failed: % organization timezone value(s) are invalid.',
            invalid_timezone_count
            USING ERRCODE = '22023';
    END IF;
END $$;

CREATE TABLE "restaurant_insight_loyalty_liability_rollups" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "businessDate" DATE NOT NULL,
    "liability" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_insight_loyalty_liability_rollups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "restaurant_insight_loyalty_liability_nonnegative_ck" CHECK ("liability" >= 0)
);

CREATE UNIQUE INDEX "restaurant_insight_loyalty_liability_org_date_key"
    ON "restaurant_insight_loyalty_liability_rollups"("organizationId", "businessDate");
CREATE UNIQUE INDEX "restaurant_insight_loyalty_liability_org_id_key"
    ON "restaurant_insight_loyalty_liability_rollups"("organizationId", "id");
CREATE INDEX "restaurant_insight_loyalty_liability_org_idx"
    ON "restaurant_insight_loyalty_liability_rollups"("organizationId");

ALTER TABLE "restaurant_insight_loyalty_liability_rollups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_insight_loyalty_liability_rollups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_insight_loyalty_liability_rollups"
    USING (
        current_setting('app.is_platform_admin', true) = 'true'
        OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    )
    WITH CHECK (
        current_setting('app.is_platform_admin', true) = 'true'
        OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    );

WITH liability_days AS (
    SELECT DISTINCT
        rollup."organizationId",
        rollup."businessDate",
        (
            (rollup."businessDate" + 1)::timestamp
                AT TIME ZONE organization."timezone"
        ) AT TIME ZONE 'UTC' AS cutoff_utc
    FROM "restaurant_insight_daily_rollups" AS rollup
    JOIN "organizations" AS organization ON organization."id" = rollup."organizationId"
), historical_liability AS (
    SELECT
        day."organizationId",
        day."businessDate",
        COALESCE(ROUND(balance.positive_points * program."redemptionValue", 2), 0) AS liability
    FROM liability_days AS day
    LEFT JOIN LATERAL (
        SELECT version."redemptionValue"
        FROM "restaurant_loyalty_program_versions" AS version
        WHERE version."organizationId" = day."organizationId"
          AND version."effectiveFrom" < day.cutoff_utc
        ORDER BY version."effectiveFrom" DESC
        LIMIT 1
    ) AS program ON true
    LEFT JOIN LATERAL (
        SELECT SUM(GREATEST(account_balance.points, 0))::numeric AS positive_points
        FROM (
            SELECT SUM(entry."points")::numeric AS points
            FROM "restaurant_loyalty_points_entries" AS entry
            WHERE entry."organizationId" = day."organizationId"
              AND entry."occurredAt" < day.cutoff_utc
            GROUP BY entry."accountId"
        ) AS account_balance
    ) AS balance ON true
)
INSERT INTO "restaurant_insight_loyalty_liability_rollups" (
    "id", "organizationId", "businessDate", "liability", "computedAt", "createdAt", "updatedAt"
)
SELECT
    'illr_' || replace(gen_random_uuid()::text, '-', ''),
    historical_liability."organizationId",
    historical_liability."businessDate",
    historical_liability.liability,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM historical_liability;

ALTER TABLE "restaurant_insight_daily_rollups"
    ADD COLUMN "loyaltyLiabilityRollupId" TEXT;

UPDATE "restaurant_insight_daily_rollups" AS daily
   SET "loyaltyLiabilityRollupId" = liability."id"
  FROM "restaurant_insight_loyalty_liability_rollups" AS liability
 WHERE liability."organizationId" = daily."organizationId"
   AND liability."businessDate" = daily."businessDate";

CREATE INDEX "restaurant_insight_daily_loyalty_fact_idx"
    ON "restaurant_insight_daily_rollups"("loyaltyLiabilityRollupId");

ALTER TABLE "restaurant_insight_daily_rollups"
    ADD CONSTRAINT "tenant_insight_daily_loyalty_fact_fk"
    FOREIGN KEY ("organizationId", "loyaltyLiabilityRollupId")
    REFERENCES "restaurant_insight_loyalty_liability_rollups"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

COMMIT;

-- Manual recovery before this correction receives dependent writes. The
-- legacy liability column was never rewritten, so base-version data survives.
-- BEGIN;
-- ALTER TABLE "restaurant_insight_daily_rollups"
--   DROP CONSTRAINT "tenant_insight_daily_loyalty_fact_fk";
-- DROP INDEX "restaurant_insight_daily_loyalty_fact_idx";
-- ALTER TABLE "restaurant_insight_daily_rollups"
--   DROP COLUMN "loyaltyLiabilityRollupId";
-- DROP TABLE "restaurant_insight_loyalty_liability_rollups";
-- COMMIT;
