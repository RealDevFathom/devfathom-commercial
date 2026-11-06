-- DEV-751: append-only rework notes for pharmacy procedures sent back by a reviewer.
--
-- pharmacy_sop_rework_notes  APPEND-ONLY. After a reviewer sends a procedure
--                          back (an engine REJECT verification), the engine
--                          keeps its steps completed, so re-completing a step
--                          changes nothing. What the worker changed in response
--                          is recorded here: one or more notes, optionally per
--                          step, each tied to the send-back it answers.
--                          Resubmission requires at least one note for the
--                          latest send-back. Only the pharmacy SOP router
--                          writes it, with a server-derived author. A note
--                          never blocks or changes any pharmacy workflow.
--
-- Additive only: no data is changed and nothing is backfilled. No existing
-- table is altered: the send-back is referenced by the verification primary
-- key (restaurant_sop_verifications has no tenant composite key), and the
-- BEFORE INSERT trigger below refuses any note whose verification is not a
-- REJECT of the same occurrence in the note's own organization.
--
-- Forced RLS with the pharmacy tenant/branch clause (app.current_organization_id,
-- optional app.current_branch_id, and the app.is_platform_admin control-plane
-- escape) and SELECT + INSERT policies only, so the runtime role cannot UPDATE
-- or DELETE a note.

CREATE TABLE "pharmacy_sop_rework_notes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "pharmacyBranchId" TEXT NOT NULL,
  "occurrenceId" TEXT NOT NULL,
  "occurrenceStepId" TEXT,
  "rejectionVerificationId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "authorStaffProfileId" TEXT NOT NULL,
  "authorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_sop_rework_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_sop_rework_notes_organizationId_pharmacyBranchId_fkey"
    FOREIGN KEY ("organizationId", "pharmacyBranchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- SQL-only keys onto the shared engine tables. The occurrence, the step and
  -- the author are tenant-keyed composites; RESTRICT keeps a note from being
  -- orphaned.
  CONSTRAINT "pharmacy_sop_rework_notes_occurrence_fkey"
    FOREIGN KEY ("organizationId", "occurrenceId")
    REFERENCES "restaurant_sop_occurrences" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_rework_notes_step_fkey"
    FOREIGN KEY ("organizationId", "occurrenceStepId")
    REFERENCES "restaurant_sop_occurrence_steps" ("organizationId", "id") ON DELETE RESTRICT,
  -- The send-back by primary key (no tenant composite key exists, and this
  -- migration leaves engine tables untouched); the trigger enforces that it is
  -- a REJECT of this occurrence in the note's organization.
  CONSTRAINT "pharmacy_sop_rework_notes_rejection_fkey"
    FOREIGN KEY ("rejectionVerificationId")
    REFERENCES "restaurant_sop_verifications" ("id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_rework_notes_author_fkey"
    FOREIGN KEY ("organizationId", "authorStaffProfileId")
    REFERENCES "restaurant_staff_profiles" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_sop_rework_notes_identity_check" CHECK (
    length(btrim("id")) > 0 AND
    length(btrim("pharmacyBranchId")) > 0 AND
    length(btrim("occurrenceId")) > 0 AND
    ("occurrenceStepId" IS NULL OR length(btrim("occurrenceStepId")) > 0) AND
    length(btrim("rejectionVerificationId")) > 0 AND
    length(btrim("authorStaffProfileId")) > 0 AND
    length(btrim("authorUserId")) > 0
  ),
  CONSTRAINT "pharmacy_sop_rework_notes_note_check" CHECK (
    length(btrim("note")) > 0 AND length("note") <= 2000
  )
);
CREATE UNIQUE INDEX "pharmacy_sop_rework_notes_org_id_key"
  ON "pharmacy_sop_rework_notes" ("organizationId", "id");
CREATE INDEX "pharmacy_sop_rework_notes_occurrence_idx"
  ON "pharmacy_sop_rework_notes" ("organizationId", "pharmacyBranchId", "occurrenceId");

