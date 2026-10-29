-- Additive and safe for populated databases: existing branches begin with an empty calendar.
CREATE TABLE "pharmacy_seasonal_calendar_windows" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_seasonal_calendar_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_seasonal_calendar_dates_check" CHECK ("endDate" >= "startDate"),
  CONSTRAINT "pharmacy_seasonal_calendar_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_seasonal_calendar_windows_organizationId_id_key"
  ON "pharmacy_seasonal_calendar_windows" ("organizationId", "id");
CREATE INDEX "pharmacy_seasonal_calendar_windows_organizationId_branchId_startDate_endDate_idx"
  ON "pharmacy_seasonal_calendar_windows" ("organizationId", "branchId", "startDate", "endDate");

ALTER TABLE "pharmacy_seasonal_calendar_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_seasonal_calendar_windows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_seasonal_calendar_windows"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
