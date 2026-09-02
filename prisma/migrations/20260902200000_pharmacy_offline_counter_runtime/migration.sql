-- PH-OFF — the enrolled offline counter runtime.
-- PRD §6.9 OFF-01, OFF-02, OFF-03 and §8A invariant 16.
--
-- Four guarantees are database-level here rather than service-level, because a
-- caller that skips the service must not be able to break them:
--
--   OFF-01 "reconnect never renumbers an issued receipt" — receipt numbers for
--   an offline counter are drawn AHEAD OF TIME, from the SAME per-device
--   sequence the online settlement path uses. A lease is a half-open block of
--   that sequence handed to one device; the lease guard forbids a block that
--   overlaps another lease or that reaches below the sequence's own high-water
--   mark, so two counters can never be handed the same number. The already
--   existing `pharmacy_issued_receipt_number` unique index and
--   `pharmacy_receipt_immutable()` trigger (POS-04) then make an issued number
--   unrepeatable and unchangeable. Nothing here rewinds a sequence.
--
--   OFF-01 "append-only command log" — a queued offline command's identity
--   (device, sequence, idempotency key, action, payload and its hash, the
--   client-origin instant) is immutable after insert and no row can be deleted.
--   Only the replay bookkeeping advances, and only away from PENDING.
--
--   OFF-01 "signed snapshots" — a snapshot row records the signature that was
--   issued over it and is append-only. A snapshot is never edited in place; a
--   fresh one is a new version, so a device can always tell which envelope it
--   verified.
--
--   OFF-03 "concurrent last-unit sale cannot oversell" — the outstanding stock
--   quotas held by ALL devices for one (lot, location) bucket can never exceed
--   the units that bucket actually holds. The guard locks the balance row
--   before it sums, so two counters racing for the same last unit serialize and
--   the loser is refused. That is what makes per-device quotas an ownership
--   partition rather than "independent full-stock snapshots".

-- ── Types ───────────────────────────────────────────────────────────────────
CREATE TYPE "PharmacyDeviceKind" AS ENUM ('PHARMACY_COUNTER');
CREATE TYPE "PharmacyDeviceStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "PharmacyOfflineSnapshotKind" AS ENUM (
  'CATALOG', 'PRICES', 'TAX', 'RULES', 'LICENCE', 'STAFF', 'LOT_BALANCES', 'CUSTOMER_CREDIT');
-- OFF-02: the enum is the database half of the offline action matrix. The
-- allow/deny decision itself is a table in code (`offline-action-matrix.ts`)
-- with one test per row; this enum only names the actions that decision covers,
-- and a test asserts the two lists are the same set.
CREATE TYPE "PharmacyOfflineAction" AS ENUM (
  'SEARCH_CATALOG',
  'SCAN_BARCODE',
  'CASH_OTC_SALE',
  'KHATA_SALE_WITHIN_CACHED_LIMIT',
  'PERMITTED_REFUND',
  'PROVISIONAL_CLOSE',
  'CONTROLLED_MEDICINE_SALE',
  'CATALOG_CHANGE',
  'PRICE_CHANGE',
  'RULE_CHANGE',
  'UNVERIFIED_PRESCRIPTION_FILL');
CREATE TYPE "PharmacyOfflineCommandStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'DEAD');

