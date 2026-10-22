CREATE TABLE "ai_budget_alerts" (
  "id" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "monthStart" TIMESTAMP(3) NOT NULL,
  "organizationId" TEXT,
  "spendUsd" DECIMAL(18,8) NOT NULL,
  "budgetUsd" DECIMAL(12,4) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_budget_alerts_event_ck" CHECK ("event" IN ('EIGHTY_PERCENT', 'BEDROCK_SWITCH')),
  CONSTRAINT "ai_budget_alerts_amounts_ck" CHECK ("spendUsd" >= 0 AND "budgetUsd" >= 0)
);
CREATE UNIQUE INDEX "ai_budget_alerts_event_month_key" ON "ai_budget_alerts"("event", "monthStart");

CREATE TABLE "platform_notifications" (
  "id" TEXT NOT NULL,
  "platformUserId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "entityId" TEXT,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_notifications_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_notifications_user_read_idx" ON "platform_notifications"("platformUserId", "isRead", "createdAt");

ALTER TABLE "ai_budget_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_alerts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_budget_alerts_platform_only" ON "ai_budget_alerts"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
ALTER TABLE "platform_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_notifications_platform_only" ON "platform_notifications"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
REVOKE ALL ON "ai_budget_alerts", "platform_notifications" FROM PUBLIC;
