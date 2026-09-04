-- MKT-03 + MKT-05: authenticated pharmacy storefront proposals share one
-- order model and the existing DEM-03 stock reservation primitive.
CREATE TYPE "PharmacyCustomerOrderFulfillment" AS ENUM ('COLLECT', 'DELIVER');
CREATE TYPE "PharmacyCustomerOrderStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'PACKING', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED', 'EXPIRED');
CREATE TYPE "PharmacyCustomerOrderEventKind" AS ENUM ('PLACED', 'ACCEPTED', 'PACKING_STARTED', 'READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'CHECKOUT_STARTED', 'COMPLETED', 'CANCELLED', 'EXPIRED');

ALTER TABLE "pharmacy_customers" ADD COLUMN "userId" TEXT;
CREATE UNIQUE INDEX "pharmacy_customers_organizationId_userId_key"
  ON "pharmacy_customers"("organizationId", "userId");
ALTER TABLE "pharmacy_customers" ADD CONSTRAINT "pharmacy_customers_user_fkey"
  FOREIGN KEY ("organizationId", "userId") REFERENCES "users"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pharmacy_customer_orders" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "placedByUserId" TEXT NOT NULL,
  "fulfillment" "PharmacyCustomerOrderFulfillment" NOT NULL,
  "status" "PharmacyCustomerOrderStatus" NOT NULL DEFAULT 'PROPOSED',
  "intendedPaymentMethod" "PharmacyTenderType" NOT NULL,
  "addressLine" TEXT,
  "city" TEXT,
  "deliveryInstructions" TEXT,
  "runnerUserId" TEXT,
  "reservationExpiresAt" TIMESTAMP(3) NOT NULL,
  "counterSaleId" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "packedAt" TIMESTAMP(3),
  "readyAt" TIMESTAMP(3),
  "outForDeliveryAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_customer_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_customer_orders_expiry_ck" CHECK ("reservationExpiresAt" > "createdAt"),
  CONSTRAINT "pharmacy_customer_orders_route_ck" CHECK (
    ("fulfillment" = 'COLLECT' AND "addressLine" IS NULL AND "city" IS NULL AND "deliveryInstructions" IS NULL AND "runnerUserId" IS NULL)
    OR
    ("fulfillment" = 'DELIVER' AND length(btrim("addressLine")) > 0 AND length(btrim("city")) > 0)
  ),
  CONSTRAINT "pharmacy_customer_orders_route_status_ck" CHECK (
    ("status" <> 'READY_FOR_COLLECTION' OR "fulfillment" = 'COLLECT')
    AND ("status" <> 'OUT_FOR_DELIVERY' OR ("fulfillment" = 'DELIVER' AND "runnerUserId" IS NOT NULL))
  ),
  CONSTRAINT "pharmacy_customer_orders_terminal_time_ck" CHECK (
    ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
    AND ("status" <> 'EXPIRED' OR "expiredAt" IS NOT NULL)
  )
);

CREATE TABLE "pharmacy_customer_order_lines" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "presentationId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "saleUnit" "PharmacySaleUnit" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "canonicalUnitsPerSaleUnit" INTEGER NOT NULL,
  "canonicalUnits" INTEGER NOT NULL,
  "unitPriceMinor" INTEGER NOT NULL,
  "lineTotalMinor" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_customer_order_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_customer_order_lines_quantity_ck" CHECK (
    "quantity" > 0 AND "canonicalUnitsPerSaleUnit" > 0
    AND "canonicalUnits" = "quantity" * "canonicalUnitsPerSaleUnit"
  ),
  CONSTRAINT "pharmacy_customer_order_lines_money_ck" CHECK (
    "unitPriceMinor" >= 0 AND "lineTotalMinor" = "unitPriceMinor" * "quantity"
  )
);

CREATE TABLE "pharmacy_customer_order_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "kind" "PharmacyCustomerOrderEventKind" NOT NULL,
  "fromStatus" "PharmacyCustomerOrderStatus",
  "toStatus" "PharmacyCustomerOrderStatus" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "detail" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_customer_order_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pharmacy_customer_orders_organizationId_id_key" ON "pharmacy_customer_orders"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_customer_orders_organizationId_branchId_id_key" ON "pharmacy_customer_orders"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "pharmacy_customer_orders_organizationId_branchId_counterSaleId_key" ON "pharmacy_customer_orders"("organizationId", "branchId", "counterSaleId");
