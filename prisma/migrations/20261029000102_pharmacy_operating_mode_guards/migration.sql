BEGIN;
-- Keep the #683 owner, head-count, branch and transaction-bound audit guards.
-- This independent gate survives later CREATE OR REPLACE eligibility functions.
CREATE OR REPLACE FUNCTION pharmacy_guard_solo_mode_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action = 'PHARMACY:SOLO_OWNER_PIN' THEN
   IF TG_WHEN = 'AFTER' THEN
     PERFORM id FROM organizations WHERE id=NEW."organizationId" FOR NO KEY UPDATE;
   END IF;
   IF NOT EXISTS (SELECT 1 FROM organizations WHERE id=NEW."organizationId"
      AND vertical='PHARMACY' AND "pharmacyOperatingMode"='SOLO') THEN
     RAISE EXCEPTION 'SOLO approval requires SOLO operating mode' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_solo_mode_audit ON audit_logs;
CREATE TRIGGER pharmacy_solo_mode_audit BEFORE INSERT ON audit_logs
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_solo_mode_audit();
-- Recheck after document/roster guards, at commit. A concurrent mode toggle
-- cannot leave current-transaction SOLO evidence valid in a STAFFED tenant.
DROP TRIGGER IF EXISTS pharmacy_solo_mode_audit_commit ON audit_logs;
CREATE CONSTRAINT TRIGGER pharmacy_solo_mode_audit_commit AFTER INSERT ON audit_logs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_solo_mode_audit();
COMMIT;
