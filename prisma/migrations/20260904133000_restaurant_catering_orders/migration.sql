CREATE TYPE "RestaurantCateringOrderStatus" AS ENUM ('DRAFT', 'QUOTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'DELIVERED', 'CLOSED', 'CANCELLED');
CREATE TYPE "RestaurantCateringExtraCostKind" AS ENUM ('LABOUR', 'TRANSPORT', 'RENTAL', 'OTHER');

CREATE TABLE "restaurant_catering_orders" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT,
  "eventName" TEXT NOT NULL,
  "eventDate" DATE NOT NULL,
  "serviceTime" TIME(0),
  "headcount" INTEGER NOT NULL,
  "venueAddress" TEXT,
  "deliveryAddressId" TEXT,
  "status" "RestaurantCateringOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "quotedTotal" DECIMAL(12,2),
  "depositAmount" DECIMAL(12,2),
  "notes" TEXT,
  "createdByStaffId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_catering_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_catering_orders_values_check" CHECK ("headcount" > 0 AND ("quotedTotal" IS NULL OR "quotedTotal" >= 0) AND ("depositAmount" IS NULL OR "depositAmount" >= 0)),
  CONSTRAINT "restaurant_catering_orders_delivery_customer_check" CHECK ("deliveryAddressId" IS NULL OR "customerId" IS NOT NULL),
  CONSTRAINT "restaurant_catering_orders_organizationId_id_key" UNIQUE ("organizationId", "id")
);

CREATE TABLE "restaurant_catering_order_lines" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "recipeId" TEXT,
  "description" TEXT NOT NULL,
  "portions" DECIMAL(12,3) NOT NULL,
  "unitPrice" DECIMAL(12,2) NOT NULL,
  "costPerPortionSnapshot" DECIMAL(12,4),
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_catering_order_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_catering_order_lines_reference_check" CHECK ("productId" IS NOT NULL OR "recipeId" IS NOT NULL),
  CONSTRAINT "restaurant_catering_order_lines_values_check" CHECK ("portions" > 0 AND "unitPrice" >= 0 AND ("costPerPortionSnapshot" IS NULL OR "costPerPortionSnapshot" >= 0) AND "sortOrder" >= 0)
);

CREATE TABLE "restaurant_catering_extra_costs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "orderId" TEXT NOT NULL,
  "kind" "RestaurantCateringExtraCostKind" NOT NULL,
  "label" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_catering_extra_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_catering_extra_costs_amount_check" CHECK ("amount" >= 0)
);

CREATE TABLE "restaurant_catering_deliveries" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "orderId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL,
  "dispatchedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "driverStaffId" TEXT,
  "vehicle" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_catering_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_catering_deliveries_orderId_key" UNIQUE ("orderId"),
  CONSTRAINT "restaurant_catering_deliveries_organizationId_orderId_key" UNIQUE ("organizationId", "orderId"),
  CONSTRAINT "restaurant_catering_deliveries_timestamps_check" CHECK (("deliveredAt" IS NULL OR "dispatchedAt" IS NOT NULL) AND ("dispatchedAt" IS NULL OR "dispatchedAt" >= "scheduledAt") AND ("deliveredAt" IS NULL OR "deliveredAt" >= "dispatchedAt"))
);

CREATE TABLE "restaurant_catering_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "orderId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "actorStaffProfileId" TEXT,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_catering_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_catering_events_orderId_sequence_key" UNIQUE ("orderId", "sequence")
);

CREATE INDEX "restaurant_catering_orders_organizationId_branchId_eventDate_idx" ON "restaurant_catering_orders" ("organizationId", "branchId", "eventDate");
CREATE INDEX "restaurant_catering_orders_organizationId_status_idx" ON "restaurant_catering_orders" ("organizationId", "status");
CREATE INDEX "restaurant_catering_orders_customerId_idx" ON "restaurant_catering_orders" ("customerId");
CREATE INDEX "restaurant_catering_order_lines_organizationId_orderId_sortOrder_idx" ON "restaurant_catering_order_lines" ("organizationId", "orderId", "sortOrder");
CREATE INDEX "restaurant_catering_order_lines_productId_idx" ON "restaurant_catering_order_lines" ("productId");
CREATE INDEX "restaurant_catering_order_lines_recipeId_idx" ON "restaurant_catering_order_lines" ("recipeId");
CREATE INDEX "restaurant_catering_extra_costs_organizationId_orderId_idx" ON "restaurant_catering_extra_costs" ("organizationId", "orderId");
CREATE INDEX "restaurant_catering_deliveries_organizationId_orderId_idx" ON "restaurant_catering_deliveries" ("organizationId", "orderId");
CREATE INDEX "restaurant_catering_deliveries_driverStaffId_idx" ON "restaurant_catering_deliveries" ("driverStaffId");
CREATE INDEX "restaurant_catering_events_organizationId_orderId_idx" ON "restaurant_catering_events" ("organizationId", "orderId");
CREATE INDEX "restaurant_catering_events_actorStaffProfileId_idx" ON "restaurant_catering_events" ("actorStaffProfileId");

