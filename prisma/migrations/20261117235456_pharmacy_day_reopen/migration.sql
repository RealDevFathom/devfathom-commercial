BEGIN;

-- DEV-631: an owner or manager can reopen a closed business day for trading, with a reason.
-- The close rows stay append-only; a reopen is its own append-only row naming the
-- close it reopens. The next close of the day supersedes it.
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_daily_closes_reopen_anchor_key"
  ON "pharmacy_daily_closes"("organizationId", "branchId", "businessDate", "id");

CREATE TABLE IF NOT EXISTS "pharmacy_day_reopens" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "businessDate" DATE NOT NULL,
  "closeId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_day_reopens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_day_reopens_close_fkey" FOREIGN KEY ("organizationId", "branchId", "businessDate", "closeId") REFERENCES "pharmacy_daily_closes"("organizationId", "branchId", "businessDate", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_day_reopens_visibility_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "pharmacy_day_reopens_reason_check" CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_day_reopens_organizationId_id_key" ON "pharmacy_day_reopens"("organizationId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_day_reopens_organizationId_closeId_key" ON "pharmacy_day_reopens"("organizationId", "closeId");
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_day_reopens_close_scope_key" ON "pharmacy_day_reopens"("organizationId", "branchId", "businessDate", "closeId");
CREATE INDEX IF NOT EXISTS "pharmacy_day_reopens_organizationId_branchId_businessDate_idx" ON "pharmacy_day_reopens"("organizationId", "branchId", "businessDate");

DROP TRIGGER IF EXISTS pharmacy_day_reopens_append_only ON "pharmacy_day_reopens";
CREATE TRIGGER pharmacy_day_reopens_append_only
BEFORE UPDATE OR DELETE ON "pharmacy_day_reopens"
FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_money_mutation();

ALTER TABLE "pharmacy_day_reopens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_day_reopens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation ON "pharmacy_day_reopens";
CREATE POLICY tenant_branch_isolation ON "pharmacy_day_reopens"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = current_setting('app.current_branch_id', true))));

COMMIT;
