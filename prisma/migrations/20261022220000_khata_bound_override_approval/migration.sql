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
    REFERENCES "pharmacy_family_accounts"("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_khata_override_approvals_organizationId_branchId_id_idx"
  ON "pharmacy_khata_override_approvals"("organizationId", "branchId", "id");
ALTER TABLE "pharmacy_khata_override_approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_khata_override_approvals" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_khata_override_approvals"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     "branchId" = NULLIF(current_setting('app.current_branch_id', true), '')));