-- ── OFF-01: the enrolled counter ────────────────────────────────────────────
-- Only the hash of the device secret is stored, and it is UNIQUE across the
-- whole table so a terminal call resolves its device in one indexed lookup with
-- no trust cache. A revoked device keeps its row: revocation is a state, not a
-- deletion, or the audit trail of what it sold would vanish with it.
CREATE TABLE "pharmacy_registered_devices" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "PharmacyDeviceKind" NOT NULL DEFAULT 'PHARMACY_COUNTER',
  "deviceSecretHash" TEXT NOT NULL,
  "status" "PharmacyDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "enrolledByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_registered_devices_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "pharmacy_registered_devices_actor_check"
    CHECK (length(btrim("enrolledByActorId")) > 0),
  -- The two revocation facts can never disagree.
  CONSTRAINT "pharmacy_registered_devices_revocation_check"
    CHECK (("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_registered_devices_secret_hash_check"
    CHECK ("deviceSecretHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_org_branch_id_key"
  UNIQUE ("organizationId", "branchId", "id");
-- Globally unique, not per tenant: the transport resolves a device BEFORE it
-- knows the organization, so the lookup cannot carry a tenant predicate.
CREATE UNIQUE INDEX "pharmacy_registered_devices_secret_hash_key"
  ON "pharmacy_registered_devices" ("deviceSecretHash");
CREATE INDEX "pharmacy_registered_devices_org_branch_status_idx"
  ON "pharmacy_registered_devices" ("organizationId", "branchId", "status");
ALTER TABLE "pharmacy_registered_devices"
  ADD CONSTRAINT "pharmacy_registered_devices_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── OFF-01: signed snapshots ────────────────────────────────────────────────
-- Append-only. `payloadHash` binds the signature to an exact payload and
-- `expiresAt` bounds how long a device may keep trusting it; OFF-04 will build
-- the freshness policy on top of that window rather than inventing a second one.
CREATE TABLE "pharmacy_offline_snapshots" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "kind" "PharmacyOfflineSnapshotKind" NOT NULL,
  "version" INTEGER NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "signature" TEXT NOT NULL,
  "signingKeyId" TEXT NOT NULL,
  "issuedByActorId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_offline_snapshots_version_check" CHECK ("version" > 0),
  CONSTRAINT "pharmacy_offline_snapshots_payload_hash_check"
    CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pharmacy_offline_snapshots_signature_check"
    CHECK (length(btrim("signature")) > 0 AND length(btrim("signingKeyId")) > 0),
  CONSTRAINT "pharmacy_offline_snapshots_window_check" CHECK ("expiresAt" > "issuedAt")
);
ALTER TABLE "pharmacy_offline_snapshots"
  ADD CONSTRAINT "pharmacy_offline_snapshots_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_offline_snapshots"
  ADD CONSTRAINT "pharmacy_offline_snapshots_device_version_key"
  UNIQUE ("organizationId", "deviceId", "kind", "version");
CREATE INDEX "pharmacy_offline_snapshots_device_kind_idx"
  ON "pharmacy_offline_snapshots" ("organizationId", "deviceId", "kind", "version" DESC);
ALTER TABLE "pharmacy_offline_snapshots"
  ADD CONSTRAINT "pharmacy_offline_snapshots_device_fkey"
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
  REFERENCES "pharmacy_registered_devices" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── OFF-01: the append-only command log ─────────────────────────────────────
-- `sequence` is minted on the device and is its FIFO position; `idempotencyKey`
-- is minted once at compose time and reused on every attempt, so a lost response
-- resolves to one server-side effect. Both are unique per device.
CREATE TABLE "pharmacy_offline_commands" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "action" "PharmacyOfflineAction" NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "clientOriginAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" "PharmacyOfflineCommandStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "settledAt" TIMESTAMP(3),
  "serverRef" TEXT,
  "receiptNumber" INTEGER,
  "rejectionReason" TEXT,
  "lastError" TEXT,
  CONSTRAINT "pharmacy_offline_commands_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "pharmacy_offline_commands_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "pharmacy_offline_commands_key_check"
    CHECK (length(btrim("idempotencyKey")) > 0),
  CONSTRAINT "pharmacy_offline_commands_payload_hash_check"
    CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pharmacy_offline_commands_receipt_number_check"
    CHECK ("receiptNumber" IS NULL OR "receiptNumber" > 0),
  -- A settled command names its outcome; a pending one names none.
  CONSTRAINT "pharmacy_offline_commands_settlement_check" CHECK (
    ("status" = 'PENDING' AND "settledAt" IS NULL AND "rejectionReason" IS NULL)
    OR ("status" = 'ACCEPTED' AND "settledAt" IS NOT NULL AND "rejectionReason" IS NULL)
    OR ("status" IN ('REJECTED', 'DEAD') AND "settledAt" IS NOT NULL
        AND length(btrim(COALESCE("rejectionReason", ''))) > 0))
);
ALTER TABLE "pharmacy_offline_commands"
  ADD CONSTRAINT "pharmacy_offline_commands_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_offline_commands"
  ADD CONSTRAINT "pharmacy_offline_commands_device_key_key"
  UNIQUE ("organizationId", "deviceId", "idempotencyKey");
ALTER TABLE "pharmacy_offline_commands"
  ADD CONSTRAINT "pharmacy_offline_commands_device_sequence_key"
  UNIQUE ("organizationId", "deviceId", "sequence");
CREATE INDEX "pharmacy_offline_commands_replay_idx"
  ON "pharmacy_offline_commands" ("organizationId", "deviceId", "status", "sequence");
ALTER TABLE "pharmacy_offline_commands"
  ADD CONSTRAINT "pharmacy_offline_commands_device_fkey"
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
  REFERENCES "pharmacy_registered_devices" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── OFF-01 / invariant 16: pre-allocated receipt-number leases ──────────────
CREATE TABLE "pharmacy_receipt_number_leases" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "blockStart" INTEGER NOT NULL,
  "blockEnd" INTEGER NOT NULL,
  "nextNumber" INTEGER NOT NULL,
  "issuedToActorId" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_receipt_number_leases_block_check"
    CHECK ("blockStart" > 0 AND "blockEnd" >= "blockStart"),
  -- `blockEnd + 1` is the exhausted marker, so an exhausted lease is still a
  -- legible record of which numbers this device owned.
  CONSTRAINT "pharmacy_receipt_number_leases_cursor_check"
    CHECK ("nextNumber" >= "blockStart" AND "nextNumber" <= "blockEnd" + 1)
);
ALTER TABLE "pharmacy_receipt_number_leases"
  ADD CONSTRAINT "pharmacy_receipt_number_leases_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_receipt_number_leases"
  ADD CONSTRAINT "pharmacy_receipt_number_leases_block_key"
  UNIQUE ("organizationId", "branchId", "deviceId", "blockStart");
