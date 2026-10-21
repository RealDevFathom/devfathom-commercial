-- Outbox for notification email and webhook delivery. The row commits with the
-- tenant mutation; SMTP and HTTP run after commit, on a different connection.
CREATE TABLE "outbound_effects" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbound_effects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbound_effects_kind_check" CHECK ("kind" IN ('email', 'webhook')),
  CONSTRAINT "outbound_effects_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  CONSTRAINT "outbound_effects_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "outbound_effects_org_status_idx" ON "outbound_effects"("organizationId", "status", "createdAt");

ALTER TABLE "outbound_effects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_effects" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outbound_effects"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
