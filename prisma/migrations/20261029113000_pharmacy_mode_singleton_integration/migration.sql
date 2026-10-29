BEGIN;
-- The mode migration sorts before the owner series. Preserve both contracts at
-- the final schema: explicit SOLO policy AND the sole active proprietor rule.
CREATE OR REPLACE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
   SELECT 1 FROM users u
   JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
     AND o."pharmacyOperatingMode"='SOLO'
   JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
     AND r.key='owner' AND r."isSystem"
   WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE'
 ) AND (SELECT count(*) FROM users u WHERE u."organizationId"=org AND u.status='ACTIVE')=1
 AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles s
   WHERE s."organizationId"=org AND s.status='ACTIVE' AND s."userId" IS NULL)
 AND (branch IS NULL OR EXISTS (SELECT 1 FROM pharmacy_branches b
   WHERE b.id=branch AND b."organizationId"=org AND b.active));
$$;
-- Former pre-release triggers must not create unmanaged assignments before the
-- current owner lifecycle trigger. Do not relabel historical manual rows.
DROP TRIGGER IF EXISTS pharmacy_branch_assign_owners ON pharmacy_branches;
DROP TRIGGER IF EXISTS pharmacy_owner_new_branch_assignments ON pharmacy_branches;
DROP TRIGGER IF EXISTS pharmacy_owner_role_assignments ON organization_roles;
DROP TRIGGER IF EXISTS pharmacy_role_assign_owner_branches ON organization_roles;
DROP TRIGGER IF EXISTS pharmacy_owner_user_assignments ON users;
DROP TRIGGER IF EXISTS pharmacy_user_assign_owner_branches ON users;
-- Current pharmacy_purchase_self_approval retains the strict audited check.
DROP TRIGGER IF EXISTS pharmacy_solo_owner_approval_guard ON pharmacy_purchase_orders;
COMMIT;
