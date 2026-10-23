CREATE TABLE "pharmacy_marketing_ai_generations" (
  "id" UUID NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "body" TEXT,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_marketing_ai_generations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_marketing_ai_generations_status_check" CHECK ("status" IN ('PENDING', 'COMPLETE')),
  CONSTRAINT "pharmacy_marketing_ai_generations_tokens_check" CHECK (
    ("status" = 'PENDING' AND "body" IS NULL AND "inputTokens" IS NULL AND "outputTokens" IS NULL AND "totalTokens" IS NULL)
    OR ("status" = 'COMPLETE' AND "body" IS NOT NULL AND "inputTokens" >= 0 AND "outputTokens" >= 0 AND "totalTokens" >= 0)
  ),
  CONSTRAINT "pharmacy_marketing_ai_generations_org_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_marketing_ai_generations_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX CONCURRENTLY "pharmacy_marketing_ai_generations_idempotency_key" ON "pharmacy_marketing_ai_generations"("organizationId", "branchId", "idempotencyKey");
CREATE UNIQUE INDEX CONCURRENTLY "pharmacy_marketing_ai_generations_org_id_key" ON "pharmacy_marketing_ai_generations"("organizationId", "id");
CREATE INDEX CONCURRENTLY "pharmacy_marketing_ai_generations_pending_idx" ON "pharmacy_marketing_ai_generations"("organizationId", "branchId", "status");

CREATE TABLE "pharmacy_marketing_ai_usage" (
  "id" UUID NOT NULL,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "generationId" UUID NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "totalTokens" INTEGER NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_marketing_ai_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_marketing_ai_usage_tokens_check" CHECK ("inputTokens" >= 0 AND "outputTokens" >= 0 AND "totalTokens" >= 0),
  CONSTRAINT "pharmacy_marketing_ai_usage_generation_fkey" FOREIGN KEY ("organizationId", "generationId") REFERENCES "pharmacy_marketing_ai_generations"("organizationId", "id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_marketing_ai_usage_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX CONCURRENTLY "pharmacy_marketing_ai_usage_generation_key" ON "pharmacy_marketing_ai_usage"("organizationId", "generationId");
CREATE INDEX CONCURRENTLY "pharmacy_marketing_ai_usage_history_idx" ON "pharmacy_marketing_ai_usage"("organizationId", "branchId", "recordedAt");

ALTER TABLE "pharmacy_marketing_ai_generations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_marketing_ai_usage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_marketing_ai_generations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_marketing_ai_usage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_marketing_ai_generations"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true)));
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_marketing_ai_usage"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true)));
