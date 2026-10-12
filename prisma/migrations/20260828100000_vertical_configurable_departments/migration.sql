-- WHA-278: replace the agency-only Department enum with tenant-owned catalogs.
CREATE TABLE "organization_departments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "organization_departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "organization_departments_organizationId_key_key"
    ON "organization_departments"("organizationId", "key");
CREATE UNIQUE INDEX "organization_departments_organizationId_name_key"
    ON "organization_departments"("organizationId", "name");
CREATE INDEX "organization_departments_organizationId_active_sortOrder_idx"
    ON "organization_departments"("organizationId", "active", "sortOrder");

INSERT INTO "organization_departments" ("id", "organizationId", "key", "name", "sortOrder", "updatedAt")
SELECT concat('dept_', md5(o."id" || ':' || d.key)), o."id", d.key, d.name, d.position, CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('LEADERSHIP', 'Leadership', 0, 'AGENCY'::"OrganizationVertical"),
    ('ENGINEERING', 'Engineering', 1, 'AGENCY'::"OrganizationVertical"),
    ('PRODUCT', 'Product', 2, 'AGENCY'::"OrganizationVertical"),
    ('QUALITY', 'Quality', 3, 'AGENCY'::"OrganizationVertical"),
    ('MARKETING', 'Marketing', 4, 'AGENCY'::"OrganizationVertical"),
    ('DESIGN', 'Design', 5, 'AGENCY'::"OrganizationVertical"),
    ('KITCHEN', 'Kitchen', 0, 'RESTAURANT'::"OrganizationVertical"),
    ('FRONT_OF_HOUSE', 'Front of House', 1, 'RESTAURANT'::"OrganizationVertical")
  ) AS defaults(key, name, position, vertical)
  WHERE defaults.vertical = o."vertical"
) d;

-- Preserve legacy values even if a Restaurant organization already has users
-- carrying an Agency-era enum value. These are compatibility rows, not defaults.
INSERT INTO "organization_departments" ("id", "organizationId", "key", "name", "sortOrder", "updatedAt")
SELECT concat('dept_', md5(u."organizationId" || ':' || u."department"::text)),
       u."organizationId", u."department"::text,
       initcap(replace(u."department"::text, '_', ' ')), 1000, CURRENT_TIMESTAMP
FROM "users" u
GROUP BY u."organizationId", u."department"
ON CONFLICT ("organizationId", "key") DO NOTHING;

ALTER TABLE "users" ALTER COLUMN "department" TYPE TEXT USING "department"::text;
DROP TYPE "Department";

ALTER TABLE "organization_departments"
    ADD CONSTRAINT "organization_departments_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users"
    ADD CONSTRAINT "users_organizationId_department_fkey"
    FOREIGN KEY ("organizationId", "department")
    REFERENCES "organization_departments"("organizationId", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "organization_departments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_departments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "organization_departments"
USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
