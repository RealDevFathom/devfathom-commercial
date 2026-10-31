-- Repair any orders affected by the historical concurrent-move race before
-- installing the database backstop. Keep the newest active MOVE destination.
SELECT set_config('app.is_platform_admin', 'true', true);

WITH duplicate_active_moves AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "orderId"
      ORDER BY "linkedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS position
  FROM "restaurant_order_tables"
  WHERE "active" = true
    AND "linkReason" = 'MOVE'
)
UPDATE "restaurant_order_tables" AS link
SET
  "active" = false,
  "unlinkedAt" = COALESCE(link."unlinkedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM duplicate_active_moves AS duplicate
WHERE link."id" = duplicate."id"
  AND duplicate.position > 1;

-- MERGE links intentionally remain many-per-order. A move, however, may have
-- only one active destination for an order even if an application regression
-- bypasses the parent-row serialization in the command layer.
CREATE UNIQUE INDEX "restaurant_order_tables_one_active_move_per_order_key"
  ON "restaurant_order_tables" ("orderId")
  WHERE "active" = true
    AND "linkReason" = 'MOVE';
