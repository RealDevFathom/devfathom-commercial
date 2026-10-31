-- Tenant purge must be able to remove WhatsApp compliance evidence, exactly as
-- it removes the other append-only pharmacy history (WHA-1209 and
-- 20261022235900_restore_regulatory_delete_exceptions).
--
-- 1. The retention worker runs as the platform admin with an empty organization
--    setting. Without the platform bypass the purge DELETE sees no rows and the
--    later pharmacy_branches DELETE fails on the RESTRICT foreign key.
ALTER POLICY "pharmacy_wa_compliance_tenant_isolation"
  ON "pharmacy_whatsapp_compliance_logs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true))
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true))
    )
  );

-- 2. Rows stay append-only. UPDATE is always refused; DELETE is allowed only to
--    the platform-admin purge of this exact organization, or once the owning
--    organization row is already gone.
CREATE OR REPLACE FUNCTION reject_pharmacy_wa_compliance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
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
  RAISE EXCEPTION 'WhatsApp compliance logs are append-only' USING ERRCODE = '23514';
END $$;
