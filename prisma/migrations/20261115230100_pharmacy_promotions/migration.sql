-- #727: dated, branch-scoped automatic counter promotions. A promotion is
-- authorized by the manager who created it; its window is the half-open range
-- [effectiveFrom, effectiveTo). Rule content is immutable: a manager disables
-- it and creates a replacement. A counter line snapshots the applied promotion
-- name and discount, so completed sales and reprints never reprice.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_promotions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "medicineId" TEXT,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3) NOT NULL,
  "benefitBasisPoints" INTEGER,
  "benefitMinor" INTEGER,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt" TIMESTAMP(3),
  "disabledByUserId" TEXT,
  CONSTRAINT "pharmacy_promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_promotions_window_check" CHECK ("effectiveFrom" < "effectiveTo"),
  CONSTRAINT "pharmacy_promotions_name_check" CHECK (
    length(btrim("name")) BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "pharmacy_promotions_benefit_check" CHECK (
    ("benefitBasisPoints" IS NOT NULL AND "benefitBasisPoints" BETWEEN 1 AND 10000 AND "benefitMinor" IS NULL)
    OR ("benefitMinor" IS NOT NULL AND "benefitMinor" > 0 AND "benefitBasisPoints" IS NULL)
  ),
  CONSTRAINT "pharmacy_promotions_disabled_check" CHECK (
    ("active" AND "disabledAt" IS NULL AND "disabledByUserId" IS NULL)
    OR (NOT "active" AND "disabledAt" IS NOT NULL AND "disabledByUserId" IS NOT NULL)
  ),
  CONSTRAINT "pharmacy_promotions_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_promotions_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_promotions_org_id_key"
  ON "pharmacy_promotions"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_promotions_org_branch_id_key"
  ON "pharmacy_promotions"("organizationId", "branchId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_promotions_active_window_idx"
  ON "pharmacy_promotions"("organizationId", "branchId", "active", "effectiveFrom", "effectiveTo");

-- Promotions are never deleted. Only the one-way disable may change a row.
CREATE OR REPLACE FUNCTION guard_pharmacy_promotion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy promotions cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'active' - 'disabledAt' - 'disabledByUserId')
       IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'disabledAt' - 'disabledByUserId')
     OR NOT OLD."active" THEN
    RAISE EXCEPTION 'pharmacy promotions are immutable; disable and replace' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_promotions_guard ON "pharmacy_promotions";
CREATE TRIGGER pharmacy_promotions_guard
BEFORE UPDATE OR DELETE ON "pharmacy_promotions"
FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_promotion();

ALTER TABLE "pharmacy_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_promotions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_promotions";
CREATE POLICY tenant_branch_isolation ON "pharmacy_promotions"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))
    )
  );

ALTER TABLE "pharmacy_sale_lines" ADD COLUMN IF NOT EXISTS "promotionId" TEXT;
ALTER TABLE "pharmacy_sale_lines" ADD COLUMN IF NOT EXISTS "promotionName" TEXT;

DO $$ BEGIN
  ALTER TABLE "pharmacy_sale_lines"
    ADD CONSTRAINT "pharmacy_sale_lines_promotion_fkey"
    FOREIGN KEY ("organizationId", "branchId", "promotionId")
    REFERENCES "pharmacy_promotions"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- An automatic promotion line is always a positive, attributed PROMOTION discount.
DO $$ BEGIN
  ALTER TABLE "pharmacy_sale_lines"
    ADD CONSTRAINT "pharmacy_sale_lines_promotion_snapshot_check" CHECK (
      ("promotionId" IS NULL AND "promotionName" IS NULL) OR
      ("promotionId" IS NOT NULL AND "promotionName" IS NOT NULL AND
       "discountKind" = 'PROMOTION' AND "discountMinor" > 0 AND
       "approvedByUserId" IS NOT NULL AND "approvalPolicy" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
