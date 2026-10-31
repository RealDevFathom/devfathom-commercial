-- Keep manual ready-order recovery aligned with the application lifecycle.
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
    -- Only unlinked collection stock can be released without delivery-return evidence.
    (OLD."status" = 'READY_FOR_COLLECTION' AND NEW."status" IN ('CANCELLED', 'EXPIRED')
      AND OLD."counterSaleId" IS NULL AND NEW."counterSaleId" IS NULL
      AND (NEW."status" <> 'EXPIRED' OR OLD."reservationExpiresAt" <= clock_timestamp())) OR
    (OLD."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY') AND NEW."status" = 'COMPLETED') OR
    (OLD."status" IN ('READY_FOR_COLLECTION', 'OUT_FOR_DELIVERY') AND NEW."status"::text = 'RETURNED'
      AND EXISTS (SELECT 1 FROM pharmacy_order_delivery_evidence e WHERE e."organizationId"=OLD."organizationId" AND e."branchId"=OLD."branchId" AND e."orderId"=OLD.id AND e.action='PHYSICAL_RETURN'))
  ) THEN
    RAISE EXCEPTION 'illegal customer order transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
