-- Wallet balance projection outbox. The ledger remains the sole balance authority;
-- this trigger only coalesces an asynchronous update intent in the owning write tx.
CREATE FUNCTION "restaurant_enqueue_wallet_balance_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "restaurant_wallet_pass_updates"
    ("id", "organizationId", "passId", "reason", "status", "attempts", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT concat('wpu_', replace(gen_random_uuid()::text, '-', '')),
         NEW."organizationId", p."id", 'LEDGER', 'PENDING', 0, now(), now(), now()
  FROM "restaurant_wallet_passes" p
  WHERE p."organizationId" = NEW."organizationId"
    AND p."loyaltyAccountId" = NEW."accountId"
    AND p."status" = 'ACTIVE'
  ON CONFLICT ("passId") WHERE "status" = 'PENDING'
  DO UPDATE SET "nextAttemptAt" = LEAST("restaurant_wallet_pass_updates"."nextAttemptAt", EXCLUDED."nextAttemptAt"),
                "updatedAt" = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "restaurant_loyalty_points_wallet_update"
AFTER INSERT ON "restaurant_loyalty_points_entries"
FOR EACH ROW EXECUTE FUNCTION "restaurant_enqueue_wallet_balance_update"();
