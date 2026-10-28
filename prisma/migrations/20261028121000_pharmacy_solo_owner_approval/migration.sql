-- Replace unconditional self-approval checks with the same narrow, audited solo-owner
-- exception enforced by the service. Existing distinct-approver workflows remain valid.
CREATE FUNCTION pharmacy_has_solo_owner_approval(org_id text, actor_id text, target_type text, target_id text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organizations WHERE id=org_id FOR UPDATE;
  RETURN (SELECT count(*) FROM users WHERE "organizationId"=org_id AND status IN ('ACTIVE','ON_LEAVE'))=1
    AND EXISTS (SELECT 1 FROM users u LEFT JOIN organization_roles r
      ON r.id=u."organizationRoleId" AND r."organizationId"=u."organizationId"
      WHERE u.id=actor_id AND u."organizationId"=org_id AND u.status IN ('ACTIVE','ON_LEAVE')
        AND (u.role='ADMIN' OR r.key IN ('owner','owner-operator')))
    AND EXISTS (SELECT 1 FROM audit_logs a WHERE a."organizationId"=org_id AND a."actorId"=actor_id
      AND a.action='pharmacy.soloOwnerApproval' AND a."targetType"=target_type AND a."targetId"=target_id
      AND a.metadata->>'policy'='PHARMACY:SOLO_OWNER_PIN' AND a.metadata->>'activeStaff'='1'
      -- A previous approval is historical evidence, never fresh reauthentication.
      AND a.xmin::text::bigint=(txid_current() % 4294967296));
END $$;

CREATE FUNCTION pharmacy_check_business_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id text; maker_id text; target_type text; target_id text;
BEGIN
  IF TG_TABLE_NAME='pharmacy_purchase_orders' THEN
    actor_id:=NEW."approvedByUserId"; maker_id:=NEW."createdByUserId";
    IF actor_id IS DISTINCT FROM maker_id AND EXISTS (SELECT 1 FROM pharmacy_requisitions r
      WHERE r.id=NEW."requisitionId" AND r."organizationId"=NEW."organizationId" AND r."requestedByUserId"=actor_id) THEN
      maker_id:=actor_id;
    END IF;
    target_type:='PharmacyPurchaseOrder'; target_id:=NEW.id;
  ELSIF TG_TABLE_NAME='pharmacy_goods_receipts' THEN
    actor_id:=NEW."bypassApprovedByUserId"; maker_id:=NEW."receivedByUserId";
    target_type:='PharmacyGoodsReceipt'; target_id:=NEW.id;
  ELSE
    actor_id:=NEW."allocatedByUserId";
    SELECT r."submittedByUserId" INTO maker_id FROM pharmacy_debit_notes n JOIN pharmacy_purchase_returns r
      ON r.id=n."purchaseReturnId" AND r."organizationId"=n."organizationId"
      WHERE n.id=NEW."debitNoteId" AND n."organizationId"=NEW."organizationId";
    target_type:='PharmacyDebitNote'; target_id:=NEW."debitNoteId";
  END IF;
  IF actor_id IS NOT NULL AND actor_id=maker_id AND
    NOT pharmacy_has_solo_owner_approval(NEW."organizationId",actor_id,target_type,target_id) THEN
    RAISE EXCEPTION 'SELF_APPROVAL' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_po_maker_checker BEFORE INSERT OR UPDATE OF "approvedByUserId" ON pharmacy_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_business_approval();
CREATE TRIGGER pharmacy_receipt_maker_checker BEFORE INSERT OR UPDATE OF "bypassApprovedByUserId" ON pharmacy_goods_receipts
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_business_approval();
CREATE TRIGGER pharmacy_credit_maker_checker BEFORE INSERT ON pharmacy_supplier_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION pharmacy_check_business_approval();
ALTER TABLE pharmacy_purchase_orders DROP CONSTRAINT pharmacy_purchase_orders_check;
ALTER TABLE pharmacy_goods_receipts DROP CONSTRAINT pharmacy_goods_receipts_bypass_actor_check;
