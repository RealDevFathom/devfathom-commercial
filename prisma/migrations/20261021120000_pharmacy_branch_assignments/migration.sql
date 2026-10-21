-- Receipt authorization reads pharmacy branch assignments. Restaurant staff
-- branch ids cannot name a pharmacy branch. No backfill: an empty set denies.
CREATE TABLE "pharmacy_branch_assignments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_branch_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_branch_assignments_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_branch_assignments_user_fkey" FOREIGN KEY ("organizationId", "userId")
    REFERENCES "users" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_branch_assignments_org_branch_user_key"
  ON "pharmacy_branch_assignments" ("organizationId", "branchId", "userId");
CREATE INDEX "pharmacy_branch_assignments_organizationId_userId_active_idx"
  ON "pharmacy_branch_assignments" ("organizationId", "userId", "active");

ALTER TABLE "pharmacy_branch_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_branch_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_branch_assignments"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
