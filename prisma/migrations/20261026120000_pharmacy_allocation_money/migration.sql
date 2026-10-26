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