CREATE INDEX "pharmacy_customer_orders_organizationId_customerId_createdAt_idx" ON "pharmacy_customer_orders"("organizationId", "customerId", "createdAt");
CREATE INDEX "pharmacy_customer_orders_organizationId_branchId_status_createdAt_idx" ON "pharmacy_customer_orders"("organizationId", "branchId", "status", "createdAt");
CREATE INDEX "pharmacy_customer_orders_organizationId_reservationExpiresAt_status_idx" ON "pharmacy_customer_orders"("organizationId", "reservationExpiresAt", "status");
CREATE UNIQUE INDEX "pharmacy_customer_order_lines_organizationId_id_key" ON "pharmacy_customer_order_lines"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_customer_order_lines_organizationId_branchId_id_key" ON "pharmacy_customer_order_lines"("organizationId", "branchId", "id");
CREATE INDEX "pharmacy_customer_order_lines_organizationId_branchId_orderId_idx" ON "pharmacy_customer_order_lines"("organizationId", "branchId", "orderId");
CREATE UNIQUE INDEX "pharmacy_customer_order_events_organizationId_id_key" ON "pharmacy_customer_order_events"("organizationId", "id");
CREATE INDEX "pharmacy_customer_order_events_organizationId_branchId_orderId_occurredAt_idx" ON "pharmacy_customer_order_events"("organizationId", "branchId", "orderId", "occurredAt");

