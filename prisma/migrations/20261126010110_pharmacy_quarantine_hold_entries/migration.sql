BEGIN;
SET LOCAL lock_timeout = '10s';

-- DEV-1052: who owns a manual quarantine hold. Placing a hold needed the safety permission,
-- but releasing one needed only the inventory permission, and nothing recorded who had placed
-- it. Each row here is one signed quantity of manually held units at one lot and location:
-- positive when a hold is placed, negative when it is released or leaves quarantine another
-- way. The open units of each authority are the sum of its rows. Units a DRAP recall holds
-- stay in pharmacy_recall_quarantine_actions and never appear here.
CREATE TABLE IF NOT EXISTS "pharmacy_quarantine_hold_entries" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" text NOT NULL,
  "inventoryLotId" text NOT NULL,
  "stockLocationId" text NOT NULL,
  "authority" text NOT NULL CHECK ("authority" IN ('SAFETY', 'INVENTORY')),
  "origin" text NOT NULL CHECK ("origin" IN (
    'MANUAL', 'EXPIRY', 'CUSTOMER_RETURN', 'DELIVERY_RETURN', 'GOODS_IN',
    'LEGACY', 'UNATTRIBUTED', 'RELEASE', 'REMOVED'
  )),
  "quantityUnits" integer NOT NULL CHECK ("quantityUnits" <> 0),
  "movementId" text,
  "actorId" text,
  "reason" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_quarantine_hold_entries_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_quarantine_hold_entries_movement_key"
    UNIQUE ("organizationId", "movementId", "authority"),
  CONSTRAINT "pharmacy_quarantine_hold_entries_lot_fkey"
    FOREIGN KEY ("organizationId", "branchId", "inventoryLotId")
    REFERENCES "pharmacy_inventory_lots" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_quarantine_hold_entries_location_fkey"
    FOREIGN KEY ("organizationId", "stockLocationId")
    REFERENCES "pharmacy_stock_locations" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_quarantine_hold_entries_movement_fkey"
    FOREIGN KEY ("organizationId", "movementId")
    REFERENCES "pharmacy_stock_movements" ("organizationId", "id") ON DELETE RESTRICT,
  -- A hold a person or a workflow placed names the movement and the person.
  CONSTRAINT "pharmacy_quarantine_hold_entries_placed_check" CHECK (
    "origin" NOT IN ('MANUAL', 'EXPIRY', 'CUSTOMER_RETURN', 'DELIVERY_RETURN', 'GOODS_IN')
    OR ("quantityUnits" > 0 AND "movementId" IS NOT NULL AND "actorId" IS NOT NULL)
  ),
  -- Only a person with the safety permission places a hold by hand; workflows hold for inventory.
  CONSTRAINT "pharmacy_quarantine_hold_entries_owner_check" CHECK (
    ("origin" = 'MANUAL' AND "authority" = 'SAFETY')
    OR ("origin" IN ('EXPIRY', 'CUSTOMER_RETURN', 'DELIVERY_RETURN', 'GOODS_IN')
        AND "authority" = 'INVENTORY')
    OR ("origin" IN ('LEGACY', 'UNATTRIBUTED') AND "authority" = 'SAFETY' AND "quantityUnits" > 0)
    OR "origin" IN ('RELEASE', 'REMOVED')
  ),
  -- A release names the movement, the person and the reason.
  CONSTRAINT "pharmacy_quarantine_hold_entries_release_check" CHECK (
    "origin" <> 'RELEASE'
    OR ("quantityUnits" < 0 AND "movementId" IS NOT NULL AND "actorId" IS NOT NULL
        AND length(btrim(COALESCE("reason", ''))) > 0)
  ),
  CONSTRAINT "pharmacy_quarantine_hold_entries_removed_check" CHECK (
    "origin" <> 'REMOVED' OR "quantityUnits" < 0
  )
);
CREATE INDEX IF NOT EXISTS "pharmacy_quarantine_hold_entries_position_idx"
  ON "pharmacy_quarantine_hold_entries" ("organizationId", "branchId", "inventoryLotId", "stockLocationId");

