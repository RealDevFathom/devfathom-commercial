-- A server-owned cursor makes the per-device FIFO claim durable. Existing
-- devices resume at their first missing positive sequence. This preserves a
-- delayed command below a historical gap instead of silently skipping it.
ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN "nextOfflineCommandSequence" INTEGER NOT NULL DEFAULT 1;

UPDATE "pharmacy_registered_devices" AS device
SET "nextOfflineCommandSequence" = commands."nextSequence"
FROM (
  -- LAG identifies the first gap without generating every integer up to the
  -- maximum. Cast before incrementing so INTEGER maximum history cannot abort
  -- deployment; 2147483647 remains the terminal cursor.
  SELECT "organizationId", "deviceId",
    LEAST(MIN(
      CASE
        WHEN "previousSequence" IS NULL AND "sequence" > 1 THEN 1::BIGINT
        WHEN "previousSequence" IS NOT NULL AND "sequence"::BIGINT > "previousSequence"::BIGINT + 1
          THEN "previousSequence"::BIGINT + 1
        WHEN "sequence" = "maximumSequence" THEN "sequence"::BIGINT + 1
      END
    ), 2147483647)::INTEGER AS "nextSequence"
  FROM (
    SELECT "organizationId", "deviceId", "sequence",
      LAG("sequence") OVER (PARTITION BY "organizationId", "deviceId" ORDER BY "sequence") AS "previousSequence",
      MAX("sequence") OVER (PARTITION BY "organizationId", "deviceId") AS "maximumSequence"
    FROM "pharmacy_offline_commands"
  ) AS ordered_commands
  GROUP BY "organizationId", "deviceId"
) AS commands
WHERE device."organizationId" = commands."organizationId"
  AND device."id" = commands."deviceId";

ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_offline_sequence_check"
  CHECK ("nextOfflineCommandSequence" > 0);
