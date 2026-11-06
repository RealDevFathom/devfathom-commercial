-- A scan's evidence is retained unchanged; only its existing one-time
-- acknowledgement can be added. Acknowledgement never changes the verdict.
CREATE FUNCTION pharmacy_pack_scan_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['acknowledgedAt', 'acknowledgedByUserId', 'acknowledgementReason'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['acknowledgedAt', 'acknowledgedByUserId', 'acknowledgementReason']) THEN
    RAISE EXCEPTION 'PACK_SCAN_EVIDENCE_IMMUTABLE';
  END IF;
  IF OLD."acknowledgedAt" IS NOT NULL AND
     (NEW."acknowledgedAt", NEW."acknowledgedByUserId", NEW."acknowledgementReason")
     IS DISTINCT FROM
     (OLD."acknowledgedAt", OLD."acknowledgedByUserId", OLD."acknowledgementReason") THEN
    RAISE EXCEPTION 'PACK_SCAN_ACKNOWLEDGEMENT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER pharmacy_pack_scan_evidence_immutable
  BEFORE UPDATE ON pharmacy_pack_authentication_scans
  FOR EACH ROW EXECUTE FUNCTION pharmacy_pack_scan_evidence_immutable();
