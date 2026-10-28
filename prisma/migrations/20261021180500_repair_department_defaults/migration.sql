-- Replay the original data predicate under platform scope (#218).
-- Preserve configured department keys; name collisions abort for explicit resolution.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

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
) d
ON CONFLICT ("organizationId", "key") DO NOTHING;

COMMIT;
