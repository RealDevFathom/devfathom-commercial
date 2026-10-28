-- Bind the audit to the exact branch as well as actor, document and transaction.
CREATE OR REPLACE FUNCTION pharmacy_has_solo_audit(org text, branch text, actor text, kind text, target text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 LOCK TABLE users, pharmacy_branch_assignments, restaurant_staff_profiles IN SHARE MODE;
 RETURN pharmacy_solo_owner_eligible(org, branch, actor) AND EXISTS (
   SELECT 1 FROM audit_logs a WHERE a.id = current_setting('app.pharmacy_solo_audit_id', true)
   AND a."organizationId" = org AND a."actorId" = actor AND a.action = 'PHARMACY:SOLO_OWNER_PIN'
   AND a."targetType" = kind AND a."targetId" = target AND a.outcome = 'SUCCESS'
   AND a.metadata->>'reauthentication' = 'PIN'
   AND (a.metadata->>'branchId') IS NOT DISTINCT FROM branch
   AND a.xmin::text = pg_current_xact_id()::text);
END $$;

CREATE FUNCTION pharmacy_guard_solo_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maker text;
BEGIN
 SELECT r."submittedByUserId" INTO maker FROM pharmacy_debit_notes n
 JOIN pharmacy_purchase_returns r ON r.id=n."purchaseReturnId" AND r."organizationId"=n."organizationId"
 WHERE n.id=NEW."debitNoteId" AND n."organizationId"=NEW."organizationId";
 IF maker=NEW."allocatedByUserId" AND NOT pharmacy_has_solo_audit(NEW."organizationId", NEW."branchId", maker, 'PharmacySupplierCreditAllocation', NEW.id)
 THEN RAISE EXCEPTION 'settlement self approval requires solo owner PIN audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_settlement_solo BEFORE INSERT ON pharmacy_supplier_credit_allocations
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_solo_settlement();
