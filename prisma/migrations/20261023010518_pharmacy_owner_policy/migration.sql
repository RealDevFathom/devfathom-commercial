-- #518 / feat/pharmacy-owner-policy: owner policy switches for a pharmacy organization.
-- allowCashierRxSale lets staff without pharmacy:dispense sell Rx/restricted non-controlled
-- lines. It defaults to OFF; a missing row means OFF. Every change writes an audit row.
CREATE TABLE "pharmacy_owner_policies" (
  "organizationId" TEXT PRIMARY KEY DEFAULT current_setting('app.current_organization_id', true)
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "allowCashierRxSale" BOOLEAN NOT NULL DEFAULT false,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "pharmacy_owner_policy_audit" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true)
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "setting" TEXT NOT NULL,
  "oldValue" BOOLEAN,
  "newValue" BOOLEAN NOT NULL,
  "actorUserId" TEXT,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pharmacy_owner_policy_audit_org_idx" ON "pharmacy_owner_policy_audit"("organizationId", "changedAt");

CREATE FUNCTION pharmacy_owner_policy_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_owner_policy_audit_change AFTER INSERT OR UPDATE ON "pharmacy_owner_policies"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_owner_policy_audit_change();
CREATE TRIGGER pharmacy_owner_policy_audit_append_only BEFORE UPDATE OR DELETE ON "pharmacy_owner_policy_audit"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_owner_policies','pharmacy_owner_policy_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))', t);
  END LOOP;
END $$;
