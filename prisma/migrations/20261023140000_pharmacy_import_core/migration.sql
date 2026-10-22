-- Import 1/5 CORE: extend the existing PH-MIG evidence/staging tables and add the commit manifest.
--
-- DEPLOY AND LOCK PLAN. One explicit transaction, bounded by lock_timeout: if a lock is not
-- granted in 5 s the whole migration rolls back untouched, and the deploy is retried after
-- `prisma migrate resolve --rolled-back`. Every lock below is held until COMMIT.
--   * pharmacy_migration_sources / batches / rows / exceptions: ACCESS EXCLUSIVE. The status
--     enum swap rewrites pharmacy_migration_batches (one row per upload attempt). Every ADD
--     COLUMN has a constant default and is catalog-only (no rewrite). CHECK, UNIQUE, FOREIGN KEY
--     and index builds scan each table once; pharmacy_migration_rows is the largest.
--   * pharmacy_branches, users and pharmacy_stock_movements are only REFERENCED by new foreign
--     keys: SHARE ROW EXCLUSIVE. No row in them is read or rewritten, but writes to them wait
--     until the migration commits.
-- Only the import workbench uses the PH-MIG tables; the counter, inventory and finance paths
-- never touch them. Measured on PostgreSQL 16 with 4 legacy sources, 6 batches, 60,000 rows
-- and 12,000 exceptions: see docs/import-1.md ("Deploying").
--
-- EXISTING EVIDENCE. Rows written before this migration have no truthful branch or actor. They
-- are NOT guessed and NOT rewritten: each table gains "legacy" with DEFAULT true, so every
-- existing row reads legacy = true without an UPDATE (the read-only triggers stay armed), and
-- the default then becomes false for new rows. A legacy row keeps "branchId" NULL, is invisible
-- to the branch-scoped policies, and cannot be committed or rolled back. A platform operator
-- assigns it to a branch with pharmacy_migration_remediate_legacy_source(), which records who
-- decided, why and when in pharmacy_migration_legacy_remediations (append-only).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '300s';

-- ── Batch lifecycle ─────────────────────────────────────────────────────────
ALTER TYPE "PharmacyMigrationBatchStatus" RENAME TO "PharmacyMigrationBatchStatus_old";
CREATE TYPE "PharmacyMigrationBatchStatus" AS ENUM
  ('UPLOADED','PARSING','PREVIEW','COMMITTING','COMMITTED','ROLLED_BACK','FAILED');
ALTER TABLE "pharmacy_migration_batches" DROP CONSTRAINT "pharmacy_migration_batches_status_time_check";
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" TYPE "PharmacyMigrationBatchStatus"
  USING (CASE "status"::text WHEN 'PROFILING' THEN 'PARSING' WHEN 'PROFILED' THEN 'PREVIEW' ELSE "status"::text END)::"PharmacyMigrationBatchStatus";
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" SET DEFAULT 'UPLOADED';
DROP TYPE "PharmacyMigrationBatchStatus_old";

-- ── Provenance: branch and actor, legacy rows flagged without an UPDATE ──────
ALTER TABLE "pharmacy_migration_sources"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "pharmacy_migration_batches"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "committedAt" TIMESTAMP(3),
  ADD COLUMN "rolledBackAt" TIMESTAMP(3),
  ADD COLUMN "failureReason" TEXT;
ALTER TABLE "pharmacy_migration_rows"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "pharmacy_migration_exceptions"
  ADD COLUMN "branchId" TEXT,
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "pharmacy_migration_sources" ALTER COLUMN "legacy" SET DEFAULT false;
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "legacy" SET DEFAULT false;
ALTER TABLE "pharmacy_migration_rows" ALTER COLUMN "legacy" SET DEFAULT false;
ALTER TABLE "pharmacy_migration_exceptions" ALTER COLUMN "legacy" SET DEFAULT false;

-- A new row always names its branch; only legacy rows may wait for a remediation.
ALTER TABLE "pharmacy_migration_sources"
  ADD CONSTRAINT "pharmacy_migration_sources_branch_check" CHECK ("legacy" OR "branchId" IS NOT NULL),
  ADD CONSTRAINT "pharmacy_migration_sources_actor_check"
    CHECK ("legacy" OR (("createdByUserId" IS NOT NULL) <> "createdBySystem"));