ALTER TABLE "pharmacy_quarantine_hold_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_quarantine_hold_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_quarantine_hold_entries";
CREATE POLICY tenant_branch_isolation ON "pharmacy_quarantine_hold_entries"
  USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))))
  WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))));

-- Append-only: a row is evidence of who held or released stock.
CREATE OR REPLACE FUNCTION pharmacy_quarantine_hold_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'quarantine hold entries are append-only' USING ERRCODE = '55000';
END $$;
CREATE OR REPLACE TRIGGER pharmacy_quarantine_hold_entries_immutable
  BEFORE UPDATE OR DELETE ON "pharmacy_quarantine_hold_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_quarantine_hold_entries_immutable();
CREATE OR REPLACE TRIGGER pharmacy_quarantine_hold_entries_no_truncate
  BEFORE TRUNCATE ON "pharmacy_quarantine_hold_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION pharmacy_quarantine_hold_entries_immutable();

-- No authority can give back more units than it holds at a position. Every writer holds the
-- position's QUARANTINE balance lock, so the sum read here cannot change underneath it.
CREATE OR REPLACE FUNCTION pharmacy_quarantine_hold_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE held bigint;
BEGIN
  IF NEW."quantityUnits" < 0 THEN
    SELECT COALESCE(SUM(e."quantityUnits"), 0) INTO held
    FROM "pharmacy_quarantine_hold_entries" e
    WHERE e."organizationId" = NEW."organizationId" AND e."branchId" = NEW."branchId"
      AND e."inventoryLotId" = NEW."inventoryLotId"
      AND e."stockLocationId" = NEW."stockLocationId" AND e."authority" = NEW."authority";
    IF held + NEW."quantityUnits" < 0 THEN
      RAISE EXCEPTION 'quarantine release exceeds the units this authority holds'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER pharmacy_quarantine_hold_entries_guard
  BEFORE INSERT ON "pharmacy_quarantine_hold_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_quarantine_hold_entries_guard();

-- Existing manual holds have no recorded owner: treat every such unit as a safety hold.
-- One organization at a time, because the stock tables force row-level security on the
-- migration owner too. This writes ownership rows only; no stock quantity changes.
-- Re-running adds nothing: a position whose units are already owned has no difference left.
SELECT set_config('app.is_platform_admin', 'true', true);
DO $$
DECLARE tenant_id text;
BEGIN
  FOR tenant_id IN SELECT "id" FROM "organizations" ORDER BY "id" LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    PERFORM set_config('app.current_branch_id', '', true);
    INSERT INTO "pharmacy_quarantine_hold_entries"
      ("id", "organizationId", "branchId", "inventoryLotId", "stockLocationId",
       "authority", "origin", "quantityUnits", "reason")
    SELECT 'qhe_legacy_' || md5(b."organizationId" || ':' || b."inventoryLotId" || ':' ||
             b."stockLocationId" || ':' || clock_timestamp()::text),
           b."organizationId", b."branchId", b."inventoryLotId", b."stockLocationId",
           'SAFETY', 'LEGACY', b."onHandUnits" - recall.units - owned.units,
           'Held before hold ownership was recorded'
    FROM "pharmacy_stock_balances" b
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(a."quantityUnits"), 0)::integer AS units
      FROM "pharmacy_recall_quarantine_actions" a
      WHERE a."organizationId" = b."organizationId" AND a."branchId" = b."branchId"
        AND a."inventoryLotId" = b."inventoryLotId"
        AND a."stockLocationId" = b."stockLocationId" AND a."reversedAt" IS NULL
    ) recall
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(e."quantityUnits"), 0)::integer AS units
      FROM "pharmacy_quarantine_hold_entries" e
      WHERE e."organizationId" = b."organizationId" AND e."branchId" = b."branchId"
        AND e."inventoryLotId" = b."inventoryLotId"
        AND e."stockLocationId" = b."stockLocationId"
    ) owned
    WHERE b."organizationId" = tenant_id AND b."disposition" = 'QUARANTINE'
      AND b."onHandUnits" - recall.units - owned.units > 0;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;
SELECT set_config('app.is_platform_admin', '', true);

COMMIT;
