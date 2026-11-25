BEGIN;
ALTER TYPE "PharmacyStockDisposition" ADD VALUE 'WAREHOUSE_RESERVED';

CREATE TABLE pharmacy_warehouse_orders (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "toBranchId" text NOT NULL, "transferId" text, status text NOT NULL DEFAULT 'OPEN',
  "createdById" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT warehouse_order_org_branch_key UNIQUE ("organizationId", "branchId", id),
  CHECK ("branchId" <> "toBranchId" AND status IN ('OPEN','CANCELLED','CLOSED')),
  FOREIGN KEY ("organizationId","branchId") REFERENCES pharmacy_branches ("organizationId",id),
  FOREIGN KEY ("organizationId","toBranchId") REFERENCES pharmacy_branches ("organizationId",id),
  FOREIGN KEY ("organizationId","transferId") REFERENCES pharmacy_interbranch_transfers ("organizationId",id)
);
CREATE INDEX "pharmacy_warehouse_orders_organizationId_branchId_status_idx" ON pharmacy_warehouse_orders("organizationId","branchId",status);
CREATE TABLE pharmacy_warehouse_demands (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "orderId" text NOT NULL, "medicineId" text NOT NULL, "destinationStockLocationId" text NOT NULL,
  "requestedUnits" integer NOT NULL CHECK ("requestedUnits" > 0),
  CONSTRAINT warehouse_demand_order_key UNIQUE ("organizationId","branchId","orderId",id),
  UNIQUE ("orderId","medicineId"),
  FOREIGN KEY ("organizationId","branchId","orderId") REFERENCES pharmacy_warehouse_orders("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","medicineId") REFERENCES pharmacy_medicines("organizationId",id),
  FOREIGN KEY ("organizationId","destinationStockLocationId") REFERENCES pharmacy_stock_locations("organizationId",id)
);
CREATE TABLE pharmacy_warehouse_reservations (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL, "orderId" text NOT NULL,
  "demandId" text NOT NULL, "transferId" text NOT NULL, "transferLineId" text NOT NULL UNIQUE,
  "inventoryLotId" text NOT NULL, "sourceStockLocationId" text NOT NULL, "stagingStockLocationId" text,
  "quantityUnits" integer NOT NULL CHECK ("quantityUnits" > 0),
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','PICKED','PACKED','DISPATCHED','CANCELLED')),
  FOREIGN KEY ("organizationId","branchId","orderId") REFERENCES pharmacy_warehouse_orders("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","branchId","orderId","demandId") REFERENCES pharmacy_warehouse_demands("organizationId","branchId","orderId",id),
  FOREIGN KEY ("organizationId","transferId") REFERENCES pharmacy_interbranch_transfers("organizationId",id),
  FOREIGN KEY ("transferLineId") REFERENCES pharmacy_interbranch_transfer_lines(id),
  FOREIGN KEY ("organizationId","branchId","inventoryLotId") REFERENCES pharmacy_inventory_lots("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","branchId","sourceStockLocationId") REFERENCES pharmacy_stock_locations("organizationId","branchId",id),
  FOREIGN KEY ("organizationId","branchId","stagingStockLocationId") REFERENCES pharmacy_stock_locations("organizationId","branchId",id)
);
CREATE INDEX "warehouse_reservation_transfer_idx" ON pharmacy_warehouse_reservations("organizationId","branchId","transferId");
CREATE INDEX "warehouse_reservation_lot_idx" ON pharmacy_warehouse_reservations("organizationId","inventoryLotId",state);
CREATE TABLE pharmacy_warehouse_commands (
  id text PRIMARY KEY, "organizationId" text NOT NULL, "branchId" text NOT NULL,
  "orderId" text NOT NULL, "actorId" text NOT NULL, kind text NOT NULL, key text NOT NULL,
  payload jsonb NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","branchId",key),
  FOREIGN KEY ("organizationId","branchId","orderId") REFERENCES pharmacy_warehouse_orders("organizationId","branchId",id)
);
CREATE INDEX "warehouse_command_order_idx" ON pharmacy_warehouse_commands("organizationId","branchId","orderId");
-- Stock handlers run organization-scoped transactions. A branch-scoped inspection can read
-- its inbound and outbound orders, while mutations belong to the source warehouse.
DO $$
DECLARE
  t text;
  scoped text := '"organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')';
  branch text := 'NULLIF(current_setting(''app.current_branch_id'', true), '''')';
  platform text := 'current_setting(''app.is_platform_admin'', true) = ''true''';
  reading text;
  writing text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_warehouse_orders','pharmacy_warehouse_demands','pharmacy_warehouse_reservations','pharmacy_warehouse_commands'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    writing := format('(%s OR (%s AND (%s IS NULL OR "branchId" = %s)))',platform,scoped,branch,branch);
    IF t = 'pharmacy_warehouse_orders' THEN
      reading := format('(%s OR (%s AND (%s IS NULL OR %s IN ("branchId", "toBranchId"))))',platform,scoped,branch,branch);
    ELSE
      reading := format('(%s OR (%s AND (%s IS NULL OR "branchId" = %s OR EXISTS (
        SELECT 1 FROM pharmacy_warehouse_orders parent WHERE parent.id = %I."orderId"
          AND parent."organizationId" = %I."organizationId" AND parent."toBranchId" = %s))))',
        platform,scoped,branch,branch,t,t,branch);
    END IF;
    EXECUTE format('CREATE POLICY warehouse_read ON %I FOR SELECT USING (%s)',t,reading);
    EXECUTE format('CREATE POLICY warehouse_write ON %I FOR ALL USING (%s) WITH CHECK (%s)',t,writing,writing);
  END LOOP;
END $$;
CREATE FUNCTION pharmacy_warehouse_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Warehouse command evidence is immutable';
END $$;
CREATE TRIGGER warehouse_command_immutable BEFORE UPDATE OR DELETE ON pharmacy_warehouse_commands
FOR EACH ROW EXECUTE FUNCTION pharmacy_warehouse_command_immutable();
ALTER TABLE pharmacy_warehouse_requests
  ADD CONSTRAINT warehouse_request_order_fkey FOREIGN KEY ("organizationId","warehouseBranchId","orderId")
  REFERENCES pharmacy_warehouse_orders("organizationId","branchId",id);
COMMIT;
