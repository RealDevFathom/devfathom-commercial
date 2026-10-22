-- Issue #260: repair missing vertical defaults without hiding name collisions.
--
-- The department catalog is FORCE RLS, so this transaction-local setting is
-- required for a migration that deliberately repairs every organization.
SET LOCAL app.is_platform_admin = 'true';

INSERT INTO "organization_departments"
  ("id", "organizationId", "key", "name", "sortOrder", "updatedAt")
SELECT
  concat('dept_', md5(o."id" || ':' || defaults.key)),
  o."id",
  defaults.key,
  defaults.name,
  defaults.position,
  CURRENT_TIMESTAMP
FROM "organizations" o
CROSS JOIN LATERAL (
  SELECT *
  FROM (VALUES
    ('LEADERSHIP', 'Leadership', 0, 'AGENCY'::"OrganizationVertical"),
    ('ENGINEERING', 'Engineering', 1, 'AGENCY'::"OrganizationVertical"),
    ('PRODUCT', 'Product', 2, 'AGENCY'::"OrganizationVertical"),
    ('QUALITY', 'Quality', 3, 'AGENCY'::"OrganizationVertical"),
    ('MARKETING', 'Marketing', 4, 'AGENCY'::"OrganizationVertical"),
    ('DESIGN', 'Design', 5, 'AGENCY'::"OrganizationVertical"),
    ('KITCHEN', 'Kitchen', 0, 'RESTAURANT'::"OrganizationVertical"),
    ('FRONT_OF_HOUSE', 'Front of House', 1, 'RESTAURANT'::"OrganizationVertical"),
    ('COUNTER', 'Counter', 0, 'PHARMACY'::"OrganizationVertical"),
    ('DISPENSARY', 'Dispensary', 1, 'PHARMACY'::"OrganizationVertical"),
    ('STORE', 'Store', 2, 'PHARMACY'::"OrganizationVertical"),
    ('PROCUREMENT', 'Procurement', 3, 'PHARMACY'::"OrganizationVertical"),
    ('FINANCE', 'Finance', 4, 'PHARMACY'::"OrganizationVertical"),
    ('COMPLIANCE', 'Compliance', 5, 'PHARMACY'::"OrganizationVertical"),
    ('FRONT_OFFICE', 'Front Office', 0, 'HOSPITALITY'::"OrganizationVertical"),
    ('HOUSEKEEPING', 'Housekeeping', 1, 'HOSPITALITY'::"OrganizationVertical"),
    ('MAINTENANCE', 'Maintenance', 2, 'HOSPITALITY'::"OrganizationVertical"),
    ('FOOD_AND_BEVERAGE', 'Food and Beverage', 3, 'HOSPITALITY'::"OrganizationVertical"),
    ('SALES_AND_EVENTS', 'Sales and Events', 4, 'HOSPITALITY'::"OrganizationVertical"),
    ('FINANCE', 'Finance', 5, 'HOSPITALITY'::"OrganizationVertical")
  ) AS catalog(key, name, position, vertical)
  WHERE catalog.vertical = o."vertical"
) defaults
-- Only an existing department key means that this default already exists.
-- A different key using the same name must remain a visible unique-constraint
-- error instead of silently leaving the required key absent.
ON CONFLICT ("organizationId", "key") DO NOTHING;
