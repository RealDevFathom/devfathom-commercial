-- A server-owned cursor makes the per-device FIFO claim durable. Existing
-- devices resume after their greatest recorded command, regardless of status.
ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN "nextOfflineCommandSequence" INTEGER NOT NULL DEFAULT 1;

UPDATE "pharmacy_registered_devices" AS device
SET "nextOfflineCommandSequence" = commands."nextSequence"
FROM (
  SELECT "organizationId", "deviceId", MAX("sequence") + 1 AS "nextSequence"
  FROM "pharmacy_offline_commands"
  GROUP BY "organizationId", "deviceId"
) AS commands
WHERE device."organizationId" = commands."organizationId"
  AND device."id" = commands."deviceId";

ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_offline_sequence_check"
  CHECK ("nextOfflineCommandSequence" > 0);
