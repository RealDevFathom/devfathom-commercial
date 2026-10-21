-- Branch scope for the controlled register. Rows are explicit assignments.
-- This migration does not drop FORCE ROW LEVEL SECURITY on
-- pharmacy_controlled_register_entries and does not drop the append-only
-- trigger pharmacy_controlled_register_entries_append_only.

CREATE TABLE "pharmacy_branch_assignments" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_branch_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pharmacy_branch_assignments_org_user_branch_key"
  ON "pharmacy_branch_assignments" ("organizationId", "userId", "branchId");
CREATE INDEX "pharmacy_branch_assignments_user_idx"
  ON "pharmacy_branch_assignments" ("organizationId", "userId", "active");

ALTER TABLE "pharmacy_branch_assignments"
  ADD CONSTRAINT "pharmacy_branch_assignments_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT,
  ADD CONSTRAINT "pharmacy_branch_assignments_user_fkey"
    FOREIGN KEY ("organizationId", "userId")
    REFERENCES "users" ("organizationId", "id") ON DELETE RESTRICT;

ALTER TABLE "pharmacy_branch_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_branch_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_branch_assignments"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
