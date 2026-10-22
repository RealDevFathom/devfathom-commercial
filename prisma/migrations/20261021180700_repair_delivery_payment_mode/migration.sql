-- Replay a silent FORCE-RLS write under transaction-local platform scope (#218).
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

-- Lock while suspending the snapshot trigger so concurrent writes cannot bypass it.
LOCK TABLE "restaurant_delivery_fulfillments" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "restaurant_delivery_fulfillments"
  DISABLE TRIGGER "restaurant_delivery_fulfillment_snapshot_immutable";
-- Delivery uses a tenant-only policy, so platform scope alone is insufficient.
DO $$
DECLARE tenant RECORD;
BEGIN
  FOR tenant IN
    SELECT id FROM "organizations"
    WHERE "vertical" = 'RESTAURANT'::"OrganizationVertical"
  LOOP
    PERFORM set_config('app.current_organization_id', tenant.id, true);
    UPDATE "restaurant_delivery_fulfillments"
    SET "paymentMode" = NULL
    WHERE "organizationId" = tenant.id
      AND "status" = 'PENDING' AND "paymentMode" IS NOT NULL;
  END LOOP;
END $$;
ALTER TABLE "restaurant_delivery_fulfillments"
  ENABLE TRIGGER "restaurant_delivery_fulfillment_snapshot_immutable";

COMMIT;
