BEGIN;

-- Bind each restaurant order idempotency key to a canonical command payload hash so
-- a reused (deviceId, key) for a different command or payload is rejected instead of
-- replayed. Existing keys stay NULL and keep command-type-only replay semantics.
ALTER TABLE "restaurant_order_idempotency_keys"
  ADD COLUMN IF NOT EXISTS "payloadHash" TEXT;

COMMIT;
