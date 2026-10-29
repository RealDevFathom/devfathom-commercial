BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
-- Provisioning previously left the named administrator on the system admin role.
-- Only a sole tenant user on the system admin role proves a bootstrap owner.
-- A staffed tenant or an existing proprietor must never be promoted by inference.
CREATE TEMP TABLE pharmacy_bootstrap_owners ON COMMIT DROP AS
SELECT u.id FROM users u
JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=o.id
WHERE u.role='ADMIN' AND r.key='admin' AND r."isSystem"
AND NOT EXISTS (SELECT 1 FROM users other WHERE other."organizationId"=o.id AND other.id<>u.id);
-- Preserve explicit DENYs when binding that bootstrap identity to the owner role.
INSERT INTO user_permission_overrides (id,"organizationId","userId",capability,effect,reason,"updatedAt")
SELECT 'pbd_'||md5(u.id||p.capability),u."organizationId",u.id,p.capability,'DENY','Preserved bootstrap role denial',now()
FROM users u JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=o.id AND r.key='admin' AND r."isSystem"
JOIN organization_role_permissions p ON p."organizationRoleId"=r.id AND p.effect='DENY'
WHERE u.id IN (SELECT id FROM pharmacy_bootstrap_owners)
ON CONFLICT ("userId",capability) DO UPDATE SET effect='DENY',"expiresAt"=NULL;
INSERT INTO organization_roles (id,"organizationId",key,name,"isSystem","updatedAt")
SELECT 'pbo_'||md5(o.id),o.id,'owner','Owner',true,now() FROM organizations o WHERE o.vertical='PHARMACY'
ON CONFLICT ("organizationId",key) DO NOTHING;
INSERT INTO organization_role_permissions (id,"organizationId","organizationRoleId",capability,effect)
SELECT 'pbg_'||md5(r.id||c.capability),r."organizationId",r.id,c.capability,'ALLOW'
FROM organization_roles r JOIN organizations o ON o.id=r."organizationId" AND o.vertical='PHARMACY'
CROSS JOIN (VALUES ('*'),('pharmacy:dispense'),('pharmacy:safety'),('pharmacy:catalogue-review')) c(capability)
WHERE r.key='owner' AND r."isSystem"
ON CONFLICT ("organizationRoleId",capability) DO NOTHING;
CREATE OR REPLACE FUNCTION pharmacy_serialize_solo_roster() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_org text; new_org text; org text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_org := OLD."organizationId"; END IF;
 IF TG_OP <> 'DELETE' THEN new_org := NEW."organizationId"; END IF;
 -- Stable ordering also covers privileged cross-organization moves.
 FOR org IN SELECT DISTINCT value FROM unnest(ARRAY[old_org, new_org]) AS t(value)
            WHERE value IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id=value AND o.vertical='PHARMACY') ORDER BY value
 LOOP
   PERFORM pharmacy_lock_solo_roster(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

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


UPDATE users u SET "organizationRoleId"=owner.id
FROM organization_roles bootstrap, organization_roles owner, organizations o
WHERE o.id=u."organizationId" AND o.vertical='PHARMACY' AND u.id IN (SELECT id FROM pharmacy_bootstrap_owners)
AND bootstrap.id=u."organizationRoleId" AND bootstrap."organizationId"=o.id AND bootstrap.key='admin' AND bootstrap."isSystem"
AND owner."organizationId"=o.id AND owner.key='owner' AND owner."isSystem";
CREATE OR REPLACE FUNCTION pharmacy_guard_pv_self_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state NOT IN ('READY','SUBMITTED','CLOSED') OR NEW."reviewedByUserId" IS DISTINCT FROM NEW."createdByUserId" THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND
 (NEW.state,NEW."reviewedByUserId",NEW."createdByUserId",NEW."branchId",NEW."organizationId",NEW.id)
 IS NOT DISTINCT FROM
 (OLD.state,OLD."reviewedByUserId",OLD."createdByUserId",OLD."branchId",OLD."organizationId",OLD.id) THEN RETURN NEW; END IF;
 -- Advancing an already reviewed report does not perform another review.
 IF TG_OP='UPDATE' AND OLD.state IN ('READY','SUBMITTED','CLOSED') AND
 (NEW."reviewedByUserId",NEW."createdByUserId",NEW."branchId",NEW."organizationId",NEW.id)
 IS NOT DISTINCT FROM
 (OLD."reviewedByUserId",OLD."createdByUserId",OLD."branchId",OLD."organizationId",OLD.id) THEN RETURN NEW; END IF;
 IF NOT pharmacy_has_solo_audit(NEW."organizationId",NEW."branchId",NEW."reviewedByUserId",'PharmacyPharmacovigilanceReport',NEW.id)
 THEN RAISE EXCEPTION 'PV self review requires solo owner PIN audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_pv_solo_review ON pharmacy_pharmacovigilance_reports;
CREATE TRIGGER pharmacy_pv_solo_review BEFORE INSERT OR UPDATE ON pharmacy_pharmacovigilance_reports
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_pv_self_review();
COMMIT;
