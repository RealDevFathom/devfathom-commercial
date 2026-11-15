-- DEV-74: owner-editable per-branch seasonal calendar feeding demand forecasting.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_seasonal_windows" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_seasonal_windows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_seasonal_windows_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_seasonal_windows_kind_check" CHECK ("kind" IN ('DENGUE', 'FLU', 'RAMADAN', 'MONSOON', 'CUSTOM')),
  CONSTRAINT "pharmacy_seasonal_windows_label_check" CHECK (length(btrim("label")) BETWEEN 1 AND 80),
  CONSTRAINT "pharmacy_seasonal_windows_span_check" CHECK ("endDate" > "startDate" AND "endDate" - "startDate" <= 366)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_seasonal_windows_org_id_key" ON "pharmacy_seasonal_windows"("organizationId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_seasonal_windows_org_branch_start_idx" ON "pharmacy_seasonal_windows"("organizationId", "branchId", "startDate");

ALTER TABLE "pharmacy_seasonal_windows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_seasonal_windows" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_seasonal_windows";
CREATE POLICY tenant_branch_isolation ON "pharmacy_seasonal_windows"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR (
      "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
      AND (
        NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
        OR "branchId" = current_setting('app.current_branch_id', true)
      )
    )
  );

COMMIT;
