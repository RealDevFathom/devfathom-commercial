-- DEV-773: a fractional bill's largest-remainder cent is an untaxed rounding
-- adjustment that settlement never reports as gross sales. Refunds record its
-- share as a separate component so a full refund nets sales back to zero.
-- Additive and idempotent: existing refunds keep a zero rounding component.
BEGIN;

ALTER TABLE "restaurant_refunds"
  ADD COLUMN IF NOT EXISTS "roundingRefundAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "restaurant_refunds"
  DROP CONSTRAINT IF EXISTS "restaurant_refunds_rounding_nonneg_ck";
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_rounding_nonneg_ck"
  CHECK ("roundingRefundAmount" >= 0);

ALTER TABLE "restaurant_refunds"
  DROP CONSTRAINT IF EXISTS "restaurant_refunds_frozen_refund_amounts_check";
ALTER TABLE "restaurant_refunds" ADD CONSTRAINT "restaurant_refunds_frozen_refund_amounts_check"
  CHECK ("serviceChargeRefundAmount" >= 0 AND "deliveryFeeRefundAmount" >= 0
    AND "taxRefundAmount" >= 0 AND "roundingRefundAmount" >= 0
    AND "serviceChargeRefundAmount" + "deliveryFeeRefundAmount" + "taxRefundAmount"
      + "roundingRefundAmount" <= "amount");

COMMIT;