ALTER TABLE "pharmacy_migration_batches"
  ADD CONSTRAINT "pharmacy_migration_batches_branch_check" CHECK ("legacy" OR "branchId" IS NOT NULL),
  ADD CONSTRAINT "pharmacy_migration_batches_actor_check"
    CHECK ("legacy" OR (("createdByUserId" IS NOT NULL) <> "createdBySystem")),
  -- Lifecycle timestamps are tied to the state they evidence.
  ADD CONSTRAINT "pharmacy_migration_batches_status_time_check" CHECK (
    ("status" NOT IN ('PREVIEW','COMMITTING','COMMITTED','ROLLED_BACK') OR "profiledAt" IS NOT NULL)
    AND (("status" IN ('COMMITTED','ROLLED_BACK')) = ("committedAt" IS NOT NULL))
    AND (("status" = 'ROLLED_BACK') = ("rolledBackAt" IS NOT NULL))
    AND ("status" <> 'FAILED' OR "legacy" OR "failureReason" IS NOT NULL)
  );
ALTER TABLE "pharmacy_migration_rows"
  ADD CONSTRAINT "pharmacy_migration_rows_branch_check" CHECK ("legacy" OR "branchId" IS NOT NULL);
ALTER TABLE "pharmacy_migration_exceptions"
  ADD CONSTRAINT "pharmacy_migration_exceptions_branch_check" CHECK ("legacy" OR "branchId" IS NOT NULL);

-- Branch-qualified identities. NULL branches (legacy) never collide.
ALTER TABLE "pharmacy_migration_sources" DROP CONSTRAINT "pharmacy_migration_sources_organizationId_contentHash_key";
ALTER TABLE "pharmacy_migration_sources"
  ADD CONSTRAINT "pharmacy_migration_sources_branch_hash_key" UNIQUE ("organizationId","branchId","contentHash"),
  ADD CONSTRAINT "pharmacy_migration_sources_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  ADD CONSTRAINT "pharmacy_migration_sources_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_migration_sources_actor_fkey" FOREIGN KEY ("organizationId","createdByUserId")
    REFERENCES "users"("organizationId","id") ON DELETE RESTRICT;
DROP INDEX "pharmacy_migration_sources_organizationId_kind_capturedAt_idx";
CREATE INDEX "pharmacy_migration_sources_branch_kind_idx"
  ON "pharmacy_migration_sources"("organizationId","branchId","kind","capturedAt");

ALTER TABLE "pharmacy_migration_batches"
  ADD CONSTRAINT "pharmacy_migration_batches_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  ADD CONSTRAINT "pharmacy_migration_batches_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_migration_batches_actor_fkey" FOREIGN KEY ("organizationId","createdByUserId")
    REFERENCES "users"("organizationId","id") ON DELETE RESTRICT,
  -- A batch and its source share one branch. The organization-level key stays for legacy rows.
  ADD CONSTRAINT "pharmacy_migration_batches_branch_source_fkey" FOREIGN KEY ("organizationId","branchId","sourceId")
    REFERENCES "pharmacy_migration_sources"("organizationId","branchId","id") ON DELETE RESTRICT;
DROP INDEX "pharmacy_migration_batches_organizationId_sourceId_status_idx";
CREATE INDEX "pharmacy_migration_batches_branch_source_status_idx"
  ON "pharmacy_migration_batches"("organizationId","branchId","sourceId","status");

ALTER TABLE "pharmacy_migration_rows"
  ADD CONSTRAINT "pharmacy_migration_rows_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  ADD CONSTRAINT "pharmacy_migration_rows_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_migration_rows_branch_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId")
    REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT;
DROP INDEX "pharmacy_migration_rows_organizationId_batchId_targetModelKey_idx";
CREATE INDEX "pharmacy_migration_rows_branch_batch_target_idx"
  ON "pharmacy_migration_rows"("organizationId","branchId","batchId","targetModelKey");

ALTER TABLE "pharmacy_migration_exceptions"
  ADD CONSTRAINT "pharmacy_migration_exceptions_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_migration_exceptions_branch_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId")
    REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_migration_exceptions_branch_row_fkey" FOREIGN KEY ("organizationId","branchId","rowId")
    REFERENCES "pharmacy_migration_rows"("organizationId","branchId","id") ON DELETE RESTRICT;
DROP INDEX "pharmacy_migration_exceptions_organizationId_batchId_bucket_idx";
DROP INDEX "pharmacy_migration_exceptions_organizationId_batchId_status_severity_idx";
CREATE INDEX "pharmacy_migration_exceptions_branch_bucket_idx"
  ON "pharmacy_migration_exceptions"("organizationId","branchId","batchId","bucket");
