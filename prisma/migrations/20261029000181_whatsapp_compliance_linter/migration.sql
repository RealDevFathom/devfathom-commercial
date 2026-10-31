CREATE TABLE "pharmacy_whatsapp_compliance_logs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "actorId" TEXT,
  "subject" TEXT NOT NULL,
  "intent" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "reasons" JSONB NOT NULL,
  "linterVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_whatsapp_compliance_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_wa_compliance_outcome_check" CHECK ("outcome" IN ('BLOCK', 'WARN', 'PASS')),
  CONSTRAINT "pharmacy_wa_compliance_intent_check" CHECK ("intent" IN ('UTILITY', 'MARKETING')),
  CONSTRAINT "pharmacy_wa_compliance_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_wa_compliance_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT
);

CREATE INDEX "pharmacy_wa_compliance_scope_idx" ON "pharmacy_whatsapp_compliance_logs"("organizationId", "branchId", "createdAt" DESC);

ALTER TABLE "pharmacy_whatsapp_compliance_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_whatsapp_compliance_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_wa_compliance_tenant_isolation" ON "pharmacy_whatsapp_compliance_logs"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

CREATE FUNCTION reject_pharmacy_wa_compliance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'WhatsApp compliance logs are append-only'; END $$;
CREATE TRIGGER "pharmacy_wa_compliance_no_update_delete"
  BEFORE UPDATE OR DELETE ON "pharmacy_whatsapp_compliance_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_pharmacy_wa_compliance_mutation();
