-- No tenant FK: consent evidence survives tenant purge. tenantId deliberately
-- differs from organizationId so the generic tenant purge cannot erase proof.
CREATE TABLE growth_wa_consent_retention (
  "tenantId" text NOT NULL,
  "evidenceKind" text NOT NULL,
  "sourceId" text NOT NULL,
  evidence jsonb NOT NULL,
  "retainedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenantId", "evidenceKind", "sourceId")
);
ALTER TABLE growth_wa_consent_retention ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_wa_consent_retention FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON growth_wa_consent_retention
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "tenantId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "tenantId" = NULLIF(current_setting('app.current_organization_id', true), ''));