CREATE INDEX "pharmacy_migration_exceptions_branch_status_idx"
  ON "pharmacy_migration_exceptions"("organizationId","branchId","batchId","status","severity");

-- Only this deploy creates legacy evidence; every later row is new. A new batch cannot hang off
-- unremediated legacy evidence either: its branch-qualified foreign key needs a branch.
CREATE FUNCTION guard_pharmacy_migration_legacy_lineage() RETURNS trigger AS $$
BEGIN
  IF NEW."legacy" THEN
    RAISE EXCEPTION 'only the PH-MIG deploy creates legacy evidence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_sources_legacy_lineage" BEFORE INSERT ON "pharmacy_migration_sources"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_legacy_lineage();
CREATE TRIGGER "pharmacy_migration_batches_legacy_lineage" BEFORE INSERT ON "pharmacy_migration_batches"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_legacy_lineage();
CREATE TRIGGER "pharmacy_migration_rows_legacy_lineage" BEFORE INSERT ON "pharmacy_migration_rows"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_legacy_lineage();
CREATE TRIGGER "pharmacy_migration_exceptions_legacy_lineage" BEFORE INSERT ON "pharmacy_migration_exceptions"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_legacy_lineage();

-- ── Legacy remediation: explicit, recorded, one-way ─────────────────────────
CREATE TABLE "pharmacy_migration_legacy_remediations" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "decidedBy" TEXT NOT NULL CHECK (length(btrim("decidedBy")) > 0),
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) >= 10),
  "batchCount" INTEGER NOT NULL CHECK ("batchCount" >= 0),
  "rowCount" INTEGER NOT NULL CHECK ("rowCount" >= 0),
  "exceptionCount" INTEGER NOT NULL CHECK ("exceptionCount" >= 0),
  "remediatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_migration_legacy_remediations_source_key" UNIQUE ("organizationId","sourceId"),
  CONSTRAINT "pharmacy_migration_legacy_remediations_source_fkey" FOREIGN KEY ("organizationId","sourceId")
    REFERENCES "pharmacy_migration_sources"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_migration_legacy_remediations_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT
);
CREATE TRIGGER "pharmacy_migration_legacy_remediations_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_migration_legacy_remediations"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();
ALTER TABLE "pharmacy_migration_legacy_remediations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_legacy_remediations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_legacy_remediations_platform" ON "pharmacy_migration_legacy_remediations"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');

