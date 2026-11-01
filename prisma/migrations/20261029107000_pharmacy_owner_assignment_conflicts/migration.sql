-- Owner access supersedes prior manual assignments; manage it through demotion and reactivation.
BEGIN;
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
  ON CONFLICT ("organizationId","branchId","userId") DO UPDATE SET active=true, "ownerManaged"=(pharmacy_branch_assignments."ownerManaged" OR NOT pharmacy_branch_assignments.active), "updatedAt"=CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;


-- Repair existing conflicts as well as future promotions.
DO $$ DECLARE previous_scope text := current_setting('app.is_platform_admin', true); BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "ownerManaged", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, b."organizationId", b.id, u.id, true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  FROM pharmacy_branches b JOIN users u ON u."organizationId"=b."organizationId"
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE b.active AND u.status='ACTIVE' AND (r.key='owner' AND r."isSystem" AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=u."organizationId" AND o.vertical='PHARMACY'))
  ON CONFLICT ("organizationId","branchId","userId") DO UPDATE SET active=true, "ownerManaged"=(pharmacy_branch_assignments."ownerManaged" OR NOT pharmacy_branch_assignments.active), "updatedAt"=CURRENT_TIMESTAMP;
  PERFORM set_config('app.is_platform_admin', COALESCE(previous_scope,''), true);
END $$;

COMMIT;
