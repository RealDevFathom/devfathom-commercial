-- DEV-681: supplier price-list import, SQL price-change alerts and shelf-price
-- drafts that a person approves. The upload never changes a price by itself.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_supplier_price_lists" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "supplierId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "rowCount" INTEGER NOT NULL,
  "importedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_supplier_price_lists_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_supplier_price_lists_supplier_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_lists_row_count_check" CHECK ("rowCount" > 0),
  CONSTRAINT "pharmacy_supplier_price_lists_hash_check" CHECK ("sourceHash" ~ '^[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_supplier_price_lists_organizationId_id_key" ON "pharmacy_supplier_price_lists"("organizationId", "id");
-- Not unique: the same file is imported again for a fresh comparison once a
-- compared price has changed; the earlier snapshot is kept unchanged.
CREATE INDEX IF NOT EXISTS "pharmacy_supplier_price_lists_organizationId_supplierId_sourceHash_idx" ON "pharmacy_supplier_price_lists"("organizationId", "supplierId", "sourceHash");
CREATE INDEX IF NOT EXISTS "pharmacy_supplier_price_lists_organizationId_createdAt_idx" ON "pharmacy_supplier_price_lists"("organizationId", "createdAt");

CREATE TABLE IF NOT EXISTS "pharmacy_supplier_price_list_lines" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "priceListId" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "productText" TEXT NOT NULL,
  "packText" TEXT,
  "barcode" TEXT,
  "matchStatus" TEXT NOT NULL,
  "medicineId" TEXT,
  "packLevelId" TEXT,
  "listTradePriceMinor" INTEGER,
  "listMrpMinor" INTEGER,
  "previousTradePriceMinor" INTEGER,
  "currentPackPriceId" TEXT,
  "currentMrpMinor" INTEGER,
  "currentSellingPriceMinor" INTEGER,
  "draftStatus" TEXT NOT NULL DEFAULT 'NONE',
  "draftMrpMinor" INTEGER,
  "draftSellingPriceMinor" INTEGER,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "packPriceId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_supplier_price_list_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_supplier_price_list_lines_list_fkey" FOREIGN KEY ("organizationId", "priceListId") REFERENCES "pharmacy_supplier_price_lists"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_list_lines_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_list_lines_pack_fkey" FOREIGN KEY ("organizationId", "packLevelId") REFERENCES "pharmacy_pack_levels"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_list_lines_current_price_fkey" FOREIGN KEY ("organizationId", "currentPackPriceId") REFERENCES "pharmacy_pack_prices"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_list_lines_pack_price_fkey" FOREIGN KEY ("organizationId", "packPriceId") REFERENCES "pharmacy_pack_prices"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_supplier_price_list_lines_match_check" CHECK ("matchStatus" IN ('MATCHED', 'NO_MATCH', 'AMBIGUOUS')),
  CONSTRAINT "pharmacy_supplier_price_list_lines_matched_pack_check" CHECK (("matchStatus" = 'MATCHED') = ("packLevelId" IS NOT NULL AND "medicineId" IS NOT NULL)),
  CONSTRAINT "pharmacy_supplier_price_list_lines_prices_check" CHECK (
    COALESCE("listTradePriceMinor", 0) >= 0 AND COALESCE("listMrpMinor", 0) >= 0 AND
    COALESCE("draftMrpMinor", 0) >= 0 AND COALESCE("draftSellingPriceMinor", 0) >= 0
  ),
  CONSTRAINT "pharmacy_supplier_price_list_lines_status_check" CHECK ("draftStatus" IN ('NONE', 'DRAFT', 'APPROVED', 'REJECTED')),
  -- A draft exists only for a matched pack, and never sells above its MRP.
  CONSTRAINT "pharmacy_supplier_price_list_lines_draft_check" CHECK (
    ("draftStatus" = 'NONE') = ("draftMrpMinor" IS NULL) AND
    ("draftStatus" = 'NONE' OR "matchStatus" = 'MATCHED') AND
    ("draftSellingPriceMinor" IS NULL OR "draftSellingPriceMinor" <= "draftMrpMinor")
  ),
  -- Every decision names the person; only an approval writes a price.
  CONSTRAINT "pharmacy_supplier_price_list_lines_decision_check" CHECK (
    ("draftStatus" IN ('APPROVED', 'REJECTED')) = ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL) AND
    ("draftStatus" = 'APPROVED') = ("packPriceId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_supplier_price_list_lines_organizationId_id_key" ON "pharmacy_supplier_price_list_lines"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_supplier_price_list_lines_organizationId_priceListId_rowNumber_key" ON "pharmacy_supplier_price_list_lines"("organizationId", "priceListId", "rowNumber");
CREATE INDEX IF NOT EXISTS "pharmacy_supplier_price_list_lines_organizationId_draftStatus_idx" ON "pharmacy_supplier_price_list_lines"("organizationId", "draftStatus");

-- An approved supplier draft is a third, named source of price policy.
ALTER TABLE "pharmacy_pack_prices" DROP CONSTRAINT IF EXISTS "pharmacy_pack_prices_source_check";
ALTER TABLE "pharmacy_pack_prices" ADD CONSTRAINT "pharmacy_pack_prices_source_check" CHECK ("source" IN ('drap', 'manual', 'supplier'));

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_supplier_price_lists', 'pharmacy_supplier_price_list_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;

COMMIT;
