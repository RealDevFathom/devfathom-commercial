CREATE TABLE "pharmacy_marketing_safety_states" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "senderId" TEXT NOT NULL,
  "quality" TEXT NOT NULL,
  "paused" BOOLEAN NOT NULL,
  "reason" TEXT,
  "eventKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("organizationId", "senderId"),
  UNIQUE ("organizationId", "eventKey")
);

ALTER TABLE "pharmacy_marketing_safety_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_marketing_safety_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_marketing_safety_states"
  USING ((current_setting('app.is_platform_admin', true) = 'true') OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ((current_setting('app.is_platform_admin', true) = 'true') OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
