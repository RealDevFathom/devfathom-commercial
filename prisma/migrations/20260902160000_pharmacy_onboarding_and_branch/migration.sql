-- PLAT-03 / PLAT-04 — PRD §6.1.
--
-- PLAT-04 introduces "pharmacy_branches", the branch aggregate that every
-- branch-owned pharmacy record has so far referenced only by a bare string. The
-- seam columns left by PLAT-02 (regulatory profiles), PH-INV (stock locations,
-- inventory lots) and PH-PUR (requisitions, purchase orders) become real
-- composite foreign keys, so a branch id borrowed from another tenant fails in
-- the database instead of relying on every router remembering the predicate.
-- "organizationId" remains the tenant boundary under FORCE row-level security;
-- the branch is a scope inside that boundary, never a replacement for it.
--
-- PLAT-03 introduces the twelve onboarding readiness gates. The stored gate row
-- is a claim, not a verdict: `evaluatePharmacyReadiness` recomputes every
-- evidence-backed gate from the underlying data and downgrades any PASSED claim
-- the data does not support, which is what stops seed or bootstrap rows faking
-- readiness. Transitions are an append-only log, enforced by trigger.

-- ---------------------------------------------------------------------------
-- PLAT-04 — the branch aggregate
-- ---------------------------------------------------------------------------

CREATE TABLE "pharmacy_branches" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "code" TEXT NOT NULL CHECK (length(btrim("code")) > 0),
  "name" TEXT NOT NULL CHECK (length(btrim("name")) > 0),
  "addressLine" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "provinceCode" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "defaultStockLocationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "pharmacy_branches_org_id_key" ON "pharmacy_branches"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_branches_org_code_key" ON "pharmacy_branches"("organizationId", "code");
CREATE INDEX "pharmacy_branches_org_active_idx" ON "pharmacy_branches"("organizationId", "active");

-- Forward safety. The seam columns already hold branch identifiers, so adding
-- the foreign keys below would abort on any existing row. Materialise the
-- aggregate for every (organization, branch) pair already in use, keeping the
-- identifier byte-identical so no referencing row is rewritten. On a database
-- where pharmacy has not been used yet this inserts nothing. The branch is
-- created "active" because these branches are already operating; deactivating
-- them here would silently stop a live tenant, and readiness is decided by
-- PLAT-03 evaluation rather than by this column.
INSERT INTO "pharmacy_branches" ("id", "organizationId", "code", "name", "addressLine", "city", "provinceCode", "active", "updatedAt")
SELECT DISTINCT ON ("organizationId", "branchId")
       "branchId", "organizationId", "branchId", "branchId", '', '', '', true, CURRENT_TIMESTAMP
FROM (
  SELECT "organizationId", "branchId" FROM "pharmacy_branch_regulatory_profiles"
  UNION SELECT "organizationId", "branchId" FROM "pharmacy_stock_locations"
  UNION SELECT "organizationId", "branchId" FROM "pharmacy_inventory_lots"
  UNION SELECT "organizationId", "branchId" FROM "pharmacy_requisitions" WHERE "branchId" IS NOT NULL
  UNION SELECT "organizationId", "branchId" FROM "pharmacy_purchase_orders" WHERE "branchId" IS NOT NULL
) AS seam
WHERE length(btrim("branchId")) > 0
ON CONFLICT ("id") DO NOTHING;

-- PLAT-02's branchId is now a foreign key onto the aggregate.
ALTER TABLE "pharmacy_branch_regulatory_profiles"
  ADD CONSTRAINT "pharmacy_branch_regulatory_profiles_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;

-- The ledger's branch scope. A stock location is unique within its branch, so a
-- branch's default location can be constrained to that same branch below.
CREATE UNIQUE INDEX "pharmacy_stock_locations_org_branch_id_key" ON "pharmacy_stock_locations"("organizationId", "branchId", "id");
ALTER TABLE "pharmacy_stock_locations"
  ADD CONSTRAINT "pharmacy_stock_locations_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_inventory_lots"
  ADD CONSTRAINT "pharmacy_inventory_lots_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;

