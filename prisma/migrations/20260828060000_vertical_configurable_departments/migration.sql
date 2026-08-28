-- WHA-278: replace the global agency-only enum with tenant-owned departments.
-- The explicit transaction keeps the enum conversion, backfill, constraints,
-- and forced-RLS policy atomic and fail-closed.

BEGIN;

CREATE TABLE "organization_departments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_departments_organizationId_key_key"
    ON "organization_departments"("organizationId", "key");
CREATE UNIQUE INDEX "organization_departments_organizationId_label_key"
    ON "organization_departments"("organizationId", "label");
CREATE INDEX "organization_departments_organizationId_idx"
    ON "organization_departments"("organizationId");

ALTER TABLE "organization_departments"
    ADD CONSTRAINT "organization_departments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the exact legacy enum token while changing only its storage type.
ALTER TABLE "users" ALTER COLUMN "department" TYPE TEXT USING "department"::TEXT;

-- Backfill every value actually in use before catalog defaults are considered.
INSERT INTO "organization_departments" ("id", "organizationId", "key", "label")
SELECT
    'dept_' || replace(gen_random_uuid()::TEXT, '-', ''),
    legacy."organizationId",
    legacy."department",
    initcap(replace(legacy."department", '_', ' '))
FROM (SELECT DISTINCT "organizationId", "department" FROM "users") AS legacy;

-- Copy vertical defaults without overwriting a tenant's preserved vocabulary.
INSERT INTO "organization_departments" ("id", "organizationId", "key", "label")
SELECT
    'dept_' || replace(gen_random_uuid()::TEXT, '-', ''),
    organization."id",
    defaults."key",
    defaults."label"
FROM "organizations" AS organization
CROSS JOIN LATERAL (
    SELECT * FROM (VALUES
        ('AGENCY'::"OrganizationVertical", 'LEADERSHIP', 'Leadership'),
        ('AGENCY'::"OrganizationVertical", 'ENGINEERING', 'Engineering'),
        ('AGENCY'::"OrganizationVertical", 'PRODUCT', 'Product'),
        ('AGENCY'::"OrganizationVertical", 'QUALITY', 'Quality'),
        ('AGENCY'::"OrganizationVertical", 'MARKETING', 'Marketing'),
        ('AGENCY'::"OrganizationVertical", 'DESIGN', 'Design'),
        ('RESTAURANT'::"OrganizationVertical", 'LEADERSHIP', 'Leadership'),
        ('RESTAURANT'::"OrganizationVertical", 'KITCHEN', 'Kitchen'),
        ('RESTAURANT'::"OrganizationVertical", 'FRONT_OF_HOUSE', 'Front of House')
    ) AS catalog("vertical", "key", "label")
    WHERE catalog."vertical" = organization."vertical"
) AS defaults
ON CONFLICT ("organizationId", "key") DO NOTHING;

ALTER TABLE "users"
    ADD CONSTRAINT "tenant_users_department_organization_departments_fk"
    FOREIGN KEY ("organizationId", "department")
    REFERENCES "organization_departments"("organizationId", "key")
    ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

DROP TYPE "Department";

ALTER TABLE "organization_departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_departments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_departments"
    USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
