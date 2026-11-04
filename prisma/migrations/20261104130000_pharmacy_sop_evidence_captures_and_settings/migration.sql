-- DEV-751: durable pharmacy SOP capture receipts and per-branch SOP settings.
--
-- pharmacy_sop_evidence_captures  APPEND-ONLY, server-issued receipt that one
--                          engine evidence row (restaurant_sop_evidence) was
--                          captured through the pharmacy workspace. It is the
--                          provenance authority for pharmacy proof and does not
--                          depend on any secret: rotating AUTH_SECRET never
--                          makes earlier pharmacy proof look foreign. Only the
--                          pharmacy evidence route (source UPLOAD) and the
--                          manual one-off legacy backfill script (source
--                          LEGACY_HMAC_BACKFILL) write it.
-- pharmacy_sop_site_settings APPEND-ONLY per-branch SOP settings history; the
--                          newest row for a pharmacy branch is in force. With
--                          no row automatic scheduling is OFF.
--
-- Additive only: no data is changed and nothing is backfilled (the legacy
-- receipt backfill is a separate, manual, dry-run-by-default script:
-- scripts/pharmacy-sop-legacy-capture-backfill.ts). The one change to an
-- existing table is an additional UNIQUE ("organizationId", "id") constraint on
-- restaurant_sop_evidence, the same tenant-key constraint every other engine
-- table already carries; "id" is its primary key, so the constraint always
-- holds and changes no row. It is what lets a receipt reference its evidence
-- row by a tenant-keyed composite foreign key.
--
-- Both new tables carry forced RLS with the pharmacy tenant/branch clause
-- (app.current_organization_id, optional app.current_branch_id, and the
-- app.is_platform_admin control-plane escape) and SELECT + INSERT policies
-- only, so the runtime role cannot UPDATE or DELETE a receipt or a setting.

CREATE TYPE "PharmacySopCaptureSource" AS ENUM ('UPLOAD', 'LEGACY_HMAC_BACKFILL');

-- Tenant key for the composite receipt foreign key below (see header).
ALTER TABLE "restaurant_sop_evidence"
  ADD CONSTRAINT "restaurant_sop_evidence_organizationId_id_key" UNIQUE ("organizationId", "id");

