-- Repair department catalogs for organizations created before all vertical
-- defaults were available. FORCE RLS applies to this table, including its
-- owner, so the migration needs the same transaction-local platform scope as
-- other cross-tenant data repairs.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "organization_departments"
  ("id", "organizationId", "key", "name", "sortOrder", "updatedAt")
SELECT concat('dept_', md5(o."id" || ':' || d.key)),
       o."id",
       d.key,
       d.name,
       d.position,
       CURRENT_TIMESTAMP
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
  ) AS defaults(key, name, position, vertical)
  WHERE defaults.vertical = o."vertical"
) d
-- Only an existing department key is an expected, idempotent conflict. A
-- collision on name (or any other unique constraint) must fail visibly rather
-- than silently leaving a required default absent.
ON CONFLICT ("organizationId", "key") DO NOTHING;
