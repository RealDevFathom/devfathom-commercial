-- Delivery money is snapshotted separately from merchandise/service/tax money.
ALTER TABLE "restaurant_bills"
  ADD COLUMN "deliveryFeeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurant_refunds"
  ADD COLUMN "deliveryFeeRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "restaurant_delivery_fulfillments"
  ALTER COLUMN "paymentMode" DROP NOT NULL;

ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_delivery_fee_nonneg_ck"
  CHECK ("deliveryFeeTotal" >= 0);
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_grand_total_ck"
  CHECK ("grandTotal" = "subtotal" + "taxTotal" + "serviceChargeTotal" + "deliveryFeeTotal" - "compTotal" - "discountTotal" + "roundingAdjustment");
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_delivery_fee_nonneg_ck"
  CHECK ("deliveryFeeRefundAmount" >= 0);

-- The foundation immutability trigger included paymentMode. Permit exactly the
-- unresolved -> frozen transition; every other snapshot remains immutable.
CREATE OR REPLACE FUNCTION restaurant_delivery_fulfillment_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."organizationId", NEW."branchId", NEW."customerId", NEW."orderId",
      NEW."recipientNameSnapshot", NEW."normalizedPhoneSnapshot", NEW."addressLine1Snapshot",
      NEW."addressLine2Snapshot", NEW."localitySnapshot", NEW."administrativeAreaSnapshot",
      NEW."postalCodeSnapshot", NEW."countryCodeSnapshot", NEW."latitudeSnapshot",
      NEW."longitudeSnapshot", NEW."zoneIdSnapshot", NEW."zoneNameSnapshot",
      NEW."zoneAreaPostalLabelSnapshot", NEW."deliveryFeeSnapshot", NEW."deliveryTaxSnapshot",
      NEW."promisedMinutesSnapshot", NEW."promisedAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."branchId", OLD."customerId", OLD."orderId",
      OLD."recipientNameSnapshot", OLD."normalizedPhoneSnapshot", OLD."addressLine1Snapshot",
      OLD."addressLine2Snapshot", OLD."localitySnapshot", OLD."administrativeAreaSnapshot",
      OLD."postalCodeSnapshot", OLD."countryCodeSnapshot", OLD."latitudeSnapshot",
      OLD."longitudeSnapshot", OLD."zoneIdSnapshot", OLD."zoneNameSnapshot",
      OLD."zoneAreaPostalLabelSnapshot", OLD."deliveryFeeSnapshot", OLD."deliveryTaxSnapshot",
      OLD."promisedMinutesSnapshot", OLD."promisedAt")
     OR (OLD."paymentMode" IS NOT NULL AND NEW."paymentMode" IS DISTINCT FROM OLD."paymentMode")
     OR (OLD."paymentMode" IS NULL AND NEW."paymentMode" IS NULL AND NEW."status" = 'DISPATCHED')
  THEN RAISE EXCEPTION 'delivery fulfillment snapshots are immutable';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "restaurant_delivery_fulfillments" ADD CONSTRAINT "restaurant_delivery_payment_mode_state_ck"
  CHECK (("status" = 'PENDING' AND "paymentMode" IS NULL) OR
         ("status" <> 'PENDING' AND "paymentMode" IS NOT NULL));