-- A branch's default location must be a location of that same branch, not merely
-- of the same tenant.
ALTER TABLE "pharmacy_branches"
  ADD CONSTRAINT "pharmacy_branches_default_location_fkey"
  FOREIGN KEY ("organizationId", "id", "defaultStockLocationId")
  REFERENCES "pharmacy_stock_locations"("organizationId", "branchId", "id") ON DELETE RESTRICT;

-- Purchasing's branch scope. Nullable: an organization-wide requisition or
-- purchase order is legitimate, a cross-tenant branch id is not.
ALTER TABLE "pharmacy_requisitions"
  ADD CONSTRAINT "pharmacy_requisitions_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_purchase_orders"
  ADD CONSTRAINT "pharmacy_purchase_orders_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT;
CREATE INDEX "pharmacy_requisitions_org_branch_status_idx" ON "pharmacy_requisitions"("organizationId", "branchId", "status");
CREATE INDEX "pharmacy_purchase_orders_org_branch_status_idx" ON "pharmacy_purchase_orders"("organizationId", "branchId", "status");

-- ---------------------------------------------------------------------------
-- PLAT-03 — the twelve onboarding readiness gates
-- ---------------------------------------------------------------------------

CREATE TYPE "PharmacyOnboardingGate" AS ENUM (
  'ORG_TYPE','LEGAL_BUSINESS','LAUNCH_JURISDICTION','PREMISES_AND_LICENCES',
  'BRANCHES_AND_LOCATIONS','COMMERCIAL_PACKAGE','OWNER_AND_ROLE_TEMPLATES',
  'MEDICINE_CATALOG_READINESS','OPENING_STOCK_READINESS','PARTIES_AND_BALANCES',
  'DEVICES_AND_DOCUMENTS','READINESS_AND_PARALLEL_RUN'
);
CREATE TYPE "PharmacyOnboardingGateStatus" AS ENUM ('NOT_STARTED','IN_PROGRESS','PASSED','FAILED');

CREATE TABLE "pharmacy_onboarding_states" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL UNIQUE DEFAULT current_setting('app.current_organization_id', true),
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

CREATE TABLE "pharmacy_onboarding_gate_states" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "gate" "PharmacyOnboardingGate" NOT NULL,
  "status" "PharmacyOnboardingGateStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "evidenceRef" TEXT,
  "branchId" TEXT,
  "actorId" TEXT,
  "recordedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  -- A gate that is not NOT_STARTED was moved by somebody, at some time. This is
  -- the table half of "seed data cannot fake readiness": a bare status column
  -- flipped to PASSED without an actor and a timestamp is rejected outright.
  CHECK ("status" = 'NOT_STARTED' OR ("actorId" IS NOT NULL AND "recordedAt" IS NOT NULL)),
  FOREIGN KEY ("organizationId") REFERENCES "pharmacy_onboarding_states"("organizationId") ON DELETE CASCADE,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "pharmacy_onboarding_gate_states_org_gate_key" ON "pharmacy_onboarding_gate_states"("organizationId", "gate");
CREATE INDEX "pharmacy_onboarding_gate_states_org_status_idx" ON "pharmacy_onboarding_gate_states"("organizationId", "status");

CREATE TABLE "pharmacy_onboarding_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "gate" "PharmacyOnboardingGate" NOT NULL,
  "fromStatus" "PharmacyOnboardingGateStatus",
  "toStatus" "PharmacyOnboardingGateStatus" NOT NULL,
  "evidenceRef" TEXT,
  "actorId" TEXT NOT NULL CHECK (length(btrim("actorId")) > 0),
  "note" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId") REFERENCES "pharmacy_onboarding_states"("organizationId") ON DELETE CASCADE
);
CREATE INDEX "pharmacy_onboarding_events_org_gate_occurred_idx" ON "pharmacy_onboarding_events"("organizationId", "gate", "occurredAt");

-- The onboarding history is evidence for a regulated activation decision, so it
-- is append-only at the table and not merely by convention.
CREATE FUNCTION pharmacy_assert_onboarding_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy onboarding events are append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER pharmacy_onboarding_events_append_only
BEFORE UPDATE OR DELETE ON "pharmacy_onboarding_events"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_onboarding_event_append_only();

-- NFR-03: tenant RLS on every new table from its creating migration, FORCED so
-- that the owning role is subject to it too.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['pharmacy_branches','pharmacy_onboarding_states','pharmacy_onboarding_gate_states','pharmacy_onboarding_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
