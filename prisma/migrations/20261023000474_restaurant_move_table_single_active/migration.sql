-- Repair any rows created by the pre-lock move race. Keep the most recent MOVE
-- destination active and retain every older link as history.
WITH ranked_active_moves AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "organizationId", "orderId"
      ORDER BY "linkedAt" DESC, "createdAt" DESC, "id" DESC
    ) AS move_rank
  FROM "restaurant_order_tables"
  WHERE "active" = true AND "linkReason" = 'MOVE'
)
UPDATE "restaurant_order_tables" AS order_table
SET
  "active" = false,
  "unlinkedAt" = COALESCE(order_table."unlinkedAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_active_moves
WHERE order_table."id" = ranked_active_moves."id"
  AND ranked_active_moves.move_rank > 1;

-- MERGE deliberately permits several active tables. A MOVE has exactly one
-- active destination for an order, including as a database-level backstop for
-- writers outside the command layer.
CREATE UNIQUE INDEX "restaurant_order_tables_one_active_move_key"
  ON "restaurant_order_tables" ("organizationId", "orderId")
  WHERE "active" = true AND "linkReason" = 'MOVE';
