-- Default pharmacy owners receive all capabilities, with explicit clinical grants.
-- Preserve all existing DENYs, including conflicts on the same capability.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions (id, "organizationId", "organizationRoleId", capability, effect)
SELECT 'pop_' || md5(r.id || ':' || c.capability), r."organizationId", r.id, c.capability, 'ALLOW'
FROM organization_roles r JOIN organizations o ON o.id=r."organizationId"
CROSS JOIN (VALUES ('*'), ('pharmacy:dispense'), ('pharmacy:safety'), ('pharmacy:catalogue-review')) c(capability)
WHERE o.vertical='PHARMACY' AND r.key IN ('owner','admin') AND r."isSystem"=true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

-- All lifecycle entry points: new branches, new owners, role changes and reactivation.
CREATE FUNCTION pharmacy_assign_owners() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organizations WHERE id=COALESCE(NEW."organizationId", OLD."organizationId") AND vertical='PHARMACY' FOR UPDATE;
  INSERT INTO pharmacy_branch_assignments (id, "organizationId", "branchId", "userId", active, "updatedAt")
  SELECT 'poa_' || md5(u."organizationId" || ':' || b.id || ':' || u.id), u."organizationId", b.id, u.id, true, now()
  FROM users u JOIN organizations o ON o.id=u."organizationId"
  JOIN pharmacy_branches b ON b."organizationId"=u."organizationId"
  LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
  WHERE o.vertical='PHARMACY' AND u.status IN ('ACTIVE', 'ON_LEAVE')
    AND (u.role='ADMIN' OR (r.key IN ('owner','admin') AND r."isSystem"=true))
    AND u."organizationId"=NEW."organizationId"
  ON CONFLICT ("organizationId", "branchId", "userId") DO UPDATE SET active=true, "updatedAt"=now();
  RETURN NEW;
END $$;

-- Replace only the unconditional maker/checker constraint, preserving timestamp
-- consistency and every supplier/tenant FK. The guarded trigger handles both
-- the order maker and the demand requester (including direct SQL writes).
ALTER TABLE pharmacy_purchase_orders DROP CONSTRAINT pharmacy_purchase_orders_check;
CREATE FUNCTION pharmacy_po_check_approver() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text;
BEGIN
  IF NEW."approvedByUserId" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW."approvedByUserId" IS NOT DISTINCT FROM OLD."approvedByUserId"
      AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
      AND NEW."createdByUserId"=OLD."createdByUserId"
      AND NEW."requisitionId" IS NOT DISTINCT FROM OLD."requisitionId" THEN RETURN NEW; END IF;
  END IF;
  SELECT "requestedByUserId" INTO requester FROM pharmacy_requisitions WHERE id=NEW."requisitionId" AND "organizationId"=NEW."organizationId";
  IF NEW."approvedByUserId" IN (NEW."createdByUserId", requester) AND NOT pharmacy_solo_owner_proof(NEW."organizationId", NEW."approvedByUserId", NEW.id, 'pharmacy:procurement', NEW."branchId") THEN
    RAISE EXCEPTION 'purchase order requires a second approver or solo owner PIN proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_po_check_approver BEFORE INSERT OR UPDATE ON pharmacy_purchase_orders FOR EACH ROW EXECUTE FUNCTION pharmacy_po_check_approver();
CREATE TRIGGER pharmacy_new_branch_owners AFTER INSERT OR UPDATE ON pharmacy_branches FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owners();
CREATE TRIGGER pharmacy_new_owner_branches AFTER INSERT OR UPDATE OF "organizationRoleId", role, status ON users FOR EACH ROW EXECUTE FUNCTION pharmacy_assign_owners();
-- Trigger existing tenants through the same idempotent assignment path.
UPDATE pharmacy_branches SET "updatedAt"="updatedAt";

