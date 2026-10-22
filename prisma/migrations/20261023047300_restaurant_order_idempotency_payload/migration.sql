ALTER TABLE "restaurant_order_idempotency_keys"
  ADD COLUMN "payloadHash" TEXT;

-- Historical keys cannot be safely associated with a payload. A sentinel makes
-- them fail closed rather than replaying against a request that was never bound.
UPDATE "restaurant_order_idempotency_keys"
SET "payloadHash" = repeat('0', 64);

ALTER TABLE "restaurant_order_idempotency_keys"
  ALTER COLUMN "payloadHash" SET NOT NULL;

ALTER TABLE "restaurant_order_idempotency_keys"
  ADD CONSTRAINT "restaurant_order_idempotency_keys_payloadHash_check"
  CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');
