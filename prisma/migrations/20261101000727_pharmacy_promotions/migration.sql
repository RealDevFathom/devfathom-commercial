-- #727: branch-scoped automatic counter offers, authorized by their creator.
-- Windows are absolute instants [effectiveFrom, effectiveTo). Existing sales
-- remain unchanged; a counter line snapshots the applied name and discount.
CREATE TABLE "pharmacy_promotions" (
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
  CONSTRAINT "pharmacy_promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_promotions_window_check" CHECK ("effectiveFrom" < "effectiveTo"),
  CONSTRAINT "pharmacy_promotions_name_check" CHECK (
    length(btrim("name")) BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "pharmacy_promotions_benefit_check" CHECK (
    ("benefitBasisPoints" IS NOT NULL AND "benefitBasisPoints" BETWEEN 1 AND 10000 AND "benefitMinor" IS NULL)
    OR ("benefitMinor" IS NOT NULL AND "benefitMinor" > 0 AND "benefitBasisPoints" IS NULL)
  ),
  CONSTRAINT "pharmacy_promotions_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_promotions_medicine_fkey" FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_promotions_organizationId_branchId_id_key"
  ON "pharmacy_promotions" ("organizationId", "branchId", "id");
CREATE INDEX "pharmacy_promotions_active_window_idx"
  ON "pharmacy_promotions" ("organizationId", "branchId", "active", "effectiveFrom", "effectiveTo");

ALTER TABLE "pharmacy_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_promotions" FORCE ROW LEVEL SECURITY;
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

-- Only deactivation may mutate a published rule. Replacement offers get new ids.
CREATE FUNCTION pharmacy_promotion_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active')
     OR (NOT OLD."active" AND NEW."active") THEN
    RAISE EXCEPTION 'Pharmacy promotions are immutable; disable and replace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pharmacy_promotion_immutable BEFORE UPDATE ON "pharmacy_promotions"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_promotion_immutable();

ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "promotionId" TEXT,
  ADD COLUMN "promotionName" TEXT,
  ADD CONSTRAINT "pharmacy_sale_lines_promotion_fkey"
    FOREIGN KEY ("organizationId", "branchId", "promotionId")
    REFERENCES "pharmacy_promotions" ("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pharmacy_sale_lines_promotion_snapshot_check" CHECK (
    ("promotionId" IS NULL AND "promotionName" IS NULL) OR
    ("promotionId" IS NOT NULL AND "promotionName" IS NOT NULL AND
     "discountKind" IS NOT NULL AND "discountKind" = 'PROMOTION' AND "discountMinor" > 0 AND
     "approvedByUserId" IS NOT NULL AND "approvalPolicy" IS NOT NULL)
  );