-- A note must answer the send-back in force: the verification exists in the
-- note's organization, is a REJECT of the note's occurrence, and is that
-- occurrence's LATEST verification (a note can never be filed against an older
-- send-back). The occurrence was generated for the engine branch bound to the
-- note's pharmacy branch, is back IN_PROGRESS (restarted for rework) and is the
-- author's own work (assignee, else claimer). A named step belongs to the
-- occurrence. Runs as the inserting role (not SECURITY DEFINER), so RLS still
-- applies to the lookups and another tenant's rows are simply invisible.
CREATE FUNCTION pharmacy_sop_rework_note_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rejection_action TEXT;
  rejection_occurrence TEXT;
  rejection_created TIMESTAMP(3);
  occurrence_status TEXT;
  occurrence_owner TEXT;
BEGIN
  SELECT verification."action"::text, verification."occurrenceId", verification."createdAt"
    INTO rejection_action, rejection_occurrence, rejection_created
    FROM "restaurant_sop_verifications" verification
   WHERE verification."organizationId" = NEW."organizationId"
     AND verification."id" = NEW."rejectionVerificationId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOP rework note send-back is not in its organization' USING ERRCODE = '23514';
  END IF;
  IF rejection_action IS DISTINCT FROM 'REJECT' THEN
    RAISE EXCEPTION 'SOP rework note does not answer a send-back' USING ERRCODE = '23514';
  END IF;
  IF rejection_occurrence IS DISTINCT FROM NEW."occurrenceId" THEN
    RAISE EXCEPTION 'SOP rework note send-back belongs to another occurrence' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM "restaurant_sop_verifications" later
     WHERE later."organizationId" = NEW."organizationId"
       AND later."occurrenceId" = NEW."occurrenceId"
       AND later."id" <> NEW."rejectionVerificationId"
       AND (later."createdAt" > rejection_created
            OR (later."createdAt" = rejection_created AND later."id" > NEW."rejectionVerificationId"))
  ) THEN
    RAISE EXCEPTION 'SOP rework note send-back is not the latest review' USING ERRCODE = '23514';
  END IF;
  SELECT occurrence."status"::text,
         COALESCE(occurrence."assignedStaffProfileId", occurrence."claimedByStaffProfileId")
    INTO occurrence_status, occurrence_owner
    FROM "pharmacy_sop_sites" site
    JOIN "restaurant_sop_occurrences" occurrence
      ON occurrence."organizationId" = site."organizationId"
     AND occurrence."branchId" = site."sopBranchId"
   WHERE site."organizationId" = NEW."organizationId"
     AND site."pharmacyBranchId" = NEW."pharmacyBranchId"
     AND occurrence."id" = NEW."occurrenceId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOP rework note occurrence is outside its pharmacy SOP site' USING ERRCODE = '23514';
  END IF;
  IF occurrence_status IS DISTINCT FROM 'IN_PROGRESS' THEN
    RAISE EXCEPTION 'SOP rework note occurrence is not being reworked' USING ERRCODE = '23514';
  END IF;
  IF occurrence_owner IS DISTINCT FROM NEW."authorStaffProfileId" THEN
    RAISE EXCEPTION 'SOP rework note author does not own the occurrence' USING ERRCODE = '23514';
  END IF;
  IF NEW."occurrenceStepId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM "restaurant_sop_occurrence_steps" step
     WHERE step."organizationId" = NEW."organizationId"
       AND step."id" = NEW."occurrenceStepId"
       AND step."occurrenceId" = NEW."occurrenceId"
  ) THEN
    RAISE EXCEPTION 'SOP rework note step is not on its occurrence' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_sop_rework_notes_check
BEFORE INSERT ON "pharmacy_sop_rework_notes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_sop_rework_note_check();

ALTER TABLE "pharmacy_sop_rework_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_sop_rework_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_sop_rework_notes" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_sop_rework_notes" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "pharmacyBranchId" = current_setting('app.current_branch_id', true)))
  );
