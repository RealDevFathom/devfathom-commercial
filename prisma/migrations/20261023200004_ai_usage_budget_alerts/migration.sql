-- Piece 4: concurrency-safe monthly AI budget alerts for platform operators.
CREATE TABLE "ai_budget_alert_months" (
  "month" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_budget_alert_months_pkey" PRIMARY KEY ("month"),
  CONSTRAINT "ai_budget_alert_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE TABLE "platform_notifications" (
  "id" TEXT NOT NULL,
  "platformUserId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_notifications_user_fkey" FOREIGN KEY ("platformUserId") REFERENCES "platform_users"("id") ON DELETE CASCADE
);
CREATE INDEX "platform_notifications_user_unread_idx" ON "platform_notifications"("platformUserId", "isRead", "createdAt" DESC);

ALTER TABLE "ai_budget_alert_months" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_budget_alert_months" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ai_budget_alert_months_platform_only" ON "ai_budget_alert_months"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
ALTER TABLE "platform_notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_notifications" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_notifications_platform_only" ON "platform_notifications"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
REVOKE ALL ON "ai_budget_alert_months", "platform_notifications" FROM PUBLIC;