ALTER TABLE "pharmacy_customer_orders" ADD CONSTRAINT "pharmacy_customer_orders_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_orders" ADD CONSTRAINT "pharmacy_customer_orders_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_orders" ADD CONSTRAINT "pharmacy_customer_orders_placed_by_fkey" FOREIGN KEY ("organizationId", "placedByUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_orders" ADD CONSTRAINT "pharmacy_customer_orders_runner_fkey" FOREIGN KEY ("organizationId", "runnerUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_orders" ADD CONSTRAINT "pharmacy_customer_orders_counter_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "counterSaleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_lines" ADD CONSTRAINT "pharmacy_customer_order_lines_order_fkey" FOREIGN KEY ("organizationId", "branchId", "orderId") REFERENCES "pharmacy_customer_orders"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_lines" ADD CONSTRAINT "pharmacy_customer_order_lines_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_lines" ADD CONSTRAINT "pharmacy_customer_order_lines_presentation_fkey" FOREIGN KEY ("presentationId") REFERENCES "pharmacy_presentations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_lines" ADD CONSTRAINT "pharmacy_customer_order_lines_pack_level_fkey" FOREIGN KEY ("packLevelId") REFERENCES "pharmacy_pack_levels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_events" ADD CONSTRAINT "pharmacy_customer_order_events_order_fkey" FOREIGN KEY ("organizationId", "branchId", "orderId") REFERENCES "pharmacy_customer_orders"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_customer_order_events" ADD CONSTRAINT "pharmacy_customer_order_events_actor_fkey" FOREIGN KEY ("organizationId", "actorUserId") REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pharmacy_restock_interests" ADD COLUMN "orderLineId" TEXT;
CREATE INDEX "pharmacy_restock_interests_org_branch_order_line_idx" ON "pharmacy_restock_interests"("organizationId", "branchId", "orderLineId", "status");
ALTER TABLE "pharmacy_restock_interests" ADD CONSTRAINT "pharmacy_restock_interests_order_line_fkey" FOREIGN KEY ("organizationId", "branchId", "orderLineId") REFERENCES "pharmacy_customer_order_lines"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Keep the DEM-03 reservation payload immutable now that the same primitive can
-- be attributed to a customer order line.
CREATE OR REPLACE FUNCTION pharmacy_validate_restock_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available_units INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."organizationId", NEW."branchId", NEW."interestId", NEW."inventoryLotId", NEW."stockLocationId", NEW."reservedUnits", NEW."createdAt") IS DISTINCT FROM (OLD."organizationId", OLD."branchId", OLD."interestId", OLD."inventoryLotId", OLD."stockLocationId", OLD."reservedUnits", OLD."createdAt")
      OR OLD."status" <> 'RESERVED' OR NEW."status" NOT IN ('CONSUMED', 'RELEASED') THEN
      RAISE EXCEPTION 'restock reservation payload or settled state is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT balance."onHandUnits" - COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId" = NEW."organizationId" AND c."branchId" = NEW."branchId" AND c."inventoryLotId" = NEW."inventoryLotId" AND c."status" = 'RESERVED'), 0) - COALESCE((SELECT SUM(r."reservedUnits") FROM "pharmacy_restock_reservations" r WHERE r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId" AND r."inventoryLotId" = NEW."inventoryLotId" AND r."stockLocationId" = NEW."stockLocationId" AND r."status" = 'RESERVED'), 0)
  INTO available_units
  FROM "pharmacy_stock_balances" balance
  JOIN "pharmacy_inventory_lots" lot ON lot."organizationId" = balance."organizationId" AND lot."branchId" = balance."branchId" AND lot."id" = balance."inventoryLotId"
  JOIN "pharmacy_manufacturing_batches" batch ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
  JOIN "pharmacy_restock_interests" interest ON interest."organizationId" = NEW."organizationId" AND interest."branchId" = NEW."branchId" AND interest."id" = NEW."interestId"
  JOIN "pharmacy_unfulfilled_demand_events" demand ON demand."organizationId" = interest."organizationId" AND demand."id" = interest."demandEventId"
  WHERE balance."organizationId" = NEW."organizationId" AND balance."branchId" = NEW."branchId" AND balance."inventoryLotId" = NEW."inventoryLotId" AND balance."stockLocationId" = NEW."stockLocationId" AND balance."disposition" = 'AVAILABLE' AND lot."receivedAt" IS NOT NULL AND batch."state" = 'ACTIVE' AND batch."expiresAt" > CURRENT_TIMESTAMP AND demand."requestedMedicineId" = batch."medicineId"
  FOR UPDATE OF balance;
  IF available_units IS NULL OR available_units < NEW."reservedUnits" THEN RAISE EXCEPTION 'restock reservation exceeds safe available stock' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pharmacy_guard_customer_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."customerId", NEW."placedByUserId", NEW."fulfillment", NEW."intendedPaymentMethod", NEW."addressLine", NEW."city", NEW."deliveryInstructions", NEW."reservationExpiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."customerId", OLD."placedByUserId", OLD."fulfillment", OLD."intendedPaymentMethod", OLD."addressLine", OLD."city", OLD."deliveryInstructions", OLD."reservationExpiresAt", OLD."createdAt") THEN
    RAISE EXCEPTION 'customer order proposal payload is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."status" = NEW."status" AND OLD."counterSaleId" IS NULL AND NEW."counterSaleId" IS NOT NULL
     AND (NEW."runnerUserId", NEW."acceptedAt", NEW."packedAt", NEW."readyAt", NEW."outForDeliveryAt", NEW."completedAt", NEW."cancelledAt", NEW."expiredAt")
       IS NOT DISTINCT FROM
       (OLD."runnerUserId", OLD."acceptedAt", OLD."packedAt", OLD."readyAt", OLD."outForDeliveryAt", OLD."completedAt", OLD."cancelledAt", OLD."expiredAt") THEN
    RETURN NEW;
  END IF;
  IF OLD."status" IN ('COMPLETED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'customer order is already terminal' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'PROPOSED' AND NEW."status" IN ('ACCEPTED', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('PACKING', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'PACKING' AND NEW."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY') AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'illegal customer order transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION pharmacy_forbid_customer_order_child_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'customer order audit children are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER pharmacy_customer_order_transition_guard BEFORE UPDATE OR DELETE ON "pharmacy_customer_orders" FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_customer_order_transition();
CREATE TRIGGER pharmacy_customer_order_line_append_only BEFORE UPDATE OR DELETE ON "pharmacy_customer_order_lines" FOR EACH ROW EXECUTE FUNCTION pharmacy_forbid_customer_order_child_mutation();
CREATE TRIGGER pharmacy_customer_order_event_append_only BEFORE UPDATE OR DELETE ON "pharmacy_customer_order_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_forbid_customer_order_child_mutation();

-- Customer sessions are bound through app.current_user_id. Staff access is an
-- explicit organization-role capability, never an agency role or anonymous path.
CREATE FUNCTION pharmacy_customer_order_access(order_customer_id TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pharmacy_customers" customer
    WHERE customer."organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND customer."id" = order_customer_id
      AND customer."userId" = NULLIF(current_setting('app.current_user_id', true), '')
  ) OR EXISTS (
    SELECT 1 FROM "users" actor
    JOIN "organization_roles" role ON role."id" = actor."organizationRoleId" AND role."organizationId" = actor."organizationId"
    JOIN "organization_role_permissions" permission ON permission."organizationRoleId" = role."id" AND permission."organizationId" = actor."organizationId"
    WHERE actor."organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND actor."id" = NULLIF(current_setting('app.current_user_id', true), '')
      AND permission."effect" = 'ALLOW'
      AND permission."capability" IN ('*', 'pharmacy:*', 'pharmacy:orders')
      AND NOT EXISTS (
        SELECT 1 FROM "user_permission_overrides" denied
        WHERE denied."organizationId" = actor."organizationId" AND denied."userId" = actor."id"
          AND denied."effect" = 'DENY' AND denied."capability" IN ('*', 'pharmacy:*', 'pharmacy:orders')
          AND (denied."expiresAt" IS NULL OR denied."expiresAt" > CURRENT_TIMESTAMP)
      )
  );
$$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_customer_orders','pharmacy_customer_order_lines','pharmacy_customer_order_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY pharmacy_customer_orders_select ON "pharmacy_customer_orders" FOR SELECT USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND pharmacy_customer_order_access("customerId")
);
CREATE POLICY pharmacy_customer_orders_insert ON "pharmacy_customer_orders" FOR INSERT WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND pharmacy_customer_order_access("customerId")
);
CREATE POLICY pharmacy_customer_orders_update ON "pharmacy_customer_orders" FOR UPDATE USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND pharmacy_customer_order_access("customerId")
) WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND pharmacy_customer_order_access("customerId")
);

