BEGIN;
CREATE OR REPLACE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM users u
 JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
 JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
 WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE' AND r.key='owner' AND r."isSystem")
 AND (SELECT count(*) FROM users u WHERE u."organizationId"=org AND u.status='ACTIVE')=1
 AND (branch IS NULL OR EXISTS (SELECT 1 FROM pharmacy_branches b
 WHERE b.id=branch AND b."organizationId"=org AND b.active))
$$;

-- Materialize owner access across branch and user lifecycles without an elevated function.
ALTER TABLE pharmacy_branch_assignments ADD COLUMN IF NOT EXISTS "ownerManaged" boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION pharmacy_assign_branch_owners() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW."organizationId" AND vertical='PHARMACY') THEN RETURN NEW; END IF;
  -- Serialize with the solo-owner approval's active-staff count, including users
  -- without an operator profile or branch assignment.
  PERFORM id FROM organizations WHERE id=NEW."organizationId" FOR NO KEY UPDATE;
  UPDATE pharmacy_branch_assignments a SET active=false, "updatedAt"=CURRENT_TIMESTAMP
  WHERE a."organizationId"=NEW."organizationId" AND a."ownerManaged"
    AND NOT EXISTS (SELECT 1 FROM users u LEFT JOIN organization_roles r
      ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
      WHERE u.id=a."userId" AND u."organizationId"=a."organizationId"
        AND u.status='ACTIVE' AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY')));
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "ownerManaged", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, b."organizationId", b.id, u.id, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM pharmacy_branches b JOIN users u ON u."organizationId"=b."organizationId"
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE b."organizationId"=NEW."organizationId" AND b.active AND u.status='ACTIVE'
    AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY'))
  ON CONFLICT ("organizationId","branchId","userId") DO UPDATE SET active=true, "updatedAt"=CURRENT_TIMESTAMP
  WHERE pharmacy_branch_assignments."ownerManaged";
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_branch_owners ON pharmacy_branches;
CREATE TRIGGER pharmacy_branch_owners AFTER INSERT OR UPDATE OF active ON pharmacy_branches
  FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_branch_owners();
DROP TRIGGER IF EXISTS pharmacy_user_branches ON users;
CREATE TRIGGER pharmacy_user_branches AFTER INSERT OR UPDATE OF role, status, "organizationRoleId" ON users
  FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_branch_owners();
DROP TRIGGER IF EXISTS pharmacy_role_branches ON organization_roles;
CREATE TRIGGER pharmacy_role_branches AFTER UPDATE OF key, "isSystem" ON organization_roles
  FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_branch_owners();

-- Backfill every existing active owner in explicit, transaction-local platform scope.
DO $$ DECLARE previous_scope text := current_setting('app.is_platform_admin', true); BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "ownerManaged", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, b."organizationId", b.id, u.id, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM pharmacy_branches b JOIN users u ON u."organizationId"=b."organizationId"
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE b.active AND u.status='ACTIVE' AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY'))
  ON CONFLICT ("organizationId","branchId","userId") DO UPDATE SET active=true, "updatedAt"=CURRENT_TIMESTAMP
  WHERE pharmacy_branch_assignments."ownerManaged";
  PERFORM set_config('app.is_platform_admin', COALESCE(previous_scope,''), true);
END $$;

COMMIT;
