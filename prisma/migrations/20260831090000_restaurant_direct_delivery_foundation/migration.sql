-- WHA-1011: lean, branch-configurable direct delivery. Historical fulfillment
-- rows contain snapshots and intentionally do not reference mutable zone/address rows.

CREATE TYPE "RestaurantDeliveryPaymentMode" AS ENUM ('PREPAID', 'COD');
CREATE TYPE "RestaurantDeliveryFulfillmentStatus" AS ENUM ('PENDING', 'DISPATCHED', 'DELIVERED', 'CANCELLED', 'FAILED');

CREATE TABLE "restaurant_delivery_zones" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "fixedFee" DECIMAL(12,2) NOT NULL,
  "minimumSubtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "promisedMinutes" INTEGER NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "areaPostalLabel" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_delivery_zones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_delivery_zones_money_time_check"
    CHECK ("fixedFee" >= 0 AND "minimumSubtotal" >= 0 AND "promisedMinutes" >= 0)
);

CREATE TABLE "restaurant_customer_addresses" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "customerId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "recipientName" TEXT NOT NULL,
  "normalizedPhone" TEXT NOT NULL,
  "addressLine1" TEXT NOT NULL,
  "addressLine2" TEXT,
  "locality" TEXT NOT NULL,
  "administrativeArea" TEXT,
  "postalCode" TEXT,
  "countryCode" TEXT NOT NULL,
  "latitude" DECIMAL(9,6),
  "longitude" DECIMAL(9,6),
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_customer_addresses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_customer_addresses_phone_check" CHECK ("normalizedPhone" ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT "restaurant_customer_addresses_country_check" CHECK ("countryCode" ~ '^[A-Z]{2}$'),
  CONSTRAINT "restaurant_customer_addresses_coordinates_check" CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL) OR
    ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180)
  )
);

CREATE TABLE "restaurant_delivery_fulfillments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "paymentMode" "RestaurantDeliveryPaymentMode" NOT NULL,
  "status" "RestaurantDeliveryFulfillmentStatus" NOT NULL DEFAULT 'PENDING',
  "recipientNameSnapshot" TEXT NOT NULL,
  "normalizedPhoneSnapshot" TEXT NOT NULL,
  "addressLine1Snapshot" TEXT NOT NULL,
  "addressLine2Snapshot" TEXT,
  "localitySnapshot" TEXT NOT NULL,
  "administrativeAreaSnapshot" TEXT,
  "postalCodeSnapshot" TEXT,
  "countryCodeSnapshot" TEXT NOT NULL,
  "latitudeSnapshot" DECIMAL(9,6),
  "longitudeSnapshot" DECIMAL(9,6),
  "zoneIdSnapshot" TEXT,
  "zoneNameSnapshot" TEXT,
  "zoneAreaPostalLabelSnapshot" TEXT,
  "deliveryFeeSnapshot" DECIMAL(12,2) NOT NULL,
  "deliveryTaxSnapshot" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "promisedMinutesSnapshot" INTEGER NOT NULL,
  "promisedAt" TIMESTAMP(3) NOT NULL,
  "instructions" TEXT,
  "dispatchedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_delivery_fulfillments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_delivery_fulfillments_amount_time_check" CHECK (
    "deliveryFeeSnapshot" >= 0 AND "deliveryTaxSnapshot" >= 0 AND "promisedMinutesSnapshot" >= 0
  ),
  CONSTRAINT "restaurant_delivery_fulfillments_phone_country_check" CHECK (
    "normalizedPhoneSnapshot" ~ '^\+[1-9][0-9]{6,14}$' AND "countryCodeSnapshot" ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT "restaurant_delivery_fulfillments_coordinates_check" CHECK (
    ("latitudeSnapshot" IS NULL AND "longitudeSnapshot" IS NULL) OR
    ("latitudeSnapshot" BETWEEN -90 AND 90 AND "longitudeSnapshot" BETWEEN -180 AND 180)
  ),
  CONSTRAINT "restaurant_delivery_fulfillments_zone_snapshot_check" CHECK (
    ("zoneIdSnapshot" IS NULL AND "zoneNameSnapshot" IS NULL AND "zoneAreaPostalLabelSnapshot" IS NULL) OR
    ("zoneIdSnapshot" IS NOT NULL AND "zoneNameSnapshot" IS NOT NULL)
  ),
  CONSTRAINT "restaurant_delivery_fulfillments_status_timestamps_check" CHECK (
    ("status" = 'PENDING' AND "dispatchedAt" IS NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL) OR
    ("status" = 'DISPATCHED' AND "dispatchedAt" IS NOT NULL AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL) OR
    ("status" = 'DELIVERED' AND "dispatchedAt" IS NOT NULL AND "deliveredAt" IS NOT NULL AND "cancelledAt" IS NULL AND "failedAt" IS NULL) OR
    ("status" = 'CANCELLED' AND "deliveredAt" IS NULL AND "cancelledAt" IS NOT NULL AND "failedAt" IS NULL) OR
    ("status" = 'FAILED' AND "deliveredAt" IS NULL AND "cancelledAt" IS NULL AND "failedAt" IS NOT NULL)
  )
);

