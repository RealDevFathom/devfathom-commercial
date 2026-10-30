BEGIN;

-- Hold the DDL locks until the evidence guards have been restored. Only this
-- transaction can write while the two append-only triggers are suspended.
ALTER TABLE "pharmacy_sale_line_allocations"
DISABLE TRIGGER pharmacy_sale_allocations_append_only;
ALTER TABLE "pharmacy_sale_return_lines"
DISABLE TRIGGER pharmacy_sale_return_lines_append_only;

ALTER TABLE "pharmacy_sale_line_allocations"
ADD COLUMN "grossMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0;

-- Historical lines only exposed a unit-weighted value. Preserve that contract
-- while assigning every rounding remainder to the final deterministic row.
WITH shares AS (
  SELECT a.id,
    CASE WHEN row_number() OVER (PARTITION BY a."saleLineId" ORDER BY a.id DESC) = 1
      THEN l."grossMinor" - SUM(FLOOR(l."grossMinor"::numeric * a."canonicalUnits" / l."canonicalUnits"))
        OVER (PARTITION BY a."saleLineId")
        + FLOOR(l."grossMinor"::numeric * a."canonicalUnits" / l."canonicalUnits")
      ELSE FLOOR(l."grossMinor"::numeric * a."canonicalUnits" / l."canonicalUnits") END::integer AS gross,
    CASE WHEN row_number() OVER (PARTITION BY a."saleLineId" ORDER BY a.id DESC) = 1
      THEN l."discountMinor" - SUM(FLOOR(l."discountMinor"::numeric * a."canonicalUnits" / l."canonicalUnits"))
        OVER (PARTITION BY a."saleLineId")
        + FLOOR(l."discountMinor"::numeric * a."canonicalUnits" / l."canonicalUnits")
      ELSE FLOOR(l."discountMinor"::numeric * a."canonicalUnits" / l."canonicalUnits") END::integer AS discount
  FROM "pharmacy_sale_line_allocations" a
  JOIN "pharmacy_sale_lines" l ON l.id = a."saleLineId" AND l."organizationId" = a."organizationId"
)
UPDATE "pharmacy_sale_line_allocations" a
SET "grossMinor" = shares.gross, "discountMinor" = shares.discount
FROM shares WHERE shares.id = a.id;

ALTER TABLE "pharmacy_sale_return_lines"
ADD COLUMN "grossMinor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "discountMinor" INTEGER NOT NULL DEFAULT 0;

-- BEGIN historical return money backfill
-- Replay identified returns in their original order.  The interval overlap
-- makes this work even if one historical return crossed two allocations for
-- the same lot; the cumulative FLOOR deltas also assign every final remainder.
WITH allocation_ranges AS (
  SELECT a.*,
    COALESCE(SUM(a."canonicalUnits") OVER (
      PARTITION BY a."organizationId", a."saleLineId", a."inventoryLotId" ORDER BY a.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0)::integer AS unit_start
  FROM "pharmacy_sale_line_allocations" a
), return_ranges AS (
  SELECT r.*,
    COALESCE(SUM(r."canonicalUnits") OVER (
      PARTITION BY r."organizationId", r."saleLineId", r."inventoryLotId" ORDER BY r."createdAt", r.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0)::integer AS unit_start
  FROM "pharmacy_sale_return_lines" r
), return_money AS (
  SELECT r.id,
    SUM(
      FLOOR((a."grossMinor" - a."discountMinor")::numeric * (LEAST(r.unit_start + r."canonicalUnits", a.unit_start + a."canonicalUnits") - a.unit_start) / a."canonicalUnits")
      - FLOOR((a."grossMinor" - a."discountMinor")::numeric * (GREATEST(r.unit_start, a.unit_start) - a.unit_start) / a."canonicalUnits")
      + FLOOR(a."discountMinor"::numeric * (LEAST(r.unit_start + r."canonicalUnits", a.unit_start + a."canonicalUnits") - a.unit_start) / a."canonicalUnits")
      - FLOOR(a."discountMinor"::numeric * (GREATEST(r.unit_start, a.unit_start) - a.unit_start) / a."canonicalUnits")
    )::integer AS gross,
    SUM(
      FLOOR(a."discountMinor"::numeric * (LEAST(r.unit_start + r."canonicalUnits", a.unit_start + a."canonicalUnits") - a.unit_start) / a."canonicalUnits")
      - FLOOR(a."discountMinor"::numeric * (GREATEST(r.unit_start, a.unit_start) - a.unit_start) / a."canonicalUnits")
    )::integer AS discount
  FROM return_ranges r
  JOIN allocation_ranges a
    ON a."organizationId" = r."organizationId"
   AND a."saleLineId" = r."saleLineId"
   AND a."inventoryLotId" = r."inventoryLotId"
   AND r.unit_start < a.unit_start + a."canonicalUnits"
   AND r.unit_start + r."canonicalUnits" > a.unit_start
  GROUP BY r.id
)
UPDATE "pharmacy_sale_return_lines" r
SET "grossMinor" = return_money.gross,
    "discountMinor" = return_money.discount
FROM return_money
WHERE return_money.id = r.id;
-- END historical return money backfill

ALTER TABLE "pharmacy_sale_line_allocations"
ENABLE TRIGGER pharmacy_sale_allocations_append_only;
ALTER TABLE "pharmacy_sale_return_lines"
ENABLE TRIGGER pharmacy_sale_return_lines_append_only;

COMMIT;
