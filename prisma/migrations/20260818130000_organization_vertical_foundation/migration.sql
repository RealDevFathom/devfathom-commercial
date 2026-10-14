-- M1-L1 — Vertical foundation for the Restaurant vertical (restaurant/v1).
-- Additive and backward compatible: every existing organization and package is
-- backfilled to AGENCY before the columns are enforced NOT NULL, so no current
-- row is invalidated. The two new branch tables are tenant-scoped exactly like
-- the existing operational tables (bare RLS-guarded organizationId, forced
-- org-level RLS, cross-tenant-safe composite foreign keys). No branch-level DB
-- policy is invented here (D12 seam only).

-- §2: the organization-type enum. Intentionally two values.
CREATE TYPE "OrganizationVertical" AS ENUM ('AGENCY', 'RESTAURANT');

-- §2.2 / §2.3: stamp organizations and packages with a vertical. Add nullable,
-- backfill every pre-existing row to AGENCY, then enforce the default + NOT NULL.
ALTER TABLE "organizations" ADD COLUMN "vertical" "OrganizationVertical";
UPDATE "organizations" SET "vertical" = 'AGENCY' WHERE "vertical" IS NULL;
ALTER TABLE "organizations" ALTER COLUMN "vertical" SET DEFAULT 'AGENCY';
ALTER TABLE "organizations" ALTER COLUMN "vertical" SET NOT NULL;
CREATE INDEX "organizations_vertical_idx" ON "organizations"("vertical");

ALTER TABLE "platform_packages" ADD COLUMN "vertical" "OrganizationVertical";
UPDATE "platform_packages" SET "vertical" = 'AGENCY' WHERE "vertical" IS NULL;
ALTER TABLE "platform_packages" ALTER COLUMN "vertical" SET DEFAULT 'AGENCY';
ALTER TABLE "platform_packages" ALTER COLUMN "vertical" SET NOT NULL;

-- §4 / §4.1: branch-first schema. RestaurantBranch is a top-level tenant entity;
-- organizationId is RLS-guarded, defaulting from the transaction-local setting so
-- an INSERT cannot omit or forge it.
CREATE TABLE "restaurant_branches" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_branches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "restaurant_branches_organizationId_idx" ON "restaurant_branches"("organizationId");

-- §2.2 / §4.1: at most one default branch per organization. Partial unique index
-- (unsupported in the Prisma schema, so declared here) enforces it in the DB.
CREATE UNIQUE INDEX "restaurant_branches_organizationId_default_key"
    ON "restaurant_branches"("organizationId")
    WHERE "isDefault";

-- §4.1 / §8 / D12: explicit user-to-branch assignment rows. (branchId, userId) is
-- unique so a user is assigned to a branch at most once.
CREATE TABLE "restaurant_branch_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_branch_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "restaurant_branch_assignments_branchId_userId_key" ON "restaurant_branch_assignments"("branchId", "userId");
CREATE INDEX "restaurant_branch_assignments_organizationId_idx" ON "restaurant_branch_assignments"("organizationId");
CREATE INDEX "restaurant_branch_assignments_userId_idx" ON "restaurant_branch_assignments"("userId");

-- Single-column foreign keys (Prisma-managed) keep the ON DELETE actions.
ALTER TABLE "restaurant_branch_assignments"
    ADD CONSTRAINT "restaurant_branch_assignments_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restaurant_branch_assignments"
    ADD CONSTRAINT "restaurant_branch_assignments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cross-tenant-safe composite integrity (matches 20260728091000_tenant_composite_integrity):
-- a branch and its assignment, and an assignment and its user, must share one
-- organization. The (organizationId, id) unique lets children reference a branch
-- by tenant; the deferred composite keys make a cross-organization reference
-- impossible even inside the platform scope.
ALTER TABLE "restaurant_branches"
    ADD CONSTRAINT "restaurant_branches_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "restaurant_branch_assignments"
    ADD CONSTRAINT "tenant_restaurant_branch_assignments_branchId_fk"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_branch_assignments"
    ADD CONSTRAINT "tenant_restaurant_branch_assignments_userId_fk"
    FOREIGN KEY ("organizationId", "userId")
    REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- Forced org-level RLS, identical clause to 20260728092000_row_level_security
-- (including the app.is_platform_admin control-plane escape). Branch-level policy
-- is deliberately NOT added (D12 seam).
ALTER TABLE "restaurant_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_branches" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "restaurant_branch_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_branch_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_branch_assignments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