ALTER TABLE "restaurant_delivery_zones"
  ADD CONSTRAINT "restaurant_delivery_zones_organizationId_branchId_id_key" UNIQUE ("organizationId", "branchId", "id");
ALTER TABLE "restaurant_customer_addresses"
  ADD CONSTRAINT "restaurant_customer_addresses_organizationId_customerId_id_key" UNIQUE ("organizationId", "customerId", "id");
ALTER TABLE "restaurant_delivery_fulfillments"
  ADD CONSTRAINT "restaurant_delivery_fulfillments_organizationId_orderId_key" UNIQUE ("organizationId", "orderId");
ALTER TABLE "restaurant_delivery_fulfillments"
  ADD CONSTRAINT "restaurant_delivery_fulfillments_organizationId_branchId_orderId_key" UNIQUE ("organizationId", "branchId", "orderId");
ALTER TABLE "restaurant_orders"
  ADD CONSTRAINT "restaurant_orders_organizationId_branchId_id_key" UNIQUE ("organizationId", "branchId", "id");

CREATE INDEX "restaurant_delivery_zones_organizationId_branchId_active_sortOrder_idx"
  ON "restaurant_delivery_zones" ("organizationId", "branchId", "active", "sortOrder");
CREATE INDEX "restaurant_customer_addresses_organizationId_customerId_deletedAt_idx"
  ON "restaurant_customer_addresses" ("organizationId", "customerId", "deletedAt");
CREATE UNIQUE INDEX "restaurant_customer_addresses_one_live_default_key"
  ON "restaurant_customer_addresses" ("organizationId", "customerId") WHERE "isDefault" AND "deletedAt" IS NULL;
CREATE INDEX "restaurant_delivery_fulfillments_organizationId_branchId_status_idx"
  ON "restaurant_delivery_fulfillments" ("organizationId", "branchId", "status");
CREATE INDEX "restaurant_delivery_fulfillments_organizationId_customerId_createdAt_idx"
  ON "restaurant_delivery_fulfillments" ("organizationId", "customerId", "createdAt");