CREATE INDEX "pharmacy_receipt_number_leases_open_idx"
  ON "pharmacy_receipt_number_leases" ("organizationId", "branchId", "deviceId", "blockStart")
  WHERE "nextNumber" <= "blockEnd";
ALTER TABLE "pharmacy_receipt_number_leases"
  ADD CONSTRAINT "pharmacy_receipt_number_leases_device_fkey"
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
  REFERENCES "pharmacy_registered_devices" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── OFF-03: per-device lot quotas ───────────────────────────────────────────
CREATE TABLE "pharmacy_device_lot_quotas" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "deviceId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "quotaUnits" INTEGER NOT NULL,
  "consumedUnits" INTEGER NOT NULL DEFAULT 0,
  "grantedByActorId" TEXT NOT NULL,
  "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_device_lot_quotas_units_check"
    CHECK ("quotaUnits" > 0 AND "consumedUnits" >= 0 AND "consumedUnits" <= "quotaUnits")
);
ALTER TABLE "pharmacy_device_lot_quotas"
  ADD CONSTRAINT "pharmacy_device_lot_quotas_org_id_key" UNIQUE ("organizationId", "id");
-- One OPEN quota per device per bucket. A released quota keeps its row, so what
-- a counter was permitted to sell during an outage stays auditable.
CREATE UNIQUE INDEX "pharmacy_device_lot_quotas_open_key"
  ON "pharmacy_device_lot_quotas"
  ("organizationId", "deviceId", "inventoryLotId", "stockLocationId")
  WHERE "releasedAt" IS NULL;
CREATE INDEX "pharmacy_device_lot_quotas_bucket_idx"
  ON "pharmacy_device_lot_quotas" ("organizationId", "inventoryLotId", "stockLocationId");
