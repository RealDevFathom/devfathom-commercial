-- Issue #489: make the claimed per-device FIFO durable. Existing logs establish
-- their high-water mark before the trigger starts enforcing contiguous inserts.
ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN "nextOfflineCommandSequence" INTEGER NOT NULL DEFAULT 1;

UPDATE "pharmacy_registered_devices" AS device
SET "nextOfflineCommandSequence" = command_log.next_sequence
FROM (
  SELECT "organizationId", "deviceId", MAX("sequence") + 1 AS next_sequence
  FROM "pharmacy_offline_commands"
  GROUP BY "organizationId", "deviceId"
) AS command_log
WHERE device."organizationId" = command_log."organizationId"
  AND device."id" = command_log."deviceId";

ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_offline_sequence_check"
  CHECK ("nextOfflineCommandSequence" > 0);

CREATE FUNCTION pharmacy_enforce_offline_command_fifo() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A retry of the same immutable command does not consume the cursor again.
  IF EXISTS (
    SELECT 1 FROM "pharmacy_offline_commands"
    WHERE "organizationId" = NEW."organizationId"
      AND "deviceId" = NEW."deviceId"
      AND "idempotencyKey" = NEW."idempotencyKey"
  ) THEN
    RETURN NEW;
  END IF;

  UPDATE "pharmacy_registered_devices"
  SET "nextOfflineCommandSequence" = "nextOfflineCommandSequence" + 1
  WHERE "organizationId" = NEW."organizationId"
    AND "branchId" = NEW."branchId"
    AND "id" = NEW."deviceId"
    AND "nextOfflineCommandSequence" = NEW."sequence";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_SEQUENCE_OUT_OF_ORDER'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pharmacy_offline_command_fifo_guard
BEFORE INSERT ON "pharmacy_offline_commands"
FOR EACH ROW EXECUTE FUNCTION pharmacy_enforce_offline_command_fifo();

-- A dead/rejected command is already durable and therefore advances FIFO. For
-- a command intentionally abandoned before upload, recovery must be explicit,
-- tenant-scoped, reasoned and auditable rather than silently accepting a gap.
CREATE TABLE "pharmacy_offline_sequence_skips" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "skippedByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_offline_sequence_skips_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "pharmacy_offline_sequence_skips_device_fkey"
    FOREIGN KEY ("organizationId", "branchId", "deviceId")
    REFERENCES "pharmacy_registered_devices" ("organizationId", "branchId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_offline_sequence_skips_device_sequence_key"
    UNIQUE ("organizationId", "deviceId", "sequence")
);

ALTER TABLE "pharmacy_offline_sequence_skips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_offline_sequence_skips" FORCE ROW LEVEL SECURITY;
CREATE POLICY pharmacy_offline_sequence_skips_tenant_isolation
  ON "pharmacy_offline_sequence_skips"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
REVOKE DELETE, UPDATE ON "pharmacy_offline_sequence_skips" FROM PUBLIC;

CREATE FUNCTION pharmacy_skip_offline_command_sequence(
  requested_organization_id TEXT,
  requested_branch_id TEXT,
  requested_device_id TEXT,
  requested_sequence INTEGER,
  requested_reason TEXT,
  requested_actor_id TEXT
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF requested_organization_id IS DISTINCT FROM current_setting('app.current_organization_id', true)
     OR length(btrim(requested_reason)) = 0
     OR length(btrim(requested_actor_id)) = 0 THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_SEQUENCE_SKIP_INVALID' USING ERRCODE = '23514';
  END IF;

  UPDATE "pharmacy_registered_devices"
  SET "nextOfflineCommandSequence" = "nextOfflineCommandSequence" + 1
  WHERE "organizationId" = requested_organization_id
    AND "branchId" = requested_branch_id
    AND "id" = requested_device_id
    AND "nextOfflineCommandSequence" = requested_sequence;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_SEQUENCE_SKIP_OUT_OF_ORDER' USING ERRCODE = '23514';
  END IF;

  INSERT INTO "pharmacy_offline_sequence_skips" (
    "id", "organizationId", "branchId", "deviceId", "sequence", "reason", "skippedByActorId"
  ) VALUES (
    gen_random_uuid()::text,
    requested_organization_id,
    requested_branch_id,
    requested_device_id,
    requested_sequence,
    requested_reason,
    requested_actor_id
  );
END;
$$;

-- Recovery is an owner/operator action, not a capability of the runtime role.
REVOKE ALL ON FUNCTION pharmacy_skip_offline_command_sequence(TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT)
  FROM PUBLIC;
