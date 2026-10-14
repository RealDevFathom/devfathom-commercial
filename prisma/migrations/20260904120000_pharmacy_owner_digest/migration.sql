-- WHA-1253 / RPT-03 — opt-in schedule plus persistent CaptureChannel history.
CREATE TABLE "pharmacy_owner_digest_settings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "timeMinutes" INTEGER NOT NULL DEFAULT 480,
  "nextDueAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_owner_digest_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_owner_digest_settings_time_check" CHECK ("timeMinutes" BETWEEN 0 AND 1439),
  CONSTRAINT "pharmacy_owner_digest_settings_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digest_settings_user_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digest_settings_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_owner_digest_settings_org_user_branch_key" ON "pharmacy_owner_digest_settings"("organizationId", "userId", "branchId");
CREATE INDEX "pharmacy_owner_digest_settings_due_idx" ON "pharmacy_owner_digest_settings"("enabled", "nextDueAt");

CREATE TABLE "pharmacy_owner_digest_captures" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "rendered" TEXT NOT NULL,
  "metrics" JSONB NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_owner_digest_captures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_owner_digest_captures_business_date_check" CHECK ("businessDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "pharmacy_owner_digest_captures_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digest_captures_user_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digest_captures_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_owner_digest_captures_daily_key" ON "pharmacy_owner_digest_captures"("organizationId", "userId", "branchId", "businessDate");
CREATE INDEX "pharmacy_owner_digest_captures_history_idx" ON "pharmacy_owner_digest_captures"("organizationId", "userId", "capturedAt" DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_owner_digest_settings','pharmacy_owner_digest_captures'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))', t);
  END LOOP;
END $$;
