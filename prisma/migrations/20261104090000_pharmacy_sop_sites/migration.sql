-- DEV-751: bind pharmacy branches to the shared SOP engine.
--
-- pharmacy_sop_sites       One row per pharmacy branch that a manager explicitly
--                          enabled. It points at one engine branch row in
--                          restaurant_branches, which carries the timezone and
--                          business-day cutoff the recurrence engine needs.
--                          Pharmacy access never reads the engine branch; scope
--                          still comes from pharmacy_branch_assignments.
-- pharmacy_sop_record_links APPEND-ONLY link from an SOP occurrence (and
--                          optionally one step) to an existing pharmacy record.
--                          It never creates, posts or edits that record.
--
-- Additive only: no existing table is altered, nothing is backfilled and no
-- schedule is created. Both tables carry forced RLS with the pharmacy
-- tenant/branch clause (app.current_organization_id, optional
-- app.current_branch_id, and the app.is_platform_admin control-plane escape).
-- Both tables get SELECT + INSERT policies only, the restaurant_sop_evidence
-- append-only pattern, so the runtime role cannot UPDATE or DELETE a link, and
-- cannot re-point a site at another engine branch or remove it. Nothing in the
-- application updates or deletes either table.

CREATE TYPE "PharmacySopRecordType" AS ENUM (
  'TEMPERATURE_LOG',
  'CONTROLLED_REGISTER_ENTRY',
  'GOODS_RECEIPT',
  'MANUFACTURING_BATCH',
  'RECALL_NOTICE'
);

CREATE TABLE "pharmacy_sop_sites" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "pharmacyBranchId" TEXT NOT NULL,
  "sopBranchId" TEXT NOT NULL,
  "enabledByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sop_sites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_sop_sites_organizationId_pharmacyBranchId_fkey"
    FOREIGN KEY ("organizationId", "pharmacyBranchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SQL-only: the engine branch must belong to the same organization.
  CONSTRAINT "pharmacy_sop_sites_sop_branch_fkey"
    FOREIGN KEY ("organizationId", "sopBranchId")
    REFERENCES "restaurant_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_sop_sites_enabled_by_check" CHECK (length(btrim("enabledByUserId")) > 0)
);
CREATE UNIQUE INDEX "pharmacy_sop_sites_org_id_key"
  ON "pharmacy_sop_sites" ("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_sop_sites_org_branch_key"
  ON "pharmacy_sop_sites" ("organizationId", "pharmacyBranchId");
CREATE UNIQUE INDEX "pharmacy_sop_sites_org_sop_branch_key"
  ON "pharmacy_sop_sites" ("organizationId", "sopBranchId");

ALTER TABLE "pharmacy_sop_sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sop_sites" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_sop_sites" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_sop_sites" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );

CREATE TABLE "pharmacy_sop_record_links" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "pharmacyBranchId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "occurrenceStepId" TEXT,
  "recordType" "PharmacySopRecordType" NOT NULL,
  "recordId" TEXT NOT NULL,
  "linkedByStaffProfileId" TEXT NOT NULL,
  "linkedByUserId" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sop_record_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_sop_record_links_organizationId_pharmacyBranchId_fkey"
    FOREIGN KEY ("organizationId", "pharmacyBranchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SQL-only composite keys onto the shared engine tables: the occurrence, step
  -- and acting staff profile must all belong to the link's organization.
  CONSTRAINT "pharmacy_sop_record_links_occurrence_fkey"
    FOREIGN KEY ("organizationId", "occurrenceId")
    REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_record_links_step_fkey"
    FOREIGN KEY ("organizationId", "occurrenceStepId")
    REFERENCES "restaurant_sop_occurrence_steps" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_record_links_staff_fkey"
    FOREIGN KEY ("organizationId", "linkedByStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_record_links_evidence_check" CHECK (
    length(btrim("recordId")) > 0 AND
    length(btrim("linkedByUserId")) > 0 AND
    ("note" IS NULL OR length("note") <= 2000)
  )
);
CREATE UNIQUE INDEX "pharmacy_sop_record_links_org_id_key"
  ON "pharmacy_sop_record_links" ("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_sop_record_links_identity_key"
  ON "pharmacy_sop_record_links" ("organizationId", "occurrenceId", "recordType", "recordId");
CREATE INDEX "pharmacy_sop_record_links_occurrence_idx"
  ON "pharmacy_sop_record_links" ("organizationId", "pharmacyBranchId", "occurrenceId");
CREATE INDEX "pharmacy_sop_record_links_record_idx"
  ON "pharmacy_sop_record_links" ("organizationId", "recordType", "recordId");

-- Defense in depth: a link may only point at an occurrence generated for the
-- engine branch bound to the link's own pharmacy branch, and a step must belong
-- to that occurrence. Runs as the inserting role, so RLS still applies to the
-- lookups and another tenant's rows are simply invisible.
CREATE FUNCTION pharmacy_sop_record_link_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "pharmacy_sop_sites" site
      JOIN "restaurant_sop_occurrences" occurrence
        ON occurrence."organizationId" = site."organizationId"
       AND occurrence."branchId" = site."sopBranchId"
     WHERE site."organizationId" = NEW."organizationId"
       AND site."pharmacyBranchId" = NEW."pharmacyBranchId"
       AND occurrence."id" = NEW."occurrenceId"
  ) THEN
    RAISE EXCEPTION 'SOP record link occurrence is outside its pharmacy SOP site' USING ERRCODE = '23514';
  END IF;
  IF NEW."occurrenceStepId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM "restaurant_sop_occurrence_steps" step
     WHERE step."organizationId" = NEW."organizationId"
       AND step."id" = NEW."occurrenceStepId"
       AND step."occurrenceId" = NEW."occurrenceId"
  ) THEN
    RAISE EXCEPTION 'SOP record link step is outside its occurrence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_sop_record_links_scope
BEFORE INSERT ON "pharmacy_sop_record_links"
FOR EACH ROW EXECUTE FUNCTION pharmacy_sop_record_link_scope_check();

ALTER TABLE "pharmacy_sop_record_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sop_record_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_sop_record_links" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_sop_record_links" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
