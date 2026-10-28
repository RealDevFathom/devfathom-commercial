-- A solo exception requires a current tenant owner, a fresh transaction-bound
-- PIN audit, and exactly one active staff identity in the applicable scope.
CREATE FUNCTION pharmacy_solo_owner_eligible(org text, branch text, actor text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM users u LEFT JOIN organization_roles r ON r.id = u."organizationRoleId"
   AND r."organizationId" = org
   WHERE u.id = actor AND u."organizationId" = org AND u.status = 'ACTIVE'
     AND (u.role = 'ADMIN' OR r.key = 'owner'))
 AND (SELECT count(*) FROM users u WHERE u."organizationId" = org AND u.status = 'ACTIVE'
   AND (branch IS NULL OR u.role = 'ADMIN'
     OR EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = org AND a."userId" = u.id AND a.active AND a."branchId" = branch)
     OR NOT EXISTS (SELECT 1 FROM pharmacy_branch_assignments a WHERE a."organizationId" = org AND a."userId" = u.id AND a.active))) = 1
 AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles s WHERE s."organizationId" = org AND s.status = 'ACTIVE' AND s."userId" IS NULL)
$$;

CREATE FUNCTION pharmacy_has_solo_audit(org text, branch text, actor text, kind text, target text)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT pharmacy_solo_owner_eligible(org, branch, actor) AND EXISTS (
   SELECT 1 FROM audit_logs a WHERE a.id = current_setting('app.pharmacy_solo_audit_id', true)
   AND a."organizationId" = org AND a."actorId" = actor AND a.action = 'PHARMACY:SOLO_OWNER_PIN'
   AND a."targetType" = kind AND a."targetId" = target
   AND a.metadata->>'reauthentication' = 'PIN'
   AND a.xmin::text = pg_current_xact_id()::text)
$$;

-- Replace only the unconditional maker/approver inequality, preserving every
-- other purchasing constraint and the existing status machine.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'pharmacy_purchase_orders'::regclass
   AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%"approvedByUserId" <> "createdByUserId"%'
 LOOP EXECUTE format('ALTER TABLE pharmacy_purchase_orders DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE pharmacy_goods_receipts DROP CONSTRAINT pharmacy_goods_receipts_bypass_actor_check;

CREATE FUNCTION pharmacy_guard_purchase_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maker text;
BEGIN
 -- Staff roster writes cannot race the singleton decision. Locks last until
 -- the document and its audit commit together.
 LOCK TABLE users, pharmacy_branch_assignments, restaurant_staff_profiles IN SHARE MODE;
 IF TG_TABLE_NAME = 'pharmacy_purchase_orders' THEN
   -- Re-check only when approval evidence changes, so historical approval
   -- remains valid when another staff member later joins.
   IF TG_OP = 'UPDATE' AND NEW."approvedByUserId" IS NOT DISTINCT FROM OLD."approvedByUserId"
      AND (NEW."createdByUserId", NEW."requisitionId", NEW."branchId", NEW."organizationId", NEW.id)
          IS NOT DISTINCT FROM (OLD."createdByUserId", OLD."requisitionId", OLD."branchId", OLD."organizationId", OLD.id)
      AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt" THEN RETURN NEW; END IF;
   SELECT "requestedByUserId" INTO maker FROM pharmacy_requisitions WHERE id = NEW."requisitionId" AND "organizationId" = NEW."organizationId";
   IF NEW."approvedByUserId" IS NOT NULL AND (NEW."approvedByUserId" = NEW."createdByUserId" OR NEW."approvedByUserId" = maker)
     AND NOT pharmacy_has_solo_audit(NEW."organizationId", NEW."branchId", NEW."approvedByUserId", 'PharmacyPurchaseOrder', NEW.id)
   THEN RAISE EXCEPTION 'purchase self approval requires solo owner PIN audit' USING ERRCODE = '23514'; END IF;
 ELSE
   IF TG_OP = 'UPDATE' AND NEW."bypassApprovedByUserId" IS NOT DISTINCT FROM OLD."bypassApprovedByUserId"
      AND (NEW."receivedByUserId", NEW."branchId", NEW."organizationId", NEW.id)
          IS NOT DISTINCT FROM (OLD."receivedByUserId", OLD."branchId", OLD."organizationId", OLD.id)
      AND NEW."bypassApprovedAt" IS NOT DISTINCT FROM OLD."bypassApprovedAt" THEN RETURN NEW; END IF;
   IF NEW."bypassApprovedByUserId" = NEW."receivedByUserId"
     AND NOT pharmacy_has_solo_audit(NEW."organizationId", NEW."branchId", NEW."receivedByUserId", 'PharmacyGoodsReceipt', NEW.id)
   THEN RAISE EXCEPTION 'direct purchase self approval requires solo owner PIN audit' USING ERRCODE = '23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_purchase_self_approval BEFORE INSERT OR UPDATE ON pharmacy_purchase_orders
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_purchase_self_approval();
CREATE TRIGGER pharmacy_receipt_self_approval BEFORE INSERT OR UPDATE ON pharmacy_goods_receipts
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_purchase_self_approval();