-- Unassigned active members remain in scope: a missing assignment never creates solo mode.
CREATE FUNCTION pharmacy_is_solo_owner(org text, actor text, branch text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u JOIN organizations o ON o.id=u."organizationId"
    LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
    WHERE u.id=actor AND u."organizationId"=org AND u.status='ACTIVE' AND o.vertical='PHARMACY'
      AND (u.role='ADMIN' OR (r.key IN ('owner','admin') AND r."isSystem"=true))
  ) AND (branch IS NULL OR EXISTS (SELECT 1 FROM pharmacy_branches b WHERE b.id=branch AND b."organizationId"=org AND b.active))
    AND NOT EXISTS (
      SELECT 1 FROM users u LEFT JOIN organization_roles r ON r.id=u."organizationRoleId" AND r."organizationId"=org
      WHERE u."organizationId"=org AND u.id<>actor AND u.status IN ('ACTIVE','ON_LEAVE') AND (
        branch IS NULL OR u.role='ADMIN' OR (r.key IN ('owner','admin') AND r."isSystem"=true)
        OR EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId"=org AND a."userId"=u.id AND a."branchId"=branch AND a.active)
        OR NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId"=org AND a."userId"=u.id AND a.active)
      )
    ) AND NOT EXISTS (
      SELECT 1 FROM restaurant_staff_profiles p WHERE p."organizationId"=org AND p.status='ACTIVE' AND (p."userId" IS NULL OR (
        p."userId"<>actor AND (branch IS NULL
          OR EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId"=org AND a."userId"=p."userId" AND a."branchId"=branch AND a.active)
          OR NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId"=org AND a."userId"=p."userId" AND a.active))
      ))
    );
$$;

-- A successful application PIN check records a fresh audit in this transaction.
-- Binding to transaction + target prevents replay of a previous reauthentication.
CREATE FUNCTION pharmacy_solo_owner_proof(org text, actor text, target text, capability text, branch text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT pharmacy_is_solo_owner(org, actor, branch) AND EXISTS (
    SELECT 1 FROM audit_logs a WHERE a."organizationId"=org AND a."actorId"=actor
      AND a.action='pharmacy.soloOwnerApproval' AND a."targetId"=target AND a.outcome='SUCCESS'
      AND a.metadata->>'policy'='SOLO_OWNER_PIN' AND a.metadata->>'capability'=capability
      AND a.metadata->>'transactionId'=txid_current()::text
      AND (branch IS NULL OR a.metadata->>'branchId'=branch)
  );
$$;
CREATE OR REPLACE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text; branch text;
BEGIN
  -- Lock tenant membership before checking the exceptional solo state.
  PERFORM id FROM organizations WHERE id=COALESCE(NEW."organizationId", OLD."organizationId") AND vertical='PHARMACY' FOR UPDATE;
  SELECT "requestedByUserId" INTO requester FROM pharmacy_pharmacist_review_items
    WHERE "organizationId"=NEW."organizationId" AND id=NEW."reviewItemId";
  SELECT l."branchId" INTO branch FROM pharmacy_pharmacist_review_items i JOIN pharmacy_sale_lines l ON l.id=i."saleLineId" AND l."organizationId"=i."organizationId" WHERE i.id=NEW."reviewItemId" AND i."organizationId"=NEW."organizationId";
  IF NEW."actorUserId"=requester AND NOT pharmacy_solo_owner_proof(NEW."organizationId", NEW."actorUserId", NEW."reviewItemId", 'pharmacy:dispense', branch) THEN
    RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line without solo owner PIN proof' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- Serialize all staff lifecycle changes with the solo decision. An uncommitted
-- new staff member cannot become active between the count and approval commit.
CREATE FUNCTION pharmacy_lock_staff_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organizations WHERE id=COALESCE(NEW."organizationId", OLD."organizationId") AND vertical='PHARMACY' FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_staff_membership_lock BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION pharmacy_lock_staff_membership();
CREATE TRIGGER pharmacy_profile_membership_lock BEFORE INSERT OR UPDATE ON restaurant_staff_profiles FOR EACH ROW EXECUTE FUNCTION pharmacy_lock_staff_membership();

CREATE TRIGGER pharmacy_assignment_membership_lock BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_branch_assignments FOR EACH ROW EXECUTE FUNCTION pharmacy_lock_staff_membership();
-- Keep the controlled register's independent witness invariant except for fresh solo PIN proof.
ALTER TABLE pharmacy_controlled_register_entries DROP CONSTRAINT pharmacy_controlled_register_entries_check;
CREATE FUNCTION pharmacy_controlled_solo_witness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."recordedByUserId"=NEW."witnessedByUserId" AND NOT pharmacy_solo_owner_proof(NEW."organizationId", NEW."recordedByUserId", NEW."branchId", 'pharmacy:dispense', NEW."branchId") THEN
    RAISE EXCEPTION 'controlled register requires another witness or solo owner PIN proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_controlled_solo_witness BEFORE INSERT ON pharmacy_controlled_register_entries FOR EACH ROW EXECUTE FUNCTION pharmacy_controlled_solo_witness();

ALTER TABLE pharmacy_custody_records DROP CONSTRAINT pharmacy_custody_records_check;
ALTER TABLE pharmacy_custody_records ADD CONSTRAINT pharmacy_custody_evidence CHECK (length(btrim("reason"))>0 AND length(btrim("evidenceRef"))>0);
CREATE FUNCTION pharmacy_custody_solo_witness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."actorId"=NEW."witnessId" AND NOT pharmacy_solo_owner_proof(NEW."organizationId", NEW."actorId", NEW."branchId", 'pharmacy:inventory', NEW."branchId") THEN
    RAISE EXCEPTION 'custody requires another witness or solo owner PIN proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_custody_solo_witness BEFORE INSERT ON pharmacy_custody_records FOR EACH ROW EXECUTE FUNCTION pharmacy_custody_solo_witness();

ALTER TABLE pharmacy_goods_receipts DROP CONSTRAINT pharmacy_goods_receipts_bypass_actor_check;
CREATE FUNCTION pharmacy_receipt_solo_bypass() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW."bypassApprovedByUserId" IS NOT DISTINCT FROM OLD."bypassApprovedByUserId" AND NEW."receivedByUserId"=OLD."receivedByUserId" AND NEW."branchId"=OLD."branchId" THEN RETURN NEW; END IF;
  IF NEW."bypassApprovedByUserId"=NEW."receivedByUserId" AND NOT pharmacy_solo_owner_proof(NEW."organizationId", NEW."receivedByUserId", NEW."branchId", 'pharmacy:procurement', NEW."branchId") THEN
    RAISE EXCEPTION 'direct purchase requires another approver or solo owner PIN proof' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_receipt_solo_bypass BEFORE INSERT OR UPDATE ON pharmacy_goods_receipts FOR EACH ROW EXECUTE FUNCTION pharmacy_receipt_solo_bypass();
