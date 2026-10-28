-- All active owners can work in every branch and must count in every branch roster.
CREATE OR REPLACE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM users u LEFT JOIN organization_roles r ON r.id = u."organizationRoleId"
   AND r."organizationId" = org
   WHERE u.id = actor AND u."organizationId" = org AND u.status = 'ACTIVE'
     AND (u.role = 'ADMIN' OR r.key = 'owner'))
 AND (SELECT count(*) FROM users u LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org WHERE u."organizationId" = org AND u.status = 'ACTIVE'
   AND (branch IS NULL OR u.role = 'ADMIN' OR r.key = 'owner'
     OR EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = org AND a."userId" = u.id AND a.active AND a."branchId" = branch)
     OR NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = org AND a."userId" = u.id AND a.active))) = 1
 AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles s WHERE s."organizationId" = org AND s.status = 'ACTIVE' AND s."userId" IS NULL)
$$;