ALTER TABLE "restaurant_delivery_zones" ADD CONSTRAINT "restaurant_delivery_zones_tenant_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_customer_addresses" ADD CONSTRAINT "restaurant_customer_addresses_tenant_customer_fkey"
  FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_delivery_fulfillments" ADD CONSTRAINT "restaurant_delivery_fulfillments_tenant_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_delivery_fulfillments" ADD CONSTRAINT "restaurant_delivery_fulfillments_tenant_customer_fkey"
  FOREIGN KEY ("organizationId", "customerId") REFERENCES "restaurant_customers" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "restaurant_delivery_fulfillments" ADD CONSTRAINT "restaurant_delivery_fulfillments_tenant_branch_order_fkey"
  FOREIGN KEY ("organizationId", "branchId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION validate_restaurant_delivery_fulfillment() RETURNS trigger AS $$
DECLARE
  order_channel "RestaurantOrderChannel";
  zone_record "restaurant_delivery_zones"%ROWTYPE;
BEGIN
  SELECT "channel" INTO order_channel FROM "restaurant_orders"
   WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "id" = NEW."orderId";
  IF order_channel IS DISTINCT FROM 'DELIVERY' THEN
    RAISE EXCEPTION 'delivery fulfillment requires a DELIVERY order' USING ERRCODE = '23514';
  END IF;
  IF NEW."zoneIdSnapshot" IS NOT NULL THEN
    SELECT * INTO zone_record FROM "restaurant_delivery_zones"
     WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId"
       AND "id" = NEW."zoneIdSnapshot" AND "active";
    IF NOT FOUND OR NEW."zoneNameSnapshot" IS DISTINCT FROM zone_record."name"
       OR NEW."zoneAreaPostalLabelSnapshot" IS DISTINCT FROM zone_record."areaPostalLabel"
       OR NEW."deliveryFeeSnapshot" IS DISTINCT FROM zone_record."fixedFee"
       OR NEW."promisedMinutesSnapshot" IS DISTINCT FROM zone_record."promisedMinutes" THEN
      RAISE EXCEPTION 'delivery zone must be active in the order branch and server-owned values must match' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "restaurant_delivery_fulfillment_validate_insert"
  BEFORE INSERT ON "restaurant_delivery_fulfillments"
  FOR EACH ROW EXECUTE FUNCTION validate_restaurant_delivery_fulfillment();

CREATE FUNCTION prevent_restaurant_delivery_snapshot_mutation() RETURNS trigger AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."customerId", NEW."orderId", NEW."paymentMode",
      NEW."recipientNameSnapshot", NEW."normalizedPhoneSnapshot", NEW."addressLine1Snapshot", NEW."addressLine2Snapshot",
      NEW."localitySnapshot", NEW."administrativeAreaSnapshot", NEW."postalCodeSnapshot", NEW."countryCodeSnapshot",
      NEW."latitudeSnapshot", NEW."longitudeSnapshot", NEW."zoneIdSnapshot", NEW."zoneNameSnapshot",
      NEW."zoneAreaPostalLabelSnapshot", NEW."deliveryFeeSnapshot", NEW."deliveryTaxSnapshot",
      NEW."promisedMinutesSnapshot", NEW."promisedAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."customerId", OLD."orderId", OLD."paymentMode",
      OLD."recipientNameSnapshot", OLD."normalizedPhoneSnapshot", OLD."addressLine1Snapshot", OLD."addressLine2Snapshot",
      OLD."localitySnapshot", OLD."administrativeAreaSnapshot", OLD."postalCodeSnapshot", OLD."countryCodeSnapshot",
      OLD."latitudeSnapshot", OLD."longitudeSnapshot", OLD."zoneIdSnapshot", OLD."zoneNameSnapshot",
      OLD."zoneAreaPostalLabelSnapshot", OLD."deliveryFeeSnapshot", OLD."deliveryTaxSnapshot",
      OLD."promisedMinutesSnapshot", OLD."promisedAt") THEN
    RAISE EXCEPTION 'delivery fulfillment snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "restaurant_delivery_fulfillment_snapshot_immutable"
  BEFORE UPDATE ON "restaurant_delivery_fulfillments"
  FOR EACH ROW EXECUTE FUNCTION prevent_restaurant_delivery_snapshot_mutation();

ALTER TABLE "restaurant_delivery_zones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_delivery_zones" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_delivery_zones_tenant" ON "restaurant_delivery_zones"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
ALTER TABLE "restaurant_customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_customer_addresses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_customer_addresses_tenant" ON "restaurant_customer_addresses"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
ALTER TABLE "restaurant_delivery_fulfillments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_delivery_fulfillments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "restaurant_delivery_fulfillments_tenant" ON "restaurant_delivery_fulfillments"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
