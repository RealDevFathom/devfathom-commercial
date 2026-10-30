-- OFF-01: make the claimed per-device FIFO durable. The registered-device row
-- is the serialization point, so separate app instances cannot accept a gap or
-- race two different commands into the same next position.
ALTER TABLE "pharmacy_registered_devices"
  ADD COLUMN "nextOfflineCommandSequence" BIGINT NOT NULL DEFAULT 1;

-- Both source tables already FORCE RLS, including for their NOBYPASSRLS
-- owner. Migrations run as that owner, so temporarily stop forcing the owner
-- through tenant policies while the cross-tenant backfill runs. RLS remains
-- enabled for every other role, and Prisma applies this migration in one
-- transaction: FORCE is restored before any of these changes can commit.
ALTER TABLE "pharmacy_registered_devices" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_offline_commands" NO FORCE ROW LEVEL SECURITY;

UPDATE "pharmacy_registered_devices" AS device
SET "nextOfflineCommandSequence" = COALESCE((
  -- Cast before addition: legacy logs may already contain INTEGER's maximum.
  SELECT MAX(command."sequence")::bigint + 1
  FROM "pharmacy_offline_commands" AS command
  WHERE command."organizationId" = device."organizationId"
    AND command."deviceId" = device."id"
), 1);

ALTER TABLE "pharmacy_offline_commands" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_registered_devices" FORCE ROW LEVEL SECURITY;

ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_offline_sequence_check"
  CHECK ("nextOfflineCommandSequence" > 0);

CREATE OR REPLACE FUNCTION enforce_pharmacy_offline_command_fifo()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_sequence bigint;
BEGIN
  -- Lock before checking duplicates: a concurrent retry waits for the original
  -- insert and then observes it instead of being rejected as a late command.
  SELECT "nextOfflineCommandSequence"
    INTO expected_sequence
    FROM "pharmacy_registered_devices"
   WHERE "organizationId" = NEW."organizationId"
     AND "branchId" = NEW."branchId"
     AND "id" = NEW."deviceId"
   FOR UPDATE;

  IF expected_sequence IS NULL THEN
    RETURN NEW; -- the existing foreign key supplies the canonical error
  END IF;

  -- Preserve both existing conflict contracts. An identical key proceeds to
  -- ON CONFLICT/read-back; a reused sequence proceeds to its unique conflict.
  IF EXISTS (
    SELECT 1 FROM "pharmacy_offline_commands"
     WHERE "organizationId" = NEW."organizationId"
       AND "deviceId" = NEW."deviceId"
       AND ("idempotencyKey" = NEW."idempotencyKey" OR "sequence" = NEW."sequence")
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW."sequence" <> expected_sequence THEN
    RAISE EXCEPTION 'PHARMACY_OFFLINE_SEQUENCE_OUT_OF_ORDER expected %, received %',
      expected_sequence, NEW."sequence" USING ERRCODE = 'P0001';
  END IF;

  UPDATE "pharmacy_registered_devices"
     SET "nextOfflineCommandSequence" = expected_sequence + 1
   WHERE "organizationId" = NEW."organizationId"
     AND "id" = NEW."deviceId";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pharmacy_offline_commands_fifo"
  BEFORE INSERT ON "pharmacy_offline_commands"
  FOR EACH ROW EXECUTE FUNCTION enforce_pharmacy_offline_command_fifo();
