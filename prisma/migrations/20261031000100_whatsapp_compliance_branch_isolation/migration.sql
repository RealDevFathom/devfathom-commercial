-- Match the optional branch boundary used by marketing and refill evidence.
ALTER POLICY "pharmacy_wa_compliance_tenant_isolation"
  ON "pharmacy_whatsapp_compliance_logs"
  USING (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
      OR "branchId" = current_setting('app.current_branch_id', true))
  )
  WITH CHECK (
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
      OR "branchId" = current_setting('app.current_branch_id', true))
  );
