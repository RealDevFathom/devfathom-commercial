-- DRAP 2D stock-in: keep GTIN and serial on the receipt line that already
-- captures batch and expiry. Legacy packs leave both null.
ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN "gtin" TEXT,
  ADD COLUMN "serialNumber" TEXT,
  ADD COLUMN "serialKey" TEXT,
  ADD COLUMN "gs1Warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD CONSTRAINT "pharmacy_grl_serial_pair" CHECK (
    (
      "serialNumber" IS NULL
      AND "serialKey" IS NULL
    )
    OR (
      "gtin" ~ '^[0-9]{14}$'
      AND "serialNumber" IS NOT NULL
      AND char_length("serialNumber") BETWEEN 1 AND 20
      AND "serialKey" = upper("serialNumber")
    )
  );

-- Partial so hand-entered lines without a serial do not collide.
CREATE UNIQUE INDEX "pharmacy_grl_org_gtin_serial_key"
  ON "pharmacy_goods_receipt_lines" ("organizationId", "gtin", "serialKey")
  WHERE "gtin" IS NOT NULL AND "serialKey" IS NOT NULL;
