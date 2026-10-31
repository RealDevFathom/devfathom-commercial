CREATE TABLE "ai_usage" (
  "id" UUID NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usage_organizationId_fkey" FOREIGN KEY ("organizationId")
    REFERENCES "organizations" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_organizationId_branchId_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ai_usage_organizationId_createdAt_idx" ON "ai_usage" ("organizationId", "createdAt");
CREATE INDEX "ai_usage_organizationId_branchId_createdAt_idx" ON "ai_usage" ("organizationId", "branchId", "createdAt");

ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ai_usage"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
