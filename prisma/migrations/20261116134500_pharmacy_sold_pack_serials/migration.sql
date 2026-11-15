-- DEV-92: SRO 963(I)/2026 r.3A(4) puts the 2D code on the primary pack of a
-- medicine sold without a box. A counter scan of that bottle or tube claims its
-- GTIN + serial for the sale line, so the same physical pack cannot be sold
-- twice. Additive and idempotent: existing tables and rows are untouched.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_sold_pack_serials" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "gtin" TEXT NOT NULL,
  "serialNumber" TEXT NOT NULL,
  "serialKey" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "saleLineId" TEXT NOT NULL,
  "inventoryLotId" TEXT,
  "soldByUserId" TEXT NOT NULL,
  "releasedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sold_pack_serials_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_sold_pack_serials_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_sold_pack_serials_gtin_check" CHECK ("gtin" ~ '^[0-9]{14}$'),
  CONSTRAINT "pharmacy_sold_pack_serials_serial_key_check" CHECK ("serialKey" = upper("serialNumber") AND length("serialKey") BETWEEN 1 AND 20)
);

CREATE INDEX IF NOT EXISTS "pharmacy_sold_pack_serials_org_gtin_serial_idx" ON "pharmacy_sold_pack_serials"("organizationId", "gtin", "serialKey");
CREATE INDEX IF NOT EXISTS "pharmacy_sold_pack_serials_sale_idx" ON "pharmacy_sold_pack_serials"("organizationId", "branchId", "saleId");
-- One live sale per physical pack across the whole organization, whichever branch sold it.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_sold_pack_serials_live_key" ON "pharmacy_sold_pack_serials"("organizationId", "gtin", "serialKey") WHERE "releasedAt" IS NULL;

-- A claim is evidence: it is never deleted, and only its release may be stamped, once.
CREATE OR REPLACE FUNCTION reject_pharmacy_sold_pack_serial_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy_sold_pack_serials rows are never deleted';
  END IF;
  IF OLD."releasedAt" IS NOT NULL
     OR NEW."releasedAt" IS NULL
     OR (to_jsonb(NEW) - 'releasedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'releasedAt') THEN
    RAISE EXCEPTION 'pharmacy_sold_pack_serials only records a release, once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pharmacy_sold_pack_serials_guard ON "pharmacy_sold_pack_serials";
CREATE TRIGGER pharmacy_sold_pack_serials_guard
BEFORE UPDATE OR DELETE ON "pharmacy_sold_pack_serials"
FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_sold_pack_serial_mutation();

ALTER TABLE "pharmacy_sold_pack_serials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sold_pack_serials" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_sold_pack_serials";
CREATE POLICY tenant_branch_isolation ON "pharmacy_sold_pack_serials"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))));

COMMIT;