-- The read-only and append-only guards allow exactly one change: a legacy row's NULL branch set
-- once, by the remediation function, with every other column unchanged.
CREATE FUNCTION pharmacy_migration_is_legacy_remediation(old_row jsonb, new_row jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.pharmacy_migration_remediation', true) = 'on'
     AND (old_row->>'legacy')::boolean AND (new_row->>'legacy')::boolean
     AND old_row->>'branchId' IS NULL AND new_row->>'branchId' IS NOT NULL
     AND (old_row - 'branchId') = (new_row - 'branchId')
$$;
CREATE OR REPLACE FUNCTION prevent_pharmacy_migration_source_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pharmacy_migration_is_legacy_remediation(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy migration sources are read-only evidence and are never modified'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION prevent_pharmacy_migration_row_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND pharmacy_migration_is_legacy_remediation(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pharmacy migration rows are append-only; re-profile into a new batch'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION guard_pharmacy_migration_exception_update() RETURNS trigger AS $$
BEGIN
  IF pharmacy_migration_is_legacy_remediation(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF (NEW."organizationId", NEW."branchId", NEW."batchId", NEW."rowId", NEW."bucket", NEW."severity",
      NEW."detail", NEW."legacy", NEW."createdAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."batchId", OLD."rowId", OLD."bucket", OLD."severity",
      OLD."detail", OLD."legacy", OLD."createdAt") THEN
    RAISE EXCEPTION 'pharmacy migration exception identity is immutable; only sign-off may change'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = 'SIGNED_OFF' THEN
    RAISE EXCEPTION 'pharmacy migration exception sign-off is final' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'SIGNED_OFF' AND NEW."signedOffAt" IS NULL THEN
    RAISE EXCEPTION 'pharmacy migration exception sign-off requires an actor and a time'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- The batch keeps its identity too: branch, source, actor and legacy never move once set.
CREATE FUNCTION guard_pharmacy_migration_batch_identity() RETURNS trigger AS $$
BEGIN
  IF pharmacy_migration_is_legacy_remediation(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF (NEW."organizationId", NEW."branchId", NEW."sourceId", NEW."createdByUserId", NEW."createdBySystem",
      NEW."legacy", NEW."createdAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."sourceId", OLD."createdByUserId", OLD."createdBySystem",
      OLD."legacy", OLD."createdAt") THEN
    RAISE EXCEPTION 'pharmacy import batch identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batches_identity_guard" BEFORE UPDATE ON "pharmacy_migration_batches"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_batch_identity();

CREATE FUNCTION pharmacy_migration_remediate_legacy_source(
  p_organization_id TEXT, p_source_id TEXT, p_branch_id TEXT, p_decided_by TEXT, p_reason TEXT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  remediation_id TEXT;
  batches INTEGER;
  rows_moved INTEGER;
  exceptions_moved INTEGER;
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'legacy import evidence is remediated by a platform operator only' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM "pharmacy_branches" WHERE "organizationId" = p_organization_id AND "id" = p_branch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'branch % is not in organization %', p_branch_id, p_organization_id USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM "pharmacy_migration_sources"
    WHERE "organizationId" = p_organization_id AND "id" = p_source_id AND "legacy" AND "branchId" IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source % is not unremediated legacy evidence of organization %', p_source_id, p_organization_id
      USING ERRCODE = '55000';
  END IF;
  PERFORM set_config('app.pharmacy_migration_remediation', 'on', true);
  UPDATE "pharmacy_migration_sources" SET "branchId" = p_branch_id
    WHERE "organizationId" = p_organization_id AND "id" = p_source_id;
  UPDATE "pharmacy_migration_batches" SET "branchId" = p_branch_id
    WHERE "organizationId" = p_organization_id AND "sourceId" = p_source_id AND "legacy" AND "branchId" IS NULL;
  GET DIAGNOSTICS batches = ROW_COUNT;
  UPDATE "pharmacy_migration_rows" r SET "branchId" = p_branch_id
    FROM "pharmacy_migration_batches" b
    WHERE r."organizationId" = p_organization_id AND b."organizationId" = p_organization_id
      AND r."batchId" = b."id" AND b."sourceId" = p_source_id AND r."legacy" AND r."branchId" IS NULL;
  GET DIAGNOSTICS rows_moved = ROW_COUNT;
  UPDATE "pharmacy_migration_exceptions" e SET "branchId" = p_branch_id
    FROM "pharmacy_migration_batches" b
    WHERE e."organizationId" = p_organization_id AND b."organizationId" = p_organization_id
      AND e."batchId" = b."id" AND b."sourceId" = p_source_id AND e."legacy" AND e."branchId" IS NULL;
  GET DIAGNOSTICS exceptions_moved = ROW_COUNT;
  PERFORM set_config('app.pharmacy_migration_remediation', 'off', true);
  INSERT INTO "pharmacy_migration_legacy_remediations"
    ("organizationId", "sourceId", "branchId", "decidedBy", "reason", "batchCount", "rowCount", "exceptionCount")
    VALUES (p_organization_id, p_source_id, p_branch_id, p_decided_by, p_reason, batches, rows_moved, exceptions_moved)
    RETURNING "id" INTO remediation_id;
  RETURN remediation_id;
END $$;

-- ── Commit manifest ─────────────────────────────────────────────────────────
-- The rollback allow-list. CREATED rows name an entity the import created; STOCK_MOVEMENT rows
-- name the OPENING ledger posting it made; STOCK_REVERSAL rows name the exact compensating
-- posting a rollback made. "applicationKey" is the retry barrier: a collision-safe digest of
-- organization, branch, source content hash, source row key, entity type and operation, unique
-- among live (unreleased) rows of the branch, so a retried or concurrent commit of the same
-- source content can apply each row once. It never includes a generated entity id.
CREATE TYPE "PharmacyMigrationEntityOperation" AS ENUM ('CREATED','STOCK_MOVEMENT','STOCK_REVERSAL');
CREATE TABLE "pharmacy_migration_batch_entities" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "rowSourceKey" TEXT NOT NULL CHECK (length(btrim("rowSourceKey")) > 0),
  "applicationKey" TEXT NOT NULL CHECK ("applicationKey" ~ '^[0-9a-f]{64}$'),
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "operation" "PharmacyMigrationEntityOperation" NOT NULL,
  "stockMovementId" TEXT,
  "quantityUnits" INTEGER,
  "reversesEntryId" TEXT,
  "reversedById" TEXT,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_migration_batch_entities_shape_check" CHECK (
    ("operation" = 'CREATED' AND "entityType" = 'PharmacySupplier'
      AND "stockMovementId" IS NULL AND "quantityUnits" IS NULL
      AND "reversesEntryId" IS NULL AND "reversedById" IS NULL)
    OR ("operation" = 'STOCK_MOVEMENT' AND "entityType" = 'PharmacyStockMovement'
      AND "stockMovementId" = "entityId" AND "quantityUnits" > 0
      AND "reversesEntryId" IS NULL AND ("reversedById" IS NULL) = ("releasedAt" IS NULL))
    OR ("operation" = 'STOCK_REVERSAL' AND "entityType" = 'PharmacyStockMovement'
      AND "stockMovementId" = "entityId" AND "quantityUnits" < 0
      AND "reversesEntryId" IS NOT NULL AND "reversedById" IS NULL AND "releasedAt" IS NULL)
  ),
  CONSTRAINT "pharmacy_migration_batch_entities_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_migration_batch_entities_batch_id_key" UNIQUE ("organizationId","branchId","batchId","id"),
  CONSTRAINT "pharmacy_migration_batch_entities_movement_key" UNIQUE ("organizationId","stockMovementId"),
  CONSTRAINT "pharmacy_migration_batch_entities_branch_fkey" FOREIGN KEY ("organizationId","branchId")
    REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_migration_batch_entities_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId")
    REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT,
  -- Reversal provenance is bound to the same organization, branch AND batch by the key itself.
  CONSTRAINT "pharmacy_migration_batch_entities_reversed_by_fkey"
    FOREIGN KEY ("organizationId","branchId","batchId","reversedById")
    REFERENCES "pharmacy_migration_batch_entities"("organizationId","branchId","batchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_migration_batch_entities_reverses_fkey"
    FOREIGN KEY ("organizationId","branchId","batchId","reversesEntryId")
    REFERENCES "pharmacy_migration_batch_entities"("organizationId","branchId","batchId","id") ON DELETE RESTRICT,
  -- The typed ledger identity. Checked at commit so the manifest row can be the first write.
  CONSTRAINT "pharmacy_migration_batch_entities_movement_fkey" FOREIGN KEY ("organizationId","stockMovementId")
    REFERENCES "pharmacy_stock_movements"("organizationId","id") ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX "pharmacy_migration_batch_entities_live_application_key"
  ON "pharmacy_migration_batch_entities"("organizationId","branchId","applicationKey")
  WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "pharmacy_migration_batch_entities_reversed_by_key"
  ON "pharmacy_migration_batch_entities"("organizationId","reversedById") WHERE "reversedById" IS NOT NULL;
CREATE UNIQUE INDEX "pharmacy_migration_batch_entities_reverses_key"
  ON "pharmacy_migration_batch_entities"("organizationId","reversesEntryId") WHERE "reversesEntryId" IS NOT NULL;
CREATE INDEX "pharmacy_migration_batch_entities_batch_operation_idx"
  ON "pharmacy_migration_batch_entities"("organizationId","branchId","batchId","operation");

-- Identity is immutable; a rollback may only set "reversedById" and "releasedAt", once each.
CREATE FUNCTION guard_pharmacy_migration_batch_entity_update() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'reversedById' - 'releasedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'reversedById' - 'releasedAt') THEN
    RAISE EXCEPTION 'pharmacy import commit manifest identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD."reversedById" IS NOT NULL AND NEW."reversedById" IS DISTINCT FROM OLD."reversedById")
     OR (OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt") THEN
    RAISE EXCEPTION 'pharmacy import reversal link is final' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batch_entities_update_guard" BEFORE UPDATE ON "pharmacy_migration_batch_entities"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_batch_entity_update();
CREATE TRIGGER "pharmacy_migration_batch_entities_no_delete" BEFORE DELETE ON "pharmacy_migration_batch_entities"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

-- The ledger invariants the manifest claims, checked when the transaction commits (the manifest
-- row is written before its ledger row): a STOCK_MOVEMENT row names an OPENING posting of the
-- same branch with the same signed quantity; a STOCK_REVERSAL row names the posting that
-- reverses its original's posting, with the exact opposite quantity; a link points both ways.
CREATE FUNCTION assert_pharmacy_migration_batch_entity_ledger() RETURNS trigger AS $$
DECLARE
  movement record;
  original record;
  reversal record;
BEGIN
  IF NEW."operation" = 'CREATED' THEN RETURN NULL; END IF;
  SELECT "branchId", "kind", "quantityUnits", "reversesMovementId" INTO movement
    FROM "pharmacy_stock_movements"
    WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."stockMovementId";
  IF NOT FOUND OR movement."branchId" <> NEW."branchId" OR movement."quantityUnits" <> NEW."quantityUnits" THEN
    RAISE EXCEPTION 'import manifest % does not match its ledger posting', NEW."id" USING ERRCODE = '23514';
  END IF;
  IF NEW."operation" = 'STOCK_MOVEMENT' THEN
    IF movement."kind" <> 'OPENING' OR movement."reversesMovementId" IS NOT NULL THEN
      RAISE EXCEPTION 'import manifest % must name an OPENING posting', NEW."id" USING ERRCODE = '23514';
    END IF;
    IF NEW."reversedById" IS NOT NULL THEN
      SELECT "reversesEntryId" INTO reversal FROM "pharmacy_migration_batch_entities"
        WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."reversedById";
      IF NOT FOUND OR reversal."reversesEntryId" IS DISTINCT FROM NEW."id" THEN
        RAISE EXCEPTION 'import manifest % links a reversal that does not reverse it', NEW."id" USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    SELECT "stockMovementId", "quantityUnits", "operation" INTO original FROM "pharmacy_migration_batch_entities"
      WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."reversesEntryId";
    IF NOT FOUND OR original."operation" <> 'STOCK_MOVEMENT'
       OR movement."reversesMovementId" IS DISTINCT FROM original."stockMovementId"
       OR NEW."quantityUnits" <> -original."quantityUnits" THEN
      RAISE EXCEPTION 'import reversal % is not the exact opposite of its original', NEW."id" USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "pharmacy_migration_batch_entities_ledger_check"
  AFTER INSERT OR UPDATE ON "pharmacy_migration_batch_entities"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_pharmacy_migration_batch_entity_ledger();

-- ── Branch-scoped row-level security ────────────────────────────────────────
CREATE FUNCTION pharmacy_import_branch_allowed(row_org TEXT, row_branch TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT row_org = NULLIF(current_setting('app.current_organization_id', true), '')
     AND row_branch = NULLIF(current_setting('app.current_branch_id', true), '')
$$;
ALTER TABLE "pharmacy_migration_batch_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_batch_entities" FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_migration_sources','pharmacy_migration_batches','pharmacy_migration_rows','pharmacy_migration_exceptions','pharmacy_migration_batch_entities'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (pharmacy_import_branch_allowed("organizationId","branchId"))', t || '_branch_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"))', t || '_branch_insert', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['pharmacy_migration_batches','pharmacy_migration_exceptions','pharmacy_migration_batch_entities'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (pharmacy_import_branch_allowed("organizationId","branchId")) WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"))', t || '_branch_update', t);
  END LOOP;
  -- Platform operators see legacy evidence and may move it out of legacy exactly once.
  FOREACH t IN ARRAY ARRAY['pharmacy_migration_sources','pharmacy_migration_batches','pharmacy_migration_rows','pharmacy_migration_exceptions'] LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (current_setting(''app.is_platform_admin'', true) = ''true'' AND "legacy")', t || '_legacy_platform_select', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (current_setting(''app.is_platform_admin'', true) = ''true'' AND "legacy" AND "branchId" IS NULL) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' AND "legacy" AND "branchId" IS NOT NULL)', t || '_legacy_platform_remediate', t);
  END LOOP;
END $$;

CREATE FUNCTION guard_pharmacy_migration_batch_transition() RETURNS trigger AS $$
DECLARE allowed boolean;
BEGIN
  -- Assigned first: PL/pgSQL would end an IF condition at the CASE's first THEN.
  allowed := CASE OLD.status
    WHEN 'UPLOADED' THEN NEW.status IN ('PARSING','FAILED')
    WHEN 'PARSING' THEN NEW.status IN ('PREVIEW','FAILED')
    WHEN 'PREVIEW' THEN NEW.status IN ('PARSING','COMMITTING','FAILED')
    WHEN 'COMMITTING' THEN NEW.status IN ('COMMITTED','FAILED')
    WHEN 'COMMITTED' THEN NEW.status = 'ROLLED_BACK'
    WHEN 'FAILED' THEN NEW.status = 'PARSING'
    ELSE false END;
  IF NEW.status <> OLD.status AND NOT allowed THEN
    RAISE EXCEPTION 'illegal pharmacy import batch transition: % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND OLD."legacy" THEN
    RAISE EXCEPTION 'legacy import evidence cannot change state' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batches_transition_guard" BEFORE UPDATE OF status ON "pharmacy_migration_batches"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_batch_transition();
COMMIT;
