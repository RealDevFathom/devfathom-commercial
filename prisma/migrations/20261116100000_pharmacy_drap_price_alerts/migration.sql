BEGIN;

-- DEV-693: a DRAP price notice that matches a catalogue medicine becomes an
-- informational alert. It never changes a price and never drafts a price change:
-- the price printed on the pack and the owner's own price stay authoritative.
CREATE TABLE IF NOT EXISTS "pharmacy_drap_price_alerts" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "ingestId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "notifiedPriceMinor" INTEGER NOT NULL,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "dismissedById" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_drap_price_alerts_organizationId_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_drap_price_alerts_organizationId_ingestId_key" UNIQUE ("organizationId", "ingestId"),
  CONSTRAINT "pharmacy_drap_price_alerts_price_nonnegative" CHECK ("notifiedPriceMinor" >= 0),
  CONSTRAINT "pharmacy_drap_price_alerts_dismissal_pair" CHECK (
    ("dismissedAt" IS NULL AND "dismissedById" IS NULL)
    OR ("dismissedAt" IS NOT NULL AND length(btrim("dismissedById")) > 0)
  ),
  CONSTRAINT "pharmacy_drap_price_alerts_ingest_fkey" FOREIGN KEY ("organizationId", "ingestId")
    REFERENCES "pharmacy_drap_ingests"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_drap_price_alerts_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "pharmacy_drap_price_alerts_organizationId_medicineId_dismissedAt_idx"
  ON "pharmacy_drap_price_alerts"("organizationId", "medicineId", "dismissedAt");

DROP TRIGGER IF EXISTS pharmacy_drap_price_alerts_no_delete ON "pharmacy_drap_price_alerts";
CREATE TRIGGER pharmacy_drap_price_alerts_no_delete BEFORE DELETE ON "pharmacy_drap_price_alerts"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

ALTER TABLE "pharmacy_drap_price_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_drap_price_alerts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_drap_price_alerts";
CREATE POLICY tenant_isolation ON "pharmacy_drap_price_alerts"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
