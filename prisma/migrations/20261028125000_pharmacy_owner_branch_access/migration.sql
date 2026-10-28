-- Owners retain every active branch, including branches created after onboarding.
-- Invoker rights preserve the existing tenant RLS boundary; no security definer.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
SELECT 'owner_cap_' || md5(r.id || ':' || c.capability), r."organizationId", r.id, c.capability, 'ALLOW'::"PermissionEffect"
FROM organization_roles r JOIN organizations o ON o.id=r."organizationId"
CROSS JOIN (VALUES ('pharmacy:dispense'), ('pharmacy:safety'), ('pharmacy:catalogue-review')) c(capability)
WHERE o.vertical='PHARMACY' AND r.key='owner'
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

CREATE FUNCTION pharmacy_assign_owner_branches(target_org text) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "updatedAt")
  SELECT 'pba_' || md5(u."organizationId" || ':' || b.id || ':' || u.id), u."organizationId", b.id, u.id, true, CURRENT_TIMESTAMP
  FROM users u
  JOIN organizations o ON o.id=u."organizationId" AND o.vertical='PHARMACY'
  JOIN pharmacy_branches b ON b."organizationId"=u."organizationId" AND b.active
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE u."organizationId"=target_org AND u.status IN ('ACTIVE', 'ON_LEAVE')
    AND (u.role='ADMIN' OR r.key IN ('owner', 'owner-operator'))
  ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active=true, "updatedAt"=CURRENT_TIMESTAMP
  WHERE NOT pharmacy_branch_assignments.active;
$$;

CREATE FUNCTION pharmacy_refresh_owner_branches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pharmacy_assign_owner_branches(NEW."organizationId");
  RETURN NEW;
END;
$$;
CREATE TRIGGER pharmacy_branch_assign_owners AFTER INSERT OR UPDATE OF active ON pharmacy_branches
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refresh_owner_branches();
CREATE TRIGGER pharmacy_user_assign_owner_branches AFTER INSERT OR UPDATE OF role, "organizationRoleId", status ON users
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refresh_owner_branches();
CREATE TRIGGER pharmacy_role_assign_owner_branches AFTER UPDATE OF key ON organization_roles
  FOR EACH ROW EXECUTE FUNCTION pharmacy_refresh_owner_branches();

SELECT pharmacy_assign_owner_branches(id) FROM organizations WHERE vertical='PHARMACY';
COMMIT;
