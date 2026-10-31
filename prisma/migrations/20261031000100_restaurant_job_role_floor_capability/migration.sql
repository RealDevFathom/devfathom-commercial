BEGIN;

-- Align already-provisioned Restaurant system job roles (`manager`, `owner`) with
-- the job-role catalog so a manager holding the role at a secondary branch can
-- manage that branch's floor. Job-role capabilities carry no effect column;
-- per-person DENYs live on staff capability grants and keep subtracting.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "restaurant_job_role_capabilities"
  ("id", "organizationId", "jobRoleId", "capability", "createdAt")
SELECT
  'rest_jr_floor_' || md5(job_role.id || ':floor:manage'),
  job_role."organizationId",
  job_role.id,
  'floor:manage',
  CURRENT_TIMESTAMP
FROM "restaurant_job_roles" job_role
JOIN "organizations" organization ON organization.id = job_role."organizationId"
WHERE organization.vertical = 'RESTAURANT'
  AND job_role."isSystem" = true
  AND job_role.key IN ('manager', 'owner')
ON CONFLICT ("jobRoleId", "capability") DO NOTHING;

COMMIT;
