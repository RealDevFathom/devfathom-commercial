-- PH-INV / INV-01, INV-02, INV-03, INV-04.
--
-- The append-only batch/lot stock ledger. On-hand is a PROJECTION maintained by
-- a trigger from the ledger, never written by the application, and constrained
-- non-negative, so a negative balance is unrepresentable rather than merely
-- unreached (INV-01, §8A invariant 6).

CREATE TYPE "PharmacyStockLocationKind" AS ENUM ('STORE','RACK_BIN','FRIDGE','SAFE','QUARANTINE','TRANSIT','RETURNS');
CREATE TYPE "PharmacyBatchState" AS ENUM ('ACTIVE','RECALLED','QUARANTINED');
CREATE TYPE "PharmacyExpiryPrecision" AS ENUM ('DAY','MONTH');
CREATE TYPE "PharmacyStockDisposition" AS ENUM ('AVAILABLE','QUARANTINE','DAMAGED','DESTROYED','IN_TRANSIT');
CREATE TYPE "PharmacyStockMovementKind" AS ENUM ('RECEIPT','SALE','RETURN','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT','WRITE_OFF','BREAK_PACK');

-- Composite tenant keys on the MED-01/MED-02 tables this ledger points at. A
-- plain `id` reference would let a caller name another tenant's medicine or
-- pack level; the (organizationId, id) foreign keys below cannot.
ALTER TABLE "pharmacy_medicines" ADD CONSTRAINT "pharmacy_medicines_org_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_pack_levels" ADD CONSTRAINT "pharmacy_pack_levels_org_id_key" UNIQUE ("organizationId", "id");

-- INV-05 seam: the storage places a lot can sit in. Branch-owned (PLAT-04);
-- `coldChain` marks the validated cold-chain zones INV-05 puts away into.
CREATE TABLE "pharmacy_stock_locations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" "PharmacyStockLocationKind" NOT NULL,
  "coldChain" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_stock_locations_branch_check" CHECK (length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_stock_locations_code_check" CHECK (length(btrim("code")) > 0),
  CONSTRAINT "pharmacy_stock_locations_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_stock_locations_org_branch_code_key" UNIQUE ("organizationId", "branchId", "code")
);
CREATE INDEX "pharmacy_stock_locations_org_branch_idx" ON "pharmacy_stock_locations"("organizationId", "branchId");

-- §8A invariant 18: the manufacturing batch is organization-scoped because
-- recall and batch-level quarantine apply globally at batch/product scope. Only
-- the inventory lots hanging off it are branch-owned.
CREATE TABLE "pharmacy_manufacturing_batches" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL,
  "batchNumber" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "expiryPrecision" "PharmacyExpiryPrecision" NOT NULL DEFAULT 'DAY',
  "state" "PharmacyBatchState" NOT NULL DEFAULT 'ACTIVE',
  "stateReason" TEXT,
  "stateChangedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_manufacturing_batches_number_check" CHECK (length(btrim("batchNumber")) > 0),
  CONSTRAINT "pharmacy_manufacturing_batches_state_evidence_check"
    CHECK (("state" = 'ACTIVE' AND "stateReason" IS NULL) OR ("state" <> 'ACTIVE' AND length(btrim("stateReason")) > 0 AND "stateChangedAt" IS NOT NULL)),
  CONSTRAINT "pharmacy_manufacturing_batches_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_manufacturing_batches_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_manufacturing_batches_org_medicine_number_key" UNIQUE ("organizationId", "medicineId", "batchNumber")
);
CREATE INDEX "pharmacy_manufacturing_batches_org_expiry_idx" ON "pharmacy_manufacturing_batches"("organizationId", "expiresAt");

-- INV-01: the receipt-specific lot. §8A invariant 18 — one manufacturing batch
-- may carry many lots with different suppliers, invoices, costs, printed MRPs
-- and received expiry precision. `receivedAt IS NULL` is unreceived stock and
-- the ledger trigger below refuses to move it (INV-03).
CREATE TABLE "pharmacy_inventory_lots" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "manufacturingBatchId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "unitsPerPack" INTEGER NOT NULL,
  "supplierName" TEXT NOT NULL,
  "supplierInvoiceRef" TEXT NOT NULL,
  "unitCostMinor" INTEGER NOT NULL,
  "printedMrpMinor" INTEGER NOT NULL,
  "receivedExpiresAt" TIMESTAMP(3) NOT NULL,
  "receivedExpiryPrecision" "PharmacyExpiryPrecision" NOT NULL,
  "receivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_inventory_lots_branch_check" CHECK (length(btrim("branchId")) > 0),
  CONSTRAINT "pharmacy_inventory_lots_units_check" CHECK ("unitsPerPack" > 0),
  CONSTRAINT "pharmacy_inventory_lots_money_check" CHECK ("unitCostMinor" >= 0 AND "printedMrpMinor" >= 0),
  CONSTRAINT "pharmacy_inventory_lots_supplier_check" CHECK (length(btrim("supplierName")) > 0 AND length(btrim("supplierInvoiceRef")) > 0),
  CONSTRAINT "pharmacy_inventory_lots_batch_fkey"
    FOREIGN KEY ("organizationId", "manufacturingBatchId") REFERENCES "pharmacy_manufacturing_batches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_inventory_lots_pack_level_fkey"
    FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_inventory_lots_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_inventory_lots_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_inventory_lots_org_invoice_key" UNIQUE ("organizationId", "supplierName", "supplierInvoiceRef", "manufacturingBatchId")
);
CREATE INDEX "pharmacy_inventory_lots_org_branch_batch_idx" ON "pharmacy_inventory_lots"("organizationId", "branchId", "manufacturingBatchId");