CREATE POLICY pharmacy_customer_order_lines_access ON "pharmacy_customer_order_lines" USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_orders" parent WHERE parent."organizationId" = "pharmacy_customer_order_lines"."organizationId" AND parent."branchId" = "pharmacy_customer_order_lines"."branchId" AND parent."id" = "pharmacy_customer_order_lines"."orderId")
) WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_orders" parent WHERE parent."organizationId" = "pharmacy_customer_order_lines"."organizationId" AND parent."branchId" = "pharmacy_customer_order_lines"."branchId" AND parent."id" = "pharmacy_customer_order_lines"."orderId")
);
CREATE POLICY pharmacy_customer_order_events_access ON "pharmacy_customer_order_events" USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_orders" parent WHERE parent."organizationId" = "pharmacy_customer_order_events"."organizationId" AND parent."branchId" = "pharmacy_customer_order_events"."branchId" AND parent."id" = "pharmacy_customer_order_events"."orderId")
) WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
    OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_orders" parent WHERE parent."organizationId" = "pharmacy_customer_order_events"."organizationId" AND parent."branchId" = "pharmacy_customer_order_events"."branchId" AND parent."id" = "pharmacy_customer_order_events"."orderId")
);

-- Order-linked DEM-03 rows need the same customer/staff access as their order.
CREATE POLICY pharmacy_restock_interests_order_access ON "pharmacy_restock_interests" USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
  AND "orderLineId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_order_lines" line WHERE line."organizationId" = "pharmacy_restock_interests"."organizationId" AND line."branchId" = "pharmacy_restock_interests"."branchId" AND line."id" = "pharmacy_restock_interests"."orderLineId")
) WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
  AND "orderLineId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "pharmacy_customer_order_lines" line WHERE line."organizationId" = "pharmacy_restock_interests"."organizationId" AND line."branchId" = "pharmacy_restock_interests"."branchId" AND line."id" = "pharmacy_restock_interests"."orderLineId")
);
CREATE POLICY pharmacy_restock_reservations_order_access ON "pharmacy_restock_reservations" USING (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
  AND EXISTS (SELECT 1 FROM "pharmacy_restock_interests" interest WHERE interest."organizationId" = "pharmacy_restock_reservations"."organizationId" AND interest."branchId" = "pharmacy_restock_reservations"."branchId" AND interest."id" = "pharmacy_restock_reservations"."interestId" AND interest."orderLineId" IS NOT NULL)
) WITH CHECK (
  "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')
  AND EXISTS (SELECT 1 FROM "pharmacy_restock_interests" interest WHERE interest."organizationId" = "pharmacy_restock_reservations"."organizationId" AND interest."branchId" = "pharmacy_restock_reservations"."branchId" AND interest."id" = "pharmacy_restock_reservations"."interestId" AND interest."orderLineId" IS NOT NULL)
);