ALTER TABLE "restaurant_catering_orders" ADD CONSTRAINT "restaurant_catering_orders_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_orders" ADD CONSTRAINT "restaurant_catering_orders_customer_fkey" FOREIGN KEY ("customerId") REFERENCES "restaurant_customers" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_orders" ADD CONSTRAINT "restaurant_catering_orders_deliveryAddress_fkey" FOREIGN KEY ("deliveryAddressId") REFERENCES "restaurant_customer_addresses" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_orders" ADD CONSTRAINT "restaurant_catering_orders_createdByStaff_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "restaurant_staff_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_order_lines" ADD CONSTRAINT "restaurant_catering_order_lines_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_catering_orders" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_order_lines" ADD CONSTRAINT "restaurant_catering_order_lines_product_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_order_lines" ADD CONSTRAINT "restaurant_catering_order_lines_recipe_fkey" FOREIGN KEY ("recipeId") REFERENCES "restaurant_recipes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_extra_costs" ADD CONSTRAINT "restaurant_catering_extra_costs_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_catering_orders" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_deliveries" ADD CONSTRAINT "restaurant_catering_deliveries_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_catering_orders" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_deliveries" ADD CONSTRAINT "restaurant_catering_deliveries_driverStaff_fkey" FOREIGN KEY ("driverStaffId") REFERENCES "restaurant_staff_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_events" ADD CONSTRAINT "restaurant_catering_events_order_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_catering_orders" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_catering_events" ADD CONSTRAINT "restaurant_catering_events_actorStaff_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION validate_restaurant_catering_order_refs() RETURNS trigger AS $$
BEGIN
  IF NEW."customerId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_customers" WHERE "id" = NEW."customerId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering customer must belong to the organization' USING ERRCODE = '23514';
  END IF;
  IF NEW."deliveryAddressId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_customer_addresses" WHERE "id" = NEW."deliveryAddressId" AND "organizationId" = NEW."organizationId" AND "customerId" = NEW."customerId" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'catering delivery address must be a live address for the customer' USING ERRCODE = '23514';
  END IF;
  IF NEW."createdByStaffId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_staff_profiles" WHERE "id" = NEW."createdByStaffId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering creator must belong to the organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "restaurant_catering_order_refs_validate" BEFORE INSERT OR UPDATE ON "restaurant_catering_orders" FOR EACH ROW EXECUTE FUNCTION validate_restaurant_catering_order_refs();

CREATE FUNCTION validate_restaurant_catering_line_refs() RETURNS trigger AS $$
BEGIN
  IF NEW."productId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_products" WHERE "id" = NEW."productId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering product must belong to the organization' USING ERRCODE = '23514';
  END IF;
  IF NEW."recipeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_recipes" WHERE "id" = NEW."recipeId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering recipe must belong to the organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "restaurant_catering_line_refs_validate" BEFORE INSERT OR UPDATE ON "restaurant_catering_order_lines" FOR EACH ROW EXECUTE FUNCTION validate_restaurant_catering_line_refs();

CREATE FUNCTION validate_restaurant_catering_delivery_staff_ref() RETURNS trigger AS $$
BEGIN
  IF NEW."driverStaffId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_staff_profiles" WHERE "id" = NEW."driverStaffId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering staff reference must belong to the organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "restaurant_catering_delivery_staff_validate" BEFORE INSERT OR UPDATE ON "restaurant_catering_deliveries" FOR EACH ROW EXECUTE FUNCTION validate_restaurant_catering_delivery_staff_ref();

CREATE FUNCTION validate_restaurant_catering_event_staff_ref() RETURNS trigger AS $$
BEGIN
  IF NEW."actorStaffProfileId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "restaurant_staff_profiles" WHERE "id" = NEW."actorStaffProfileId" AND "organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'catering event actor must belong to the organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "restaurant_catering_event_staff_validate" BEFORE INSERT ON "restaurant_catering_events" FOR EACH ROW EXECUTE FUNCTION validate_restaurant_catering_event_staff_ref();

DO $$ DECLARE table_name TEXT; BEGIN
  FOREACH table_name IN ARRAY ARRAY['restaurant_catering_orders','restaurant_catering_order_lines','restaurant_catering_extra_costs','restaurant_catering_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', table_name || '_tenant', table_name);
  END LOOP;
END $$;

ALTER TABLE "restaurant_catering_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_catering_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_catering_events_select" ON "restaurant_catering_events" FOR SELECT USING ("organizationId" = current_setting('app.current_organization_id', true));
CREATE POLICY "restaurant_catering_events_insert" ON "restaurant_catering_events" FOR INSERT WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
