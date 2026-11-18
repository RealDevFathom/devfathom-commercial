BEGIN;

-- DEV-912: the supplier and reorder level a staged product row names, as the bulk creation
-- applied them. The link stays read-and-insert only (row-level security forced since
-- 20261118122600); these columns are written once, with the link.
-- `supplierName` is the cell as read; `supplierId` is the organization's existing supplier
-- with exactly that name after normalising (case, spacing, Unicode form), or null when none
-- or more than one matches: an unknown supplier is reported on the row, never created.
-- `reorderLevelPacks` is the cell as read (whole packs, above 0); `reorderLevelApplied` says
-- whether it became the medicine's approved safety stock at the requested branch. Null in
-- both when the file did not record a reorder level.
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD COLUMN IF NOT EXISTS "supplierName" TEXT,
  ADD COLUMN IF NOT EXISTS "supplierId" TEXT,
  ADD COLUMN IF NOT EXISTS "reorderLevelPacks" INTEGER,
  ADD COLUMN IF NOT EXISTS "reorderLevelApplied" BOOLEAN;

ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_supplier_check";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_supplier_check"
  CHECK ("supplierId" IS NULL OR "supplierName" IS NOT NULL);
ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_supplier_fkey";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_supplier_fkey"
  FOREIGN KEY ("organizationId", "supplierId")
  REFERENCES "pharmacy_suppliers"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_staged_medicine_links"
  DROP CONSTRAINT IF EXISTS "pharmacy_staged_medicine_links_reorder_check";
ALTER TABLE "pharmacy_staged_medicine_links"
  ADD CONSTRAINT "pharmacy_staged_medicine_links_reorder_check"
  CHECK (
    ("reorderLevelPacks" IS NULL OR "reorderLevelPacks" > 0)
    AND ("reorderLevelPacks" IS NULL) = ("reorderLevelApplied" IS NULL)
  );

COMMIT;
