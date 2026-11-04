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
-- each effective change bumps the version by one, and turning the checks off needs the
-- recorded warning acknowledgement. A write that does not change the value cannot
-- rewrite either column. An effective change must name the session's own user
-- (app.current_user_id) as the actor. That user must be ACTIVE in this organization,
-- be its genuine owner (system `owner` role) or a tenant ADMIN by stored user role,
-- hold the pharmacy settings capability (`*`, `pharmacy:*` or `pharmacy:manage` ALLOW,
-- from the role or a live override), and carry no matching DENY from either: an
-- explicit DENY wins. The application decides this first through central ABAC; the
-- database refuses any other writer too. Versions continue from the audit trail, so
-- recreating the row never reuses a version that evidence already cites.
CREATE FUNCTION pharmacy_owner_policy_supplier_compliance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed boolean;
  actor text;
  last_version integer := 0;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A missing row already means ON, so only an inserted OFF is a change.
    changed := NEW."supplierComplianceChecksEnabled" IS DISTINCT FROM true;
  ELSE
    changed := NEW."supplierComplianceChecksEnabled"
      IS DISTINCT FROM OLD."supplierComplianceChecksEnabled";
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX("policyVersion"), 0) INTO last_version
      FROM "pharmacy_owner_policy_audit"
     WHERE "organizationId" = NEW."organizationId"
       AND "setting" = 'supplierComplianceChecksEnabled';
  END IF;

  IF NOT changed THEN
    IF TG_OP = 'INSERT' THEN
      NEW."supplierCompliancePolicyVersion" := last_version;
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

  actor := NULLIF(current_setting('app.current_user_id', true), '');
  IF actor IS NULL OR NEW."updatedByUserId" IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'SUPPLIER_COMPLIANCE_POLICY_ACTOR_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM "users" u
      LEFT JOIN "organization_roles" r
        ON r."id" = u."organizationRoleId" AND r."organizationId" = u."organizationId"
     WHERE u."id" = actor
       AND u."organizationId" = NEW."organizationId"
       AND u."status" = 'ACTIVE'
       AND ((r."isSystem" AND r."key" = 'owner') OR u."role" = 'ADMIN')
       AND (
         EXISTS (
           SELECT 1 FROM "organization_role_permissions" p
            WHERE p."organizationRoleId" = u."organizationRoleId" AND p."effect" = 'ALLOW'
              AND p."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage')
         )
         OR EXISTS (
           SELECT 1 FROM "user_permission_overrides" o
            WHERE o."userId" = u."id" AND o."effect" = 'ALLOW'
              AND o."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage')
              AND (o."expiresAt" IS NULL OR o."expiresAt" > CURRENT_TIMESTAMP)
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM "organization_role_permissions" p
          WHERE p."organizationRoleId" = u."organizationRoleId" AND p."effect" = 'DENY'
            AND p."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage')
       )
       AND NOT EXISTS (
         SELECT 1 FROM "user_permission_overrides" o
          WHERE o."userId" = u."id" AND o."effect" = 'DENY'
            AND o."capability" IN ('*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:procurement')
            AND (o."expiresAt" IS NULL OR o."expiresAt" > CURRENT_TIMESTAMP)
       )
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_COMPLIANCE_POLICY_AUTHORITY_REQUIRED' USING ERRCODE = '42501';
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
    CASE WHEN TG_OP = 'INSERT' THEN last_version ELSE OLD."supplierCompliancePolicyVersion" END + 1;
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

-- Append-only for the life of the tenant, destroyed only with it: the sanctioned purge
-- of this row's own tenant (platform admin naming it in app.purging_organization_id),
-- or the declared ON DELETE CASCADE once the organization row is gone. Same rule as
-- 20261021104500_purge_guards_require_platform_admin. UPDATE is always refused.
CREATE FUNCTION pharmacy_append_only_unless_tenant_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TRIGGER pharmacy_supplier_compliance_skips_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_supplier_compliance_skips"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_append_only_unless_tenant_purge();

-- This feature is what first fills the #518 audit, so it gets the same purge-aware
-- guard (UPDATE still refused; DELETE only with its tenant), and the policy row itself
-- can no longer be deleted outside that path: deleting it would silently restore the
-- default without an audit row.
DROP TRIGGER pharmacy_owner_policy_audit_append_only ON "pharmacy_owner_policy_audit";
CREATE TRIGGER pharmacy_owner_policy_audit_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_owner_policy_audit"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_append_only_unless_tenant_purge();

CREATE FUNCTION pharmacy_owner_policy_delete_only_with_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pharmacy owner policies are removed only with their organization'
    USING ERRCODE = '55000';
END $$;
CREATE TRIGGER pharmacy_owner_policies_delete_only_with_tenant
  BEFORE DELETE ON "pharmacy_owner_policies"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_owner_policy_delete_only_with_tenant();

-- DEV-466: a licence filing may only supersede a filing of the same supplier. Strict
-- supersession is read across the register, so a cross-supplier link would otherwise let
-- a filing on one supplier silently void another supplier's licence.
CREATE FUNCTION pharmacy_supplier_licence_same_supplier_supersession() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."supersedesId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "pharmacy_supplier_licences"
     WHERE "organizationId" = NEW."organizationId"
       AND "id" = NEW."supersedesId"
       AND "supplierId" = NEW."supplierId"
  ) THEN
    RAISE EXCEPTION 'SUPPLIER_LICENCE_SUPERSESSION_CROSS_SUPPLIER' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_supplier_licence_same_supplier_supersession
  BEFORE INSERT ON "pharmacy_supplier_licences"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_licence_same_supplier_supersession();