-- INV-02: the evidence a non-FEFO selection leaves behind (§8A invariant 5).
CREATE TABLE "pharmacy_allocation_overrides" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "approvalPolicy" TEXT NOT NULL,
  "recommendedLotId" TEXT NOT NULL,
  "selectedLotId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_allocation_overrides_evidence_check"
    CHECK (length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0 AND length(btrim("approvalPolicy")) > 0),
  CONSTRAINT "pharmacy_allocation_overrides_distinct_check" CHECK ("recommendedLotId" <> "selectedLotId"),
  CONSTRAINT "pharmacy_allocation_overrides_recommended_fkey"
    FOREIGN KEY ("organizationId", "branchId", "recommendedLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_allocation_overrides_selected_fkey"
    FOREIGN KEY ("organizationId", "branchId", "selectedLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_allocation_overrides_org_id_key" UNIQUE ("organizationId", "id")
);
CREATE INDEX "pharmacy_allocation_overrides_org_branch_created_idx" ON "pharmacy_allocation_overrides"("organizationId", "branchId", "createdAt");

-- INV-01: the ledger. Append-only (§8A invariant 8), signed integer canonical
-- units (§8A invariant 1), plus the sealed/open deltas that make a BREAK_PACK a
-- real movement rather than a reinterpretation of the same stock (INV-04).
CREATE TABLE "pharmacy_stock_movements" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "kind" "PharmacyStockMovementKind" NOT NULL,
  "disposition" "PharmacyStockDisposition" NOT NULL,
  "quantityUnits" INTEGER NOT NULL,
  "sealedPackDelta" INTEGER NOT NULL DEFAULT 0,
  "looseUnitDelta" INTEGER NOT NULL DEFAULT 0,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "allocationOverrideId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_movements_actor_check" CHECK (length(btrim("actorId")) > 0),
  -- The sign of a movement is a property of its kind, not of the caller.
  CONSTRAINT "pharmacy_stock_movements_direction_check" CHECK (
    ("kind" IN ('RECEIPT','RETURN','TRANSFER_IN') AND "quantityUnits" > 0)
    OR ("kind" IN ('SALE','TRANSFER_OUT','WRITE_OFF') AND "quantityUnits" < 0)
    OR ("kind" = 'ADJUSTMENT' AND "quantityUnits" <> 0)
    OR ("kind" = 'BREAK_PACK' AND "quantityUnits" = 0 AND "sealedPackDelta" < 0 AND "looseUnitDelta" > 0)
  ),
  CONSTRAINT "pharmacy_stock_movements_override_only_on_sale_check"
    CHECK ("allocationOverrideId" IS NULL OR "kind" = 'SALE'),
  CONSTRAINT "pharmacy_stock_movements_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_movements_location_fkey"
    FOREIGN KEY ("organizationId", "stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_movements_override_fkey"
    FOREIGN KEY ("organizationId", "allocationOverrideId") REFERENCES "pharmacy_allocation_overrides"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_movements_org_idempotency_key" UNIQUE ("organizationId", "idempotencyKey")
);
CREATE INDEX "pharmacy_stock_movements_org_branch_lot_idx" ON "pharmacy_stock_movements"("organizationId", "branchId", "inventoryLotId", "occurredAt");

-- INV-01 acceptance: "product quantity is a projection". This table is derived
-- state; only `pharmacy_apply_stock_movement` writes it, and the CHECKs make a
-- negative or non-reconciling balance unrepresentable.
CREATE TABLE "pharmacy_stock_balances" (
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "inventoryLotId" TEXT NOT NULL,
  "stockLocationId" TEXT NOT NULL,
  "disposition" "PharmacyStockDisposition" NOT NULL,
  "onHandUnits" INTEGER NOT NULL,
  "sealedPacks" INTEGER NOT NULL,
  "looseUnits" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_balances_pkey" PRIMARY KEY ("organizationId", "inventoryLotId", "stockLocationId", "disposition"),
  CONSTRAINT "pharmacy_stock_balances_non_negative_check"
    CHECK ("onHandUnits" >= 0 AND "sealedPacks" >= 0 AND "looseUnits" >= 0),
  CONSTRAINT "pharmacy_stock_balances_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_balances_location_fkey"
    FOREIGN KEY ("organizationId", "stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_stock_balances_org_branch_idx" ON "pharmacy_stock_balances"("organizationId", "branchId", "disposition");

-- §8A invariant 6: the emergency path records what could not be satisfied
-- instead of driving a balance below zero. Closure belongs to INV-06's counts
-- and adjustments, so this table only ever gains rows here.
CREATE TABLE "pharmacy_stock_discrepancies" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "inventoryLotId" TEXT,
  "stockLocationId" TEXT,
  "requestedUnits" INTEGER NOT NULL,
  "allocatedUnits" INTEGER NOT NULL,
  "shortfallUnits" INTEGER NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_stock_discrepancies_units_check"
    CHECK ("requestedUnits" > 0 AND "allocatedUnits" >= 0 AND "shortfallUnits" > 0 AND "allocatedUnits" + "shortfallUnits" = "requestedUnits"),
  CONSTRAINT "pharmacy_stock_discrepancies_evidence_check"
    CHECK (length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0),
  CONSTRAINT "pharmacy_stock_discrepancies_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_discrepancies_location_fkey"
    FOREIGN KEY ("organizationId", "stockLocationId") REFERENCES "pharmacy_stock_locations"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_stock_discrepancies_org_id_key" UNIQUE ("organizationId", "id")
);
CREATE INDEX "pharmacy_stock_discrepancies_org_branch_created_idx" ON "pharmacy_stock_discrepancies"("organizationId", "branchId", "createdAt");

-- ── Ledger enforcement ──────────────────────────────────────────────────────

/*
 * Every posted movement passes through here, so the invariants below hold no
 * matter which caller writes: the lot and location live in the movement's own
 * tenant and branch, unreceived stock cannot move, the sealed/open deltas
 * reconcile to the canonical units, and the projection is updated in the same
 * statement. The ON CONFLICT DO UPDATE takes the balance row lock, so two
 * concurrent sales of the same last unit serialize here and the second one
 * meets the non-negative CHECK.
 */
CREATE FUNCTION pharmacy_apply_stock_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot_branch text; lot_received timestamp(3); lot_units integer;
  location_branch text;
BEGIN
  SELECT "branchId", "receivedAt", "unitsPerPack" INTO lot_branch, lot_received, lot_units
  FROM "pharmacy_inventory_lots"
  WHERE "id" = NEW."inventoryLotId" AND "organizationId" = NEW."organizationId";
  IF lot_branch IS NULL OR lot_branch IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'stock movement must name a lot in its own tenant and branch' USING ERRCODE = '23514';
  END IF;

  SELECT "branchId" INTO location_branch FROM "pharmacy_stock_locations"
  WHERE "id" = NEW."stockLocationId" AND "organizationId" = NEW."organizationId";
  IF location_branch IS NULL OR location_branch IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'stock movement must name a location in its own tenant and branch' USING ERRCODE = '23514';
  END IF;

  IF lot_received IS NULL AND NEW."kind" <> 'RECEIPT' THEN
    RAISE EXCEPTION 'unreceived stock cannot move' USING ERRCODE = '23514';
  END IF;

  -- INV-04: total canonical units and the physical arrangement are one fact.
  IF NEW."sealedPackDelta"::bigint * lot_units + NEW."looseUnitDelta" <> NEW."quantityUnits" THEN
    RAISE EXCEPTION 'movement arrangement must reconcile to its canonical units' USING ERRCODE = '23514';
  END IF;

  /*
   * UPDATE FIRST, INSERT ONLY IF ABSENT — deliberately NOT
   * `INSERT … ON CONFLICT DO UPDATE`. PostgreSQL evaluates a table's CHECK
   * constraints on the proposed tuple BEFORE it arbitrates the unique-index
   * conflict, so the DO UPDATE form would test the raw delta (e.g. -20) against
   * `pharmacy_stock_balances_non_negative_check` and fail every decrement
   * before reaching the addition.
   *
   * The UPDATE also takes the balance row lock, which is what serializes two
   * concurrent sales of the same last unit. The loop only re-runs when another
   * transaction created the same brand-new bucket first.
   */
  LOOP
    UPDATE "pharmacy_stock_balances" SET
      "onHandUnits" = "onHandUnits" + NEW."quantityUnits",
      "sealedPacks" = "sealedPacks" + NEW."sealedPackDelta",
      "looseUnits"  = "looseUnits"  + NEW."looseUnitDelta",
      "updatedAt"   = CURRENT_TIMESTAMP
    WHERE "organizationId"  = NEW."organizationId"
      AND "inventoryLotId"  = NEW."inventoryLotId"
      AND "stockLocationId" = NEW."stockLocationId"
      AND "disposition"     = NEW."disposition";
    EXIT WHEN FOUND;

    BEGIN
      INSERT INTO "pharmacy_stock_balances" (
        "organizationId","branchId","inventoryLotId","stockLocationId","disposition",
        "onHandUnits","sealedPacks","looseUnits","updatedAt")
      VALUES (
        NEW."organizationId", NEW."branchId", NEW."inventoryLotId", NEW."stockLocationId",
        NEW."disposition", NEW."quantityUnits", NEW."sealedPackDelta", NEW."looseUnitDelta",
        CURRENT_TIMESTAMP);
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent movement opened this bucket first; fold into it instead.
    END;
  END LOOP;

  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_stock_movement_applies AFTER INSERT ON "pharmacy_stock_movements"
FOR EACH ROW EXECUTE FUNCTION pharmacy_apply_stock_movement();

/*
 * The projection is only ever a function of the ledger. A statement issued
 * directly against the balance table runs at trigger depth 1; the maintenance
 * path above reaches it from inside the movement trigger, at depth 2.
 */
CREATE FUNCTION pharmacy_reject_direct_balance_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'stock balances are a projection of the ledger; post a stock movement' USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pharmacy_stock_balances_projection_only
BEFORE INSERT OR UPDATE OR DELETE ON "pharmacy_stock_balances"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_direct_balance_write();

-- §8A invariant 8: a stock movement, its override evidence and its discrepancy
-- record are never rewritten or hard-deleted.
CREATE TRIGGER pharmacy_stock_movements_append_only BEFORE UPDATE OR DELETE ON "pharmacy_stock_movements"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_allocation_overrides_append_only BEFORE UPDATE OR DELETE ON "pharmacy_allocation_overrides"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_stock_discrepancies_append_only BEFORE UPDATE OR DELETE ON "pharmacy_stock_discrepancies"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

/*
 * MED-02: a pack conversion is immutable once stock references it. Receiving a
 * lot is that reference, so it stamps `referencedAt` and the medicine lane's
 * `pharmacy_pack_conversion_immutable` trigger takes over from there.
 */
CREATE FUNCTION pharmacy_mark_pack_level_referenced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "pharmacy_pack_levels" SET "referencedAt" = COALESCE("referencedAt", CURRENT_TIMESTAMP)
  WHERE "id" = NEW."packLevelId" AND "organizationId" = NEW."organizationId" AND "referencedAt" IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_inventory_lot_references_pack AFTER INSERT ON "pharmacy_inventory_lots"
FOR EACH ROW EXECUTE FUNCTION pharmacy_mark_pack_level_referenced();

-- Lots and batches are correctable, but never disappear: history that a ledger
-- row points at cannot be deleted out from under it.
CREATE FUNCTION pharmacy_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are never hard-deleted', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER pharmacy_inventory_lots_no_delete BEFORE DELETE ON "pharmacy_inventory_lots"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();
CREATE TRIGGER pharmacy_manufacturing_batches_no_delete BEFORE DELETE ON "pharmacy_manufacturing_batches"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

-- ── Row level security (NFR-03) ─────────────────────────────────────────────
--
-- Organization is the tenant boundary. `app.current_branch_id` is an optional
-- narrowing: when a caller sets it, the policy also refuses rows from any other
-- branch, so a branch-scoped session cannot reach branch-owned rows even by
-- naming their ids directly (PLAT-04).
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pharmacy_stock_locations','pharmacy_inventory_lots','pharmacy_allocation_overrides',
    'pharmacy_stock_movements','pharmacy_stock_balances','pharmacy_stock_discrepancies'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_branch_isolation ON %I USING (%s) WITH CHECK (%s)',
      table_name,
      'current_setting(''app.is_platform_admin'', true) = ''true'' OR ('
        || '"organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') '
        || 'AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL '
        || 'OR "branchId" = current_setting(''app.current_branch_id'', true)))',
      'current_setting(''app.is_platform_admin'', true) = ''true'' OR ('
        || '"organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') '
        || 'AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL '
        || 'OR "branchId" = current_setting(''app.current_branch_id'', true)))'
    );
  END LOOP;
END $$;

-- The manufacturing batch has no branch: recall state is organization-wide.
ALTER TABLE "pharmacy_manufacturing_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_manufacturing_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_manufacturing_batches"
USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
