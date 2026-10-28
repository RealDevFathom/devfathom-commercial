-- Serialize eligibility with every roster write in the same organization.
-- A no-op row UPDATE supplies both a transaction lock and a new MVCC version:
-- READ COMMITTED readers recheck after waiting; older REPEATABLE READ/SERIALIZABLE
-- snapshots fail with a serialization error instead of accepting stale eligibility.
-- Unlike table locks, unrelated tenants and concurrent approvals cannot deadlock
-- through table-lock upgrades. No organization business fields are changed.
CREATE FUNCTION pharmacy_lock_solo_roster(org text) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 -- Touch a non-key column so ordinary FK KEY SHARE locks stay compatible.
 PERFORM id FROM organizations WHERE id = org FOR NO KEY UPDATE;
 UPDATE organizations SET "updatedAt"="updatedAt" WHERE id=org;
END $$;

CREATE FUNCTION pharmacy_serialize_solo_roster() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_org text; new_org text; org text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_org := OLD."organizationId"; END IF;
 IF TG_OP <> 'DELETE' THEN new_org := NEW."organizationId"; END IF;
 -- Stable ordering also covers privileged cross-organization moves.
 FOR org IN SELECT DISTINCT value FROM unnest(ARRAY[old_org, new_org]) AS t(value)
            WHERE value IS NOT NULL ORDER BY value
 LOOP
   PERFORM pharmacy_lock_solo_roster(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_users_solo_roster BEFORE INSERT OR UPDATE OR DELETE ON users
 FOR EACH ROW EXECUTE FUNCTION pharmacy_serialize_solo_roster();
CREATE TRIGGER pharmacy_assignments_solo_roster BEFORE INSERT OR UPDATE OR DELETE ON pharmacy_branch_assignments
 FOR EACH ROW EXECUTE FUNCTION pharmacy_serialize_solo_roster();
CREATE TRIGGER pharmacy_staff_solo_roster BEFORE INSERT OR UPDATE OR DELETE ON restaurant_staff_profiles
 FOR EACH ROW EXECUTE FUNCTION pharmacy_serialize_solo_roster();
-- Renaming/deleting the owner's role can change eligibility without a user write.
CREATE TRIGGER pharmacy_roles_solo_roster BEFORE INSERT OR UPDATE OR DELETE ON organization_roles
 FOR EACH ROW EXECUTE FUNCTION pharmacy_serialize_solo_roster();

-- Bind the audit to the exact branch as well as actor, document and transaction.
CREATE OR REPLACE FUNCTION pharmacy_has_solo_audit(org text, branch text, actor text, kind text, target text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 PERFORM pharmacy_lock_solo_roster(org);
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
