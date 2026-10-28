-- Preserve full pharmacy operation for existing and newly provisioned proprietors.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
SELECT 'm1_' || md5(r.id || ':' || c.capability), r."organizationId", r.id, c.capability, 'ALLOW'::"PermissionEffect"
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
CROSS JOIN (VALUES ('pharmacy:dispense'), ('pharmacy:safety'), ('pharmacy:catalogue-review')) c(capability)
WHERE o.vertical = 'PHARMACY' AND r.key = 'owner' AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

-- Invoker rights and explicit tenant joins preserve forced RLS. Also runs when
-- a branch is added or a staff member becomes the owner after onboarding.
CREATE FUNCTION pharmacy_assign_owner_branches() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pharmacy_branch_assignments
    (id, "organizationId", "branchId", "userId", active, "updatedAt")
  SELECT 'm1_pba_' || md5(u.id || ':' || b.id), u."organizationId", b.id, u.id, true, now()
  FROM users u
  JOIN organization_roles r ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
  JOIN organizations o ON o.id = u."organizationId" AND o.vertical = 'PHARMACY'
  JOIN pharmacy_branches b ON b."organizationId" = u."organizationId"
  WHERE u."organizationId" = NEW."organizationId" AND u.status = 'ACTIVE'
    AND r.key = 'owner' AND r."isSystem" = true AND b.active = true
  ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active = true, "updatedAt" = now();
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_owner_branch_user AFTER INSERT OR UPDATE OF "organizationRoleId", status ON users
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();
CREATE TRIGGER pharmacy_owner_branch_new AFTER INSERT OR UPDATE OF active ON pharmacy_branches
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();
CREATE TRIGGER pharmacy_owner_branch_role AFTER INSERT OR UPDATE OF key, "isSystem" ON organization_roles
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();

INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "updatedAt")
SELECT 'm1_pba_' || md5(u.id || ':' || b.id), u."organizationId", b.id, u.id, true, now()
FROM users u
JOIN organization_roles r ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
JOIN organizations o ON o.id = u."organizationId" AND o.vertical = 'PHARMACY'
JOIN pharmacy_branches b ON b."organizationId" = u."organizationId" AND b.active = true
WHERE u.status = 'ACTIVE' AND r.key = 'owner' AND r."isSystem" = true
ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active = true, "updatedAt" = now();

-- Replace the blanket two-person constraint with a narrow audited solo-owner
-- exception. Ordinary inserts still require a second witness.
ALTER TABLE pharmacy_controlled_register_entries
  DROP CONSTRAINT IF EXISTS pharmacy_controlled_register_entries_check;
CREATE FUNCTION pharmacy_check_solo_register_witness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recordedByUserId" = NEW."witnessedByUserId" THEN
    IF NOT EXISTS (
      SELECT 1 FROM users u
      JOIN organization_roles r ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
      JOIN organizations o ON o.id = u."organizationId" AND o.vertical = 'PHARMACY'
      WHERE u.id = NEW."recordedByUserId" AND u."organizationId" = NEW."organizationId"
        AND u.status = 'ACTIVE' AND r.key = 'owner' AND r."isSystem" = true
    ) OR (SELECT count(*) FROM users WHERE "organizationId" = NEW."organizationId" AND status = 'ACTIVE') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM audit_logs a WHERE a."organizationId" = NEW."organizationId"
        AND a."actorId" = NEW."recordedByUserId" AND a.action = 'pharmacy.soloOwnerSelfApproval'
        AND a."createdAt" >= date_trunc('milliseconds', transaction_timestamp())
        AND a.metadata->>'branchId' = NEW."branchId"
        AND a.metadata->>'purpose' IN ('controlled-restoration','controlled-purchase','controlled-correction')
        AND length(a.metadata->>'credentialId') > 0
    ) THEN
      RAISE EXCEPTION 'A second witness or audited solo-owner PIN approval is required' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_solo_register_witness BEFORE INSERT OR UPDATE ON pharmacy_controlled_register_entries
FOR EACH ROW EXECUTE FUNCTION pharmacy_check_solo_register_witness();
