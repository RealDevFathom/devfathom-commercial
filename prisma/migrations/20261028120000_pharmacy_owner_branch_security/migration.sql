-- Owners and tenant administrators always hold assignments to their own branches.
-- Run under the migration tenant bypass, never in the runtime authorization path.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE OR REPLACE FUNCTION pharmacy_assign_owner_branches() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pharmacy_branch_assignments
    (id, "organizationId", "branchId", "userId", active, "updatedAt")
  SELECT 'pba_' || md5(u."organizationId" || ':' || b.id || ':' || u.id),
    u."organizationId", b.id, u.id, true, CURRENT_TIMESTAMP
  FROM users u
  JOIN organizations o ON o.id = u."organizationId" AND o.vertical = 'PHARMACY'
  JOIN pharmacy_branches b ON b."organizationId" = u."organizationId"
  LEFT JOIN organization_roles r ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
  WHERE u."organizationId" = NEW."organizationId"
    AND u.status IN ('ACTIVE', 'ON_LEAVE')
    AND (u.role = 'ADMIN' OR (r."isSystem" AND r.key IN ('owner', 'owner-operator')))
  ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active = true, "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_owner_user_assignments ON users;
CREATE TRIGGER pharmacy_owner_user_assignments
AFTER INSERT OR UPDATE OF "organizationRoleId", role, status ON users
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();
DROP TRIGGER IF EXISTS pharmacy_owner_new_branch_assignments ON pharmacy_branches;
CREATE TRIGGER pharmacy_owner_new_branch_assignments
AFTER INSERT OR UPDATE OF active ON pharmacy_branches
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();
DROP TRIGGER IF EXISTS pharmacy_owner_role_assignments ON organization_roles;
CREATE TRIGGER pharmacy_owner_role_assignments
AFTER UPDATE OF key, "isSystem" ON organization_roles
FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owner_branches();

INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "updatedAt")
SELECT 'pba_' || md5(u."organizationId" || ':' || b.id || ':' || u.id), u."organizationId", b.id, u.id, true, CURRENT_TIMESTAMP
FROM users u
JOIN organizations o ON o.id = u."organizationId" AND o.vertical = 'PHARMACY'
JOIN pharmacy_branches b ON b."organizationId" = u."organizationId"
LEFT JOIN organization_roles r ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
WHERE u.status IN ('ACTIVE', 'ON_LEAVE') AND (u.role = 'ADMIN' OR (r."isSystem" AND r.key IN ('owner', 'owner-operator')))
ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active = true, "updatedAt" = CURRENT_TIMESTAMP;

-- Replace the unconditional creator check with an evidence-backed exception.
-- Normal second-person approval and the approvedAt/approvedBy pairing remain intact.
ALTER TABLE pharmacy_purchase_orders DROP CONSTRAINT IF EXISTS pharmacy_purchase_orders_check;
CREATE OR REPLACE FUNCTION pharmacy_guard_solo_owner_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  requester text;
BEGIN
  IF NEW."approvedByUserId" IS NULL THEN RETURN NEW; END IF;
  SELECT "requestedByUserId" INTO requester FROM pharmacy_requisitions
    WHERE id = NEW."requisitionId" AND "organizationId" = NEW."organizationId";
  IF NEW."approvedByUserId" <> NEW."createdByUserId"
    AND NEW."approvedByUserId" IS DISTINCT FROM requester THEN RETURN NEW; END IF;
  -- Subsequent send/receive transitions retain the already authorized approval.
  IF TG_OP = 'UPDATE' AND OLD."approvedByUserId" IS NOT DISTINCT FROM NEW."approvedByUserId"
    AND OLD."approvedAt" IS NOT DISTINCT FROM NEW."approvedAt"
    AND OLD."createdByUserId" = NEW."createdByUserId"
    AND OLD."requisitionId" IS NOT DISTINCT FROM NEW."requisitionId"
    AND OLD."branchId" IS NOT DISTINCT FROM NEW."branchId" THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM users u LEFT JOIN organization_roles r
      ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
    WHERE u.id = NEW."approvedByUserId" AND u."organizationId" = NEW."organizationId" AND u.status = 'ACTIVE'
      AND (u.role = 'ADMIN' OR (r."isSystem" AND r.key IN ('owner','owner-operator')))
  ) OR EXISTS (
    SELECT 1 FROM users u LEFT JOIN organization_roles r
      ON r.id = u."organizationRoleId" AND r."organizationId" = u."organizationId"
    WHERE u."organizationId" = NEW."organizationId" AND u.status = 'ACTIVE'
      AND u.id <> NEW."approvedByUserId"
      AND (NEW."branchId" IS NULL OR u.role = 'ADMIN' OR (r."isSystem" AND r.key IN ('owner','owner-operator'))
        OR NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = u."organizationId" AND a."userId" = u.id AND a.active)
        OR EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = u."organizationId" AND a."userId" = u.id AND a.active AND a."branchId" = NEW."branchId"))
  ) OR NOT EXISTS (
    SELECT 1 FROM audit_logs l
    JOIN restaurant_operator_credentials c ON c.id = l.metadata->>'credentialId' AND c."organizationId" = l."organizationId"
    JOIN restaurant_staff_profiles s ON s.id = c."staffProfileId" AND s."organizationId" = c."organizationId"
    WHERE l."organizationId" = NEW."organizationId" AND l."actorId" = NEW."approvedByUserId"
      AND l.action = 'pharmacyPurchasing.soloOwnerApproval' AND l."targetId" = NEW.id
      AND l.metadata->>'transactionId' = txid_current()::text
      AND l.metadata->>'branchId' IS NOT DISTINCT FROM NEW."branchId"
      AND c.type = 'PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL
      AND s."userId" = NEW."approvedByUserId" AND s.status = 'ACTIVE'
  ) OR NOT EXISTS (
    SELECT 1 FROM pharmacy_purchase_order_approvals a
    WHERE a."organizationId" = NEW."organizationId" AND a."purchaseOrderId" = NEW.id
      AND a."actorUserId" = NEW."approvedByUserId" AND a.policy = 'PUR-02:SOLO_OWNER_PIN' AND a.decision = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'SELF_APPROVAL requires sole owner PIN authorization and audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS pharmacy_solo_owner_approval_guard ON pharmacy_purchase_orders;
CREATE TRIGGER pharmacy_solo_owner_approval_guard BEFORE INSERT OR UPDATE ON pharmacy_purchase_orders
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_solo_owner_approval();