ALTER TABLE "pharmacy_device_lot_quotas"
  ADD CONSTRAINT "pharmacy_device_lot_quotas_device_fkey"
  FOREIGN KEY ("organizationId", "branchId", "deviceId")
  REFERENCES "pharmacy_registered_devices" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_device_lot_quotas"
  ADD CONSTRAINT "pharmacy_device_lot_quotas_lot_fkey"
  FOREIGN KEY ("organizationId", "branchId", "inventoryLotId")
  REFERENCES "pharmacy_inventory_lots" ("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_device_lot_quotas"
  ADD CONSTRAINT "pharmacy_device_lot_quotas_location_fkey"
  FOREIGN KEY ("organizationId", "stockLocationId")
  REFERENCES "pharmacy_stock_locations" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Guards ──────────────────────────────────────────────────────────────────

-- OFF-01: the snapshot log is append-only.
CREATE TRIGGER "pharmacy_offline_snapshots_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_offline_snapshots"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- OFF-01: a queued command's identity is immutable and it is never deleted.
-- Only the replay bookkeeping may advance, and a settled command is final.
CREATE FUNCTION guard_pharmacy_offline_command_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."deviceId", NEW."sequence",
      NEW."idempotencyKey", NEW."action", NEW."payload", NEW."payloadHash",
      NEW."clientOriginAt", NEW."receivedAt")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."deviceId", OLD."sequence",
      OLD."idempotencyKey", OLD."action", OLD."payload", OLD."payloadHash",
      OLD."clientOriginAt", OLD."receivedAt") THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" <> 'PENDING' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_ALREADY_SETTLED' USING ERRCODE = '55000';
  END IF;
  -- §8A invariant 16: a number issued to a customer is never reassigned.
  IF OLD."receiptNumber" IS NOT NULL
     AND NEW."receiptNumber" IS DISTINCT FROM OLD."receiptNumber" THEN
    RAISE EXCEPTION 'ISSUED_RECEIPT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'OFFLINE_COMMAND_ATTEMPTS_MONOTONIC' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_offline_commands_update_guard"
  BEFORE UPDATE ON "pharmacy_offline_commands"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_offline_command_update();
CREATE TRIGGER "pharmacy_offline_commands_no_delete"
  BEFORE DELETE ON "pharmacy_offline_commands"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- OFF-01 / invariant 16: a lease may not overlap another lease for the same
-- counter, and may not reach below the device sequence's own high-water mark —
-- which is where the ONLINE settlement path also draws from. That single rule is
-- what makes "reconnect never renumbers" true no matter which path issued first.
CREATE FUNCTION guard_pharmacy_receipt_lease_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  high_water integer;
  overlapping integer;
BEGIN
  SELECT "nextNumber" INTO high_water
  FROM "pharmacy_receipt_number_sequences"
  WHERE "organizationId" = NEW."organizationId"
    AND "branchId" = NEW."branchId"
    AND "deviceId" = NEW."deviceId"
  FOR UPDATE;

  IF high_water IS NULL THEN
    RAISE EXCEPTION 'RECEIPT_SEQUENCE_MISSING' USING ERRCODE = '55000';
  END IF;
  IF NEW."blockEnd" >= high_water THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_NOT_RESERVED' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO overlapping
  FROM "pharmacy_receipt_number_leases" lease
  WHERE lease."organizationId" = NEW."organizationId"
    AND lease."branchId" = NEW."branchId"
    AND lease."deviceId" = NEW."deviceId"
    AND lease."id" <> NEW."id"
    AND lease."blockStart" <= NEW."blockEnd"
    AND lease."blockEnd" >= NEW."blockStart";
  IF overlapping > 0 THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_OVERLAP' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_receipt_number_leases_insert_guard"
  BEFORE INSERT ON "pharmacy_receipt_number_leases"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_receipt_lease_insert();

-- A lease's block is fixed at issue; only its cursor advances, and only forward.
CREATE FUNCTION guard_pharmacy_receipt_lease_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."deviceId", NEW."blockStart", NEW."blockEnd")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."deviceId", OLD."blockStart", OLD."blockEnd") THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."nextNumber" < OLD."nextNumber" THEN
    RAISE EXCEPTION 'RECEIPT_LEASE_REWIND' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_receipt_number_leases_update_guard"
  BEFORE UPDATE ON "pharmacy_receipt_number_leases"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_receipt_lease_update();
