-- Allocations inherit their branch from the debit note's composite tenant key.
CREATE OR REPLACE FUNCTION pharmacy_guard_solo_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE maker text; branch text;
BEGIN
 SELECT r."submittedByUserId", n."branchId" INTO maker, branch FROM pharmacy_debit_notes n
 JOIN pharmacy_purchase_returns r ON r.id=n."purchaseReturnId" AND r."organizationId"=n."organizationId"
 WHERE n.id=NEW."debitNoteId" AND n."organizationId"=NEW."organizationId";
 IF maker=NEW."allocatedByUserId" AND NOT pharmacy_has_solo_audit(NEW."organizationId", branch, maker, 'PharmacySupplierCreditAllocation', NEW.id)
 THEN RAISE EXCEPTION 'settlement self approval requires solo owner PIN audit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
