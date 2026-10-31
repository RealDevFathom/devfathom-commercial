ALTER TABLE "pharmacy_branches" ADD COLUMN "lostDemandConfig" JSONB;

CREATE TABLE "pharmacy_demand_visits" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "requestedMedicineId" TEXT,
  "walkedOut" BOOLEAN NOT NULL,
  "capturedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_demand_visits_branch_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_demand_visits_medicine_fkey" FOREIGN KEY ("organizationId", "requestedMedicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_demand_visits_walkout_item" CHECK (NOT "walkedOut" OR "requestedMedicineId" IS NOT NULL)
);
CREATE INDEX "pharmacy_demand_visits_organizationId_branchId_createdAt_idx"
  ON "pharmacy_demand_visits" ("organizationId", "branchId", "createdAt");
ALTER TABLE "pharmacy_demand_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_demand_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_branch_isolation" ON "pharmacy_demand_visits"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
      OR "branchId" = current_setting('app.current_branch_id', true)))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
    AND (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL
      OR "branchId" = current_setting('app.current_branch_id', true)));
-- Visit evidence is append-only; corrections must not silently change the rate history.
CREATE FUNCTION pharmacy_demand_visit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Demand visit evidence is append-only' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER pharmacy_demand_visit_immutable BEFORE UPDATE OR DELETE ON "pharmacy_demand_visits"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_demand_visit_immutable();
