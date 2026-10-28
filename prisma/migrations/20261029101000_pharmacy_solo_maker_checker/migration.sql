-- Extend the transaction-bound solo exception
-- to the other maker/checker workflows without changing their ledger checks.
CREATE OR REPLACE FUNCTION pharmacy_has_solo_audit(org text, branch text, actor text, kind text, target text)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 -- Prevent an activation, assignment, or new staff row racing the singleton
 -- decision. This is taken only for self-approval, never normal receipts.
 PERFORM id FROM organizations WHERE id=NEW."organizationId" FOR NO KEY UPDATE;
 RETURN pharmacy_solo_owner_eligible(org, branch, actor) AND EXISTS (
   SELECT 1 FROM audit_logs a WHERE a.id = current_setting('app.pharmacy_solo_audit_id', true)
   AND a."organizationId" = org AND a."actorId" = actor AND a.action = 'PHARMACY:SOLO_OWNER_PIN'
   AND a."targetType" = kind AND a."targetId" = target AND a.outcome = 'SUCCESS'
   AND a.metadata->>'reauthentication' = 'PIN'
   AND a.xmin::text = pg_current_xact_id()::text);
END $$;

CREATE OR REPLACE FUNCTION pharmacy_guard_purchase_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maker text;
BEGIN
 -- Skip historical edits only when every approval participant and audit binding is unchanged.
 IF TG_TABLE_NAME = 'pharmacy_purchase_orders' THEN
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

ALTER TABLE pharmacy_controlled_register_entries DROP CONSTRAINT IF EXISTS pharmacy_controlled_register_entries_check;
ALTER TABLE pharmacy_custody_records DROP CONSTRAINT IF EXISTS pharmacy_custody_records_check;
ALTER TABLE pharmacy_custody_records ADD CONSTRAINT pharmacy_custody_evidence_check
 CHECK (length(btrim(reason)) > 0 AND length(btrim("evidenceRef")) > 0);

CREATE FUNCTION pharmacy_guard_controlled_self_witness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; target text;
BEGIN
 IF NEW."recordedByUserId" <> NEW."witnessedByUserId" THEN RETURN NEW; END IF;
 kind := CASE split_part(NEW."signatureRef", ':', 1)
   WHEN 'solo-purchase' THEN 'ControlledPurchase' WHEN 'solo-sale' THEN 'ControlledSale'
   WHEN 'solo-restoration' THEN 'ControlledRestoration' WHEN 'solo-correction' THEN 'ControlledCorrection' END;
 target := substr(NEW."signatureRef", strpos(NEW."signatureRef", ':') + 1);
 IF kind IS NULL OR NOT pharmacy_has_solo_audit(NEW."organizationId", NEW."branchId", NEW."recordedByUserId", kind, target)
 THEN RAISE EXCEPTION 'controlled self witness requires solo owner PIN audit' USING ERRCODE='23514'; END IF;
 IF (NEW."entryKind" = 'PURCHASE' AND kind <> 'ControlledPurchase') OR
    (NEW."entryKind" = 'SALE' AND kind <> 'ControlledSale') OR
    (NEW."entryKind" = 'CORRECTION' AND kind NOT IN ('ControlledRestoration','ControlledCorrection'))
 THEN RAISE EXCEPTION 'solo witness audit does not match register operation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_controlled_solo_witness BEFORE INSERT ON pharmacy_controlled_register_entries
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_controlled_self_witness();

CREATE FUNCTION pharmacy_guard_inventory_solo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text; maker text; branch text; kind text; target text;
BEGIN
 IF TG_TABLE_NAME = 'pharmacy_inventory_counts' THEN
   IF NEW.status <> 'APPROVED' THEN RETURN NEW; END IF;
   IF TG_OP = 'UPDATE' AND
      (NEW.status, NEW."createdById", NEW."approvedById", NEW."approvedAt", NEW."branchId", NEW."organizationId", NEW.id, NEW."varianceThreshold")
      IS NOT DISTINCT FROM
      (OLD.status, OLD."createdById", OLD."approvedById", OLD."approvedAt", OLD."branchId", OLD."organizationId", OLD.id, OLD."varianceThreshold")
   THEN RETURN NEW; END IF;
   -- Below-threshold counts never required a second person.
   IF NOT EXISTS (SELECT 1 FROM pharmacy_inventory_count_lines l WHERE l."organizationId"=NEW."organizationId" AND l."countId"=NEW.id AND abs(l."varianceUnits")>NEW."varianceThreshold") THEN RETURN NEW; END IF;
   actor := NEW."approvedById"; maker := NEW."createdById"; branch := NEW."branchId";
   kind := 'PharmacyInventoryCount'; target := NEW.id;
 ELSIF TG_TABLE_NAME = 'pharmacy_interbranch_transfers' THEN
   IF NEW."approvedById" IS NULL THEN RETURN NEW; END IF;
   IF TG_OP = 'UPDATE' AND
      (NEW."approvedById", NEW."allocatedById", NEW."fromBranchId", NEW."organizationId", NEW.id)
      IS NOT DISTINCT FROM
      (OLD."approvedById", OLD."allocatedById", OLD."fromBranchId", OLD."organizationId", OLD.id)
   THEN RETURN NEW; END IF;
   actor := NEW."approvedById"; maker := NEW."allocatedById"; branch := NEW."fromBranchId";
   kind := 'PharmacyTransfer'; target := NEW.id;
 ELSE
   actor := NEW."actorId"; maker := NEW."witnessId"; branch := NEW."branchId";
   kind := 'PharmacyCustodyRecord'; target := NEW.id;
 END IF;
 IF actor = maker AND NOT pharmacy_has_solo_audit(NEW."organizationId", branch, actor, kind, target)
 THEN RAISE EXCEPTION 'inventory self approval requires solo owner PIN audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_count_solo BEFORE INSERT OR UPDATE ON pharmacy_inventory_counts
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_inventory_solo();
CREATE TRIGGER pharmacy_transfer_solo BEFORE INSERT OR UPDATE ON pharmacy_interbranch_transfers
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_inventory_solo();
CREATE TRIGGER pharmacy_custody_solo BEFORE INSERT ON pharmacy_custody_records
 FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_inventory_solo();

CREATE OR REPLACE FUNCTION pharmacy_rx_reject_review_self_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE requester text; branch text; sale text;
BEGIN
 SELECT r."requestedByUserId", l."branchId", l."saleId" INTO requester, branch, sale
 FROM pharmacy_pharmacist_review_items r LEFT JOIN pharmacy_sale_lines l ON l.id=r."saleLineId" AND l."organizationId"=r."organizationId"
 WHERE r."organizationId"=NEW."organizationId" AND r.id=NEW."reviewItemId";
 IF NEW."actorUserId"=requester AND NOT (
   pharmacy_has_solo_audit(NEW."organizationId", branch, NEW."actorUserId", 'PharmacyReviewItem', NEW."reviewItemId") OR
   pharmacy_has_solo_audit(NEW."organizationId", branch, NEW."actorUserId", 'ControlledSale', sale))
 THEN RAISE EXCEPTION 'requesting cashier cannot approve pharmacist-required line without solo owner PIN audit' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