CREATE TABLE "pharmacy_sop_evidence_captures" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "pharmacyBranchId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "evidenceId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "source" "PharmacySopCaptureSource" NOT NULL,
  "capturedByStaffProfileId" TEXT,
  "capturedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sop_evidence_captures_pkey" PRIMARY KEY ("id"),
  -- Named explicitly: the Prisma-style default exceeds the 63-byte identifier limit.
  CONSTRAINT "pharmacy_sop_evidence_captures_pharmacy_branch_fkey"
    FOREIGN KEY ("organizationId", "pharmacyBranchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SQL-only composite keys onto the shared engine tables: the evidence row,
  -- its occurrence and the capturing staff profile all belong to the
  -- receipt's organization. RESTRICT keeps a receipt from being orphaned.
  CONSTRAINT "pharmacy_sop_evidence_captures_evidence_fkey"
    FOREIGN KEY ("organizationId", "evidenceId")
    REFERENCES "restaurant_sop_evidence" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_evidence_captures_occurrence_fkey"
    FOREIGN KEY ("organizationId", "occurrenceId")
    REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_evidence_captures_staff_fkey"
    FOREIGN KEY ("organizationId", "capturedByStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_evidence_captures_identity_check" CHECK (
    length(btrim("id")) > 0 AND
    length(btrim("pharmacyBranchId")) > 0 AND
    length(btrim("occurrenceId")) > 0 AND
    length(btrim("evidenceId")) > 0 AND
    length(btrim("contentHash")) > 0 AND
    ("capturedByStaffProfileId" IS NULL OR length(btrim("capturedByStaffProfileId")) > 0) AND
    ("capturedByUserId" IS NULL OR length(btrim("capturedByUserId")) > 0)
  ),
  -- A live upload always names who captured it; only the legacy backfill may
  -- leave the signed-in user unknown.
  CONSTRAINT "pharmacy_sop_evidence_captures_upload_actor_check" CHECK (
    "source" <> 'UPLOAD' OR
    ("capturedByStaffProfileId" IS NOT NULL AND "capturedByUserId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "pharmacy_sop_evidence_captures_org_id_key"
  ON "pharmacy_sop_evidence_captures" ("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_sop_evidence_captures_org_evidence_key"
  ON "pharmacy_sop_evidence_captures" ("organizationId", "evidenceId");
CREATE INDEX "pharmacy_sop_evidence_captures_occurrence_idx"
  ON "pharmacy_sop_evidence_captures" ("organizationId", "pharmacyBranchId", "occurrenceId");

-- A receipt must describe its evidence row exactly: the row exists in the same
-- organization, belongs to the receipt's occurrence, carries the receipt's
-- content hash, and that occurrence was generated for the engine branch bound
-- to the receipt's pharmacy branch. When a capturing staff profile is named it
-- must be the evidence row's uploader; a live UPLOAD must name one. Runs as the
-- inserting role (not SECURITY DEFINER), so RLS still applies to the lookups
-- and another tenant's rows are simply invisible.
CREATE FUNCTION pharmacy_sop_evidence_capture_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evidence_occurrence TEXT;
  evidence_hash TEXT;
  evidence_uploader TEXT;
BEGIN
  SELECT evidence."occurrenceId", evidence."contentHash", evidence."uploaderStaffProfileId"
    INTO evidence_occurrence, evidence_hash, evidence_uploader
    FROM "restaurant_sop_evidence" evidence
   WHERE evidence."organizationId" = NEW."organizationId"
     AND evidence."id" = NEW."evidenceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOP capture receipt evidence is not in its organization' USING ERRCODE = '23514';
  END IF;
  IF evidence_occurrence IS DISTINCT FROM NEW."occurrenceId" THEN
    RAISE EXCEPTION 'SOP capture receipt occurrence does not match its evidence' USING ERRCODE = '23514';
  END IF;
  IF evidence_hash IS DISTINCT FROM NEW."contentHash" THEN
    RAISE EXCEPTION 'SOP capture receipt content hash does not match its evidence' USING ERRCODE = '23514';
  END IF;
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
    RAISE EXCEPTION 'SOP capture receipt occurrence is outside its pharmacy SOP site' USING ERRCODE = '23514';
  END IF;
  IF NEW."source" = 'UPLOAD' AND NEW."capturedByStaffProfileId" IS NULL THEN
    RAISE EXCEPTION 'SOP capture receipt upload has no capturing staff profile' USING ERRCODE = '23514';
  END IF;
  IF NEW."capturedByStaffProfileId" IS NOT NULL
     AND evidence_uploader IS DISTINCT FROM NEW."capturedByStaffProfileId" THEN
    RAISE EXCEPTION 'SOP capture receipt staff profile is not the evidence uploader' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_sop_evidence_captures_check
BEFORE INSERT ON "pharmacy_sop_evidence_captures"
FOR EACH ROW EXECUTE FUNCTION pharmacy_sop_evidence_capture_check();

ALTER TABLE "pharmacy_sop_evidence_captures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sop_evidence_captures" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_sop_evidence_captures" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_sop_evidence_captures" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );

CREATE TABLE "pharmacy_sop_site_settings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "pharmacyBranchId" TEXT NOT NULL,
  "autoScheduleEnabled" BOOLEAN NOT NULL,
  "changedByUserId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sop_site_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_sop_site_settings_organizationId_pharmacyBranchId_fkey"
    FOREIGN KEY ("organizationId", "pharmacyBranchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_sop_site_settings_identity_check" CHECK (
    length(btrim("id")) > 0 AND
    length(btrim("pharmacyBranchId")) > 0 AND
    length(btrim("changedByUserId")) > 0 AND
    ("reason" IS NULL OR length("reason") <= 500)
  )
);
CREATE UNIQUE INDEX "pharmacy_sop_site_settings_org_id_key"
  ON "pharmacy_sop_site_settings" ("organizationId", "id");
CREATE INDEX "pharmacy_sop_site_settings_branch_time_idx"
  ON "pharmacy_sop_site_settings" ("organizationId", "pharmacyBranchId", "createdAt");

ALTER TABLE "pharmacy_sop_site_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sop_site_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_sop_site_settings" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_sop_site_settings" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
