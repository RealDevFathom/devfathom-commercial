CREATE TABLE "pharmacy_khata_override_approvals" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "approverId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "familyAccountId" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "pharmacy_khata_override_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_khata_override_approvals_values_check" CHECK ("amountMinor" > 0 AND length(btrim("reason")) > 0 AND "expiresAt" > "createdAt"),
  CONSTRAINT "pharmacy_khata_override_approvals_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_override_approvals_account_fkey" FOREIGN KEY ("organizationId", "branchId", "familyAccountId")
    REFERENCES "pharmacy_family_accounts"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_override_approvals_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId")
    REFERENCES "pharmacy_sales"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_khata_override_approvals_approver_fkey" FOREIGN KEY ("organizationId", "approverId")
    REFERENCES "users"("organizationId", "id") ON DELETE RESTRICT
);
-- Explicit names stay under PostgreSQL's 63-byte identifier limit and match schema.prisma.
CREATE INDEX "pharmacy_khata_override_approvals_org_branch_id_idx"
  ON "pharmacy_khata_override_approvals"("organizationId", "branchId", "id");
CREATE INDEX "pharmacy_khata_override_approvals_sale_idx"
  ON "pharmacy_khata_override_approvals"("organizationId", "branchId", "saleId");
CREATE INDEX "pharmacy_khata_override_approvals_account_idx"
  ON "pharmacy_khata_override_approvals"("organizationId", "branchId", "familyAccountId");
CREATE INDEX "pharmacy_khata_override_approvals_approver_idx"
  ON "pharmacy_khata_override_approvals"("organizationId", "approverId");

CREATE FUNCTION pharmacy_khata_override_approvals_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pharmacy Khata override approval evidence cannot be deleted';
  END IF;
  IF OLD."consumedAt" IS NOT NULL OR NEW."consumedAt" IS NULL
     OR NEW."consumedAt" IS NOT DISTINCT FROM OLD."consumedAt"
     OR ROW(NEW."id", NEW."organizationId", NEW."branchId", NEW."approverId", NEW."saleId",
            NEW."familyAccountId", NEW."amountMinor", NEW."reason", NEW."createdAt", NEW."expiresAt")
        IS DISTINCT FROM
        ROW(OLD."id", OLD."organizationId", OLD."branchId", OLD."approverId", OLD."saleId",
            OLD."familyAccountId", OLD."amountMinor", OLD."reason", OLD."createdAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'pharmacy Khata override approval evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pharmacy_khata_override_approvals_immutable_trigger
  BEFORE UPDATE OR DELETE ON "pharmacy_khata_override_approvals"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_khata_override_approvals_immutable();

ALTER TABLE "pharmacy_khata_override_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_khata_override_approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_khata_override_approvals"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')));
