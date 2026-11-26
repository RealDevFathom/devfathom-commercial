BEGIN;
SET LOCAL lock_timeout = '5s';

-- The owner ID is the purchaseOrderId reached through the document's
-- append-only submission and its issuing link, including for existing files.
ALTER TABLE pharmacy_supplier_documents ADD COLUMN "ownerType" TEXT
  NOT NULL DEFAULT 'PHARMACY_PURCHASE_ORDER'
  CHECK ("ownerType" = 'PHARMACY_PURCHASE_ORDER');

CREATE FUNCTION pharmacy_supplier_keep_link_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."organizationId", OLD."branchId", OLD."supplierRelationshipId", OLD."purchaseOrderId")
     IS DISTINCT FROM
     (NEW."organizationId", NEW."branchId", NEW."supplierRelationshipId", NEW."purchaseOrderId") THEN
    RAISE EXCEPTION 'The owner of a supplier order link is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_supplier_link_owner BEFORE UPDATE ON pharmacy_supplier_action_links
  FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_keep_link_owner();
COMMIT;
