-- DEV-753: owner switch for supplier compliance checks.
--
-- Reuses the #518 owner-policy storage (20261023010518_pharmacy_owner_policy): one
-- "pharmacy_owner_policies" row per organization, FORCE RLS, and the append-only
-- "pharmacy_owner_policy_audit" written by trigger whoever writes the row.
--
-- "supplierComplianceChecksEnabled" defaults to ON, and a missing row means ON, so the
-- PUR-01 supplier licence and supplier trade-authorization checks are unchanged until a
-- verified tenant owner turns them off. The switch changes software enforcement only. It
-- never changes supplier rows, licence evidence or anyone's capabilities.
--
-- The allowCashierRxSale branch of the audit trigger is kept byte-for-byte as #518 wrote
-- it; only the supplier branch is new.

ALTER TABLE "pharmacy_owner_policies"
  ADD COLUMN "supplierComplianceChecksEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "supplierCompliancePolicyVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "supplierComplianceAcknowledgement" TEXT;

ALTER TABLE "pharmacy_owner_policy_audit"
  ADD COLUMN "policyVersion" INTEGER,
  ADD COLUMN "acknowledgement" TEXT;

-- The version and acknowledgement move only with the value, whoever writes the row:
-- each effective change bumps the version by one, needs a named actor, and turning the
-- checks off needs the recorded warning acknowledgement. A write that does not change
-- the value cannot rewrite either column.
CREATE FUNCTION pharmacy_owner_policy_supplier_compliance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed boolean;
  actor text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A missing row already means ON, so only an inserted OFF is a change.
    changed := NEW."supplierComplianceChecksEnabled" IS DISTINCT FROM true;
  ELSE
    changed := NEW."supplierComplianceChecksEnabled"
      IS DISTINCT FROM OLD."supplierComplianceChecksEnabled";
  END IF;

  IF NOT changed THEN
    IF TG_OP = 'INSERT' THEN
      NEW."supplierCompliancePolicyVersion" := 0;
      NEW."supplierComplianceAcknowledgement" := NULL;
    ELSE
      NEW."supplierCompliancePolicyVersion" := OLD."supplierCompliancePolicyVersion";
      NEW."supplierComplianceAcknowledgement" := OLD."supplierComplianceAcknowledgement";
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."supplierComplianceChecksEnabled" IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_COMPLIANCE_POLICY_INVALID' USING ERRCODE = '23514';
  END IF;

  actor := COALESCE(NEW."updatedByUserId", NULLIF(current_setting('app.current_user_id', true), ''));
  IF actor IS NULL THEN
    RAISE EXCEPTION 'SUPPLIER_COMPLIANCE_POLICY_ACTOR_REQUIRED' USING ERRCODE = '23514';
  END IF;

  IF NEW."supplierComplianceChecksEnabled" = false THEN
    IF NEW."supplierComplianceAcknowledgement" IS NULL
       OR btrim(NEW."supplierComplianceAcknowledgement") = '' THEN
      RAISE EXCEPTION 'SUPPLIER_COMPLIANCE_ACKNOWLEDGEMENT_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSE
    NEW."supplierComplianceAcknowledgement" := NULL;
  END IF;

  NEW."supplierCompliancePolicyVersion" :=
    CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE OLD."supplierCompliancePolicyVersion" END + 1;
  NEW."updatedByUserId" := actor;
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_owner_policy_supplier_compliance_guard
  BEFORE INSERT OR UPDATE ON "pharmacy_owner_policies"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_owner_policy_supplier_compliance_guard();

CREATE OR REPLACE FUNCTION pharmacy_owner_policy_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."allowCashierRxSale" IS DISTINCT FROM OLD."allowCashierRxSale" THEN
    INSERT INTO "pharmacy_owner_policy_audit" ("organizationId", "setting", "oldValue", "newValue", "actorUserId")
    VALUES (
      NEW."organizationId",
      'allowCashierRxSale',
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."allowCashierRxSale" END,
      NEW."allowCashierRxSale",
      COALESCE(NEW."updatedByUserId", NULLIF(current_setting('app.current_user_id', true), ''))
    );
  END IF;
  IF (TG_OP = 'INSERT' AND NEW."supplierComplianceChecksEnabled" IS DISTINCT FROM true)
     OR (TG_OP = 'UPDATE' AND NEW."supplierComplianceChecksEnabled"
         IS DISTINCT FROM OLD."supplierComplianceChecksEnabled") THEN
    INSERT INTO "pharmacy_owner_policy_audit"
      ("organizationId", "setting", "oldValue", "newValue", "actorUserId", "policyVersion", "acknowledgement")
    VALUES (
      NEW."organizationId",
      'supplierComplianceChecksEnabled',
      -- The effective old value: a missing row meant ON.
      CASE WHEN TG_OP = 'INSERT' THEN true ELSE OLD."supplierComplianceChecksEnabled" END,
      NEW."supplierComplianceChecksEnabled",
      NEW."updatedByUserId",
      NEW."supplierCompliancePolicyVersion",
      NEW."supplierComplianceAcknowledgement"
    );
  END IF;
  RETURN NEW;
END $$;

-- Immutable per-transaction evidence. One row each time a purchasing or receiving write
-- passed the PUR-01 supplier gate without a check because the owner policy had the
-- supplier checks OFF. The row records the policy version in force and the supplier facts
-- the check would have read, so a later reader can tell "not checked" apart from "checked
-- and passed". Writes made while the checks are ON leave no row: they were checked, or
-- they were refused. On the transactional paths (approval, receipt create and post) the
-- row commits with the write; on purchase-order create and send it is written when the
-- gate is passed, so it can outlive a later, unrelated validation failure of that request.
CREATE TABLE "pharmacy_supplier_compliance_skips" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true)
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "operation" TEXT NOT NULL CHECK ("operation" IN (
    'PURCHASE_ORDER_CREATE',
    'PURCHASE_ORDER_APPROVE',
    'PURCHASE_ORDER_SEND',
    'GOODS_RECEIPT_CREATE',
    'GOODS_RECEIPT_POST',
    'CENTRAL_PURCHASE_ORDER_CREATE'
  )),
  "supplierId" TEXT NOT NULL,
  "purchaseOrderId" TEXT,
  "goodsReceiptId" TEXT,
  "reference" TEXT,
  "policyVersion" INTEGER NOT NULL CHECK ("policyVersion" > 0),
  "supplierAuthorized" BOOLEAN NOT NULL,
  "licenceStatus" TEXT NOT NULL CHECK ("licenceStatus" IN (
    'VALID', 'NONE', 'UNVERIFIED', 'EXPIRED', 'SUPERSEDED'
  )),
  "actorUserId" TEXT NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("purchaseOrderId" IS NOT NULL OR "goodsReceiptId" IS NOT NULL OR "reference" IS NOT NULL)
);
CREATE INDEX "pharmacy_supplier_compliance_skips_org_supplier_idx"
  ON "pharmacy_supplier_compliance_skips"("organizationId", "supplierId", "recordedAt");
CREATE INDEX "pharmacy_supplier_compliance_skips_org_order_idx"
  ON "pharmacy_supplier_compliance_skips"("organizationId", "purchaseOrderId");
CREATE INDEX "pharmacy_supplier_compliance_skips_org_receipt_idx"
  ON "pharmacy_supplier_compliance_skips"("organizationId", "goodsReceiptId");

CREATE TRIGGER pharmacy_supplier_compliance_skips_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_supplier_compliance_skips"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

ALTER TABLE "pharmacy_supplier_compliance_skips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_supplier_compliance_skips" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_supplier_compliance_skips"
  USING (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