ALTER TABLE "pharmacy_supplier_compliance_skips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_supplier_compliance_skips" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_supplier_compliance_skips"
  USING (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

-- PUR-01's database backstops (20260902131500 purchase orders, 20260902150000 goods
-- receipts) enforced supplier authorization and licence on every write and never read
-- the owner policy, so the switch could not take effect. They now consult it:
-- a stored OFF lets the write through on those two facts; anything else (no row, ON,
-- unreadable) enforces, and enforces strictly: the licence must also be unsuperseded
-- (DEV-466), matching the application gate. A supplier from another tenant is refused
-- either way. The controlled-medicine exception (a pending product decision) lives in
-- the application gate only; these backstops stay a plain reading of the owner policy.
CREATE FUNCTION pharmacy_supplier_checks_enforced(p_organization_id text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE enabled boolean;
BEGIN
  SELECT "supplierComplianceChecksEnabled" INTO enabled
    FROM "pharmacy_owner_policies"
   WHERE "organizationId" = p_organization_id;
  RETURN enabled IS DISTINCT FROM false;
END $$;

CREATE FUNCTION pharmacy_supplier_has_current_licence(p_organization_id text, p_supplier_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pharmacy_supplier_licences" l
     WHERE l."organizationId" = p_organization_id AND l."supplierId" = p_supplier_id
       AND l."verifiedAt" IS NOT NULL AND l."expiresAt" >= CURRENT_TIMESTAMP
       AND NOT EXISTS (
         SELECT 1 FROM "pharmacy_supplier_licences" s
          WHERE s."organizationId" = l."organizationId" AND s."supersedesId" = l."id"
       )
  )
$$;

CREATE OR REPLACE FUNCTION pharmacy_assert_supplier_orderable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_authorized boolean;
BEGIN
  IF NEW."status" = 'CANCELLED' THEN RETURN NEW; END IF;
  -- Scoped by tenant, so a supplier id borrowed from another tenant reads as
  -- absent here and is refused before the composite foreign key is even checked.
  SELECT "authorized" INTO supplier_authorized
  FROM "pharmacy_suppliers"
  WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."supplierId";
  IF supplier_authorized IS NULL THEN
    RAISE EXCEPTION 'supplier does not belong to this pharmacy' USING ERRCODE = '23514';
  END IF;
  IF NOT pharmacy_supplier_checks_enforced(NEW."organizationId") THEN RETURN NEW; END IF;
  IF supplier_authorized IS NOT TRUE THEN
    RAISE EXCEPTION 'supplier is not authorized to supply this pharmacy' USING ERRCODE = '23514';
  END IF;
  IF NOT pharmacy_supplier_has_current_licence(NEW."organizationId", NEW."supplierId") THEN
    RAISE EXCEPTION 'supplier has no unexpired verified licence on file' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION pharmacy_assert_goods_receipt_postable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE supplier_authorized boolean; order_status "PharmacyPurchaseOrderStatus"; line_count integer;
BEGIN
  IF NEW."status" <> 'POSTED' THEN RETURN NEW; END IF;

  SELECT "authorized" INTO supplier_authorized FROM "pharmacy_suppliers"
   WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."supplierId";
  IF supplier_authorized IS NULL THEN
    RAISE EXCEPTION 'supplier does not belong to this pharmacy' USING ERRCODE = '23514';
  END IF;
  IF pharmacy_supplier_checks_enforced(NEW."organizationId") THEN
    IF supplier_authorized IS NOT TRUE THEN
      RAISE EXCEPTION 'supplier is not authorized to supply this pharmacy' USING ERRCODE = '23514';
    END IF;
    IF NOT pharmacy_supplier_has_current_licence(NEW."organizationId", NEW."supplierId") THEN
      RAISE EXCEPTION 'supplier has no unexpired verified licence on file' USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT count(*)::int INTO line_count FROM "pharmacy_goods_receipt_lines"
   WHERE "organizationId" = NEW."organizationId" AND "goodsReceiptId" = NEW."id";
  IF line_count = 0 THEN
    RAISE EXCEPTION 'a goods receipt cannot be posted with no lines' USING ERRCODE = '23514';
  END IF;

  -- Goods can only be received against an order that has actually been sent.
  IF NEW."purchaseOrderId" IS NOT NULL THEN
    SELECT "status" INTO order_status FROM "pharmacy_purchase_orders"
     WHERE "organizationId" = NEW."organizationId" AND "id" = NEW."purchaseOrderId";
    IF order_status NOT IN ('SENT','RECEIVING') THEN
      RAISE EXCEPTION 'a goods receipt can only be posted against a sent purchase order' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
