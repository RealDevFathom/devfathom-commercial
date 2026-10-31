ALTER TABLE "restaurant_order_idempotency_keys"
  ADD COLUMN "canonicalPayloadHash" TEXT;

ALTER TABLE "restaurant_order_idempotency_keys"
  ADD CONSTRAINT "restaurant_order_idempotency_keys_canonicalPayloadHash_check"
  CHECK ("canonicalPayloadHash" IS NULL OR "canonicalPayloadHash" ~ '^[0-9a-f]{64}$');