CREATE TRIGGER "pharmacy_receipt_number_leases_no_delete"
  BEFORE DELETE ON "pharmacy_receipt_number_leases"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- OFF-03: the outstanding quotas of every device for one bucket can never
-- exceed the units that bucket holds. The balance row is locked FIRST, so two
-- counters granted a quota for the same last unit serialize here rather than
-- both reading the same stale on-hand.
CREATE FUNCTION guard_pharmacy_device_lot_quota() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  on_hand integer;
  outstanding integer;
BEGIN
  IF NEW."releasedAt" IS NOT NULL THEN
    RETURN NEW; -- releasing only ever frees units
  END IF;

  SELECT "onHandUnits" INTO on_hand
  FROM "pharmacy_stock_balances"
  WHERE "organizationId" = NEW."organizationId"
    AND "inventoryLotId" = NEW."inventoryLotId"
    AND "stockLocationId" = NEW."stockLocationId"
    AND "disposition" = 'AVAILABLE'
  FOR UPDATE;

  IF on_hand IS NULL THEN
    RAISE EXCEPTION 'QUOTA_BUCKET_EMPTY' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(quota."quotaUnits" - quota."consumedUnits"), 0) INTO outstanding
  FROM "pharmacy_device_lot_quotas" quota
  WHERE quota."organizationId" = NEW."organizationId"
    AND quota."inventoryLotId" = NEW."inventoryLotId"
    AND quota."stockLocationId" = NEW."stockLocationId"
    AND quota."releasedAt" IS NULL
    AND quota."id" <> NEW."id";

  IF outstanding + (NEW."quotaUnits" - NEW."consumedUnits") > on_hand THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDS_ON_HAND' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_device_lot_quotas_capacity_guard"
  BEFORE INSERT OR UPDATE ON "pharmacy_device_lot_quotas"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_device_lot_quota();

-- A quota's ownership and grant are fixed; consumption only rises and a release
-- is final. A counter can never quietly be handed back units it already sold.
CREATE FUNCTION guard_pharmacy_device_lot_quota_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."deviceId", NEW."inventoryLotId",
      NEW."stockLocationId", NEW."quotaUnits", NEW."grantedAt")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."deviceId", OLD."inventoryLotId",
      OLD."stockLocationId", OLD."quotaUnits", OLD."grantedAt") THEN
    RAISE EXCEPTION 'QUOTA_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW."consumedUnits" < OLD."consumedUnits" THEN
    RAISE EXCEPTION 'QUOTA_CONSUMPTION_MONOTONIC' USING ERRCODE = '55000';
  END IF;
  IF OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" THEN
    RAISE EXCEPTION 'QUOTA_ALREADY_RELEASED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "pharmacy_device_lot_quotas_update_guard"
  BEFORE UPDATE ON "pharmacy_device_lot_quotas"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_device_lot_quota_update();
CREATE TRIGGER "pharmacy_device_lot_quotas_no_delete"
  BEFORE DELETE ON "pharmacy_device_lot_quotas"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

-- ── Row level security ──────────────────────────────────────────────────────
-- FORCE, so the table owner is subject to the policy too. Append-only tables get
-- SELECT and INSERT only: the missing UPDATE/DELETE policy is the first guard
-- and the triggers above are the second, for connections policies cannot reach.
DO $$
DECLARE
  mutable_table text;
  append_only_table text;
BEGIN
  FOREACH mutable_table IN ARRAY ARRAY[
    'pharmacy_registered_devices',
    'pharmacy_offline_commands',
    'pharmacy_receipt_number_leases',
    'pharmacy_device_lot_quotas'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', mutable_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_select', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_insert', mutable_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      mutable_table || '_tenant_update', mutable_table);
  END LOOP;

  FOREACH append_only_table IN ARRAY ARRAY[
    'pharmacy_offline_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', append_only_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', append_only_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      append_only_table || '_tenant_select', append_only_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))',
      append_only_table || '_tenant_insert', append_only_table);
  END LOOP;
END $$;
