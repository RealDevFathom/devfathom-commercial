ALTER TYPE "PharmacyCustomerOrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED';
CREATE TABLE pharmacy_order_delivery_evidence (
 id TEXT PRIMARY KEY,
 "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "branchId" TEXT NOT NULL, "orderId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('COLLECT','REMIT','VARIANCE','REFUSED','FAILED','CASH_RETURN','PHYSICAL_RETURN')),
 "amountMinor" INTEGER, reference TEXT NOT NULL CHECK (length(reference) BETWEEN 1 AND 160),
 "requestKey" TEXT NOT NULL, fingerprint TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("organizationId", "branchId", "orderId") REFERENCES pharmacy_customer_orders("organizationId", "branchId", id) ON DELETE RESTRICT,
 FOREIGN KEY ("organizationId", "actorUserId") REFERENCES users("organizationId",id) ON DELETE RESTRICT,
 UNIQUE ("organizationId", "branchId", "orderId", "requestKey"),
 CHECK ((action IN ('COLLECT','REMIT','CASH_RETURN') AND "amountMinor" IS NOT NULL AND "amountMinor" > 0) OR (action='VARIANCE' AND "amountMinor" IS NOT NULL) OR (action IN ('REFUSED','FAILED','PHYSICAL_RETURN') AND "amountMinor" IS NULL))
);
CREATE INDEX pharmacy_order_delivery_evidence_scope_idx ON pharmacy_order_delivery_evidence("organizationId","branchId","orderId","occurredAt");
ALTER TABLE pharmacy_order_delivery_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_order_delivery_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY order_delivery_read ON pharmacy_order_delivery_evidence FOR SELECT USING (
 "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'')
 AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))
 AND EXISTS (SELECT 1 FROM pharmacy_customer_orders o WHERE o."organizationId"=pharmacy_order_delivery_evidence."organizationId" AND o."branchId"=pharmacy_order_delivery_evidence."branchId" AND o.id=pharmacy_order_delivery_evidence."orderId")
);
CREATE POLICY order_delivery_write ON pharmacy_order_delivery_evidence FOR INSERT WITH CHECK (
 "organizationId"=NULLIF(current_setting('app.current_organization_id',true),'')
 AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),'')
 AND "actorUserId"=NULLIF(current_setting('app.current_user_id',true),'')
 AND EXISTS (SELECT 1 FROM users actor WHERE actor.id=pharmacy_order_delivery_evidence."actorUserId" AND actor."organizationId"=pharmacy_order_delivery_evidence."organizationId" AND actor.status='ACTIVE')
 AND EXISTS (SELECT 1 FROM pharmacy_customer_orders o WHERE o."organizationId"=pharmacy_order_delivery_evidence."organizationId" AND o."branchId"=pharmacy_order_delivery_evidence."branchId" AND o.id=pharmacy_order_delivery_evidence."orderId" AND pharmacy_customer_order_access(NULL))
);
CREATE TRIGGER pharmacy_order_delivery_evidence_append_only BEFORE UPDATE OR DELETE ON pharmacy_order_delivery_evidence FOR EACH ROW EXECUTE FUNCTION pharmacy_forbid_customer_order_child_mutation();
CREATE OR REPLACE FUNCTION pharmacy_guard_customer_order_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD."status"::text IN ('COMPLETED', 'CANCELLED', 'EXPIRED', 'RETURNED') THEN
    RAISE EXCEPTION 'customer order is already terminal' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."status" = 'PROPOSED' AND NEW."status" IN ('ACCEPTED', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'ACCEPTED' AND NEW."status" IN ('PACKING', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" = 'PACKING' AND NEW."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY', 'CANCELLED', 'EXPIRED')) OR
    (OLD."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY') AND NEW."status" = 'COMPLETED') OR
    (OLD."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY') AND NEW."status"::text = 'RETURNED'
      AND EXISTS (SELECT 1 FROM pharmacy_order_delivery_evidence e WHERE e."organizationId"=OLD."organizationId" AND e."branchId"=OLD."branchId" AND e."orderId"=OLD.id AND e.action='PHYSICAL_RETURN'))
  ) THEN
    RAISE EXCEPTION 'illegal customer order transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
