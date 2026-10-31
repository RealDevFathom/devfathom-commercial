-- Correct the new discount tables without changing deployed migration history.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
DROP POLICY tenant_isolation ON pharmacy_competitor_discount_observations;
DROP POLICY tenant_isolation ON pharmacy_smart_discount_policies;
CREATE POLICY tenant_isolation ON pharmacy_competitor_discount_observations
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))));
CREATE POLICY tenant_isolation ON pharmacy_smart_discount_policies
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
      (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
       "branchId" = current_setting('app.current_branch_id', true))));

ALTER TABLE pharmacy_competitor_discount_observations
  ADD CONSTRAINT pharmacy_competitor_discount_observation_pack_fk
  FOREIGN KEY ("organizationId", "packLevelId")
  REFERENCES pharmacy_pack_levels("organizationId", id) ON DELETE RESTRICT;

-- Keep identity valid when either parent is edited, even if branch RLS hides
-- the referencing observation from the editor. Referential checks see all rows.
ALTER TABLE pharmacy_competitor_discount_observations ADD COLUMN "presentationId" TEXT;
UPDATE pharmacy_competitor_discount_observations o SET "presentationId" = p."presentationId"
  FROM pharmacy_pack_levels p WHERE p.id = o."packLevelId" AND p."organizationId" = o."organizationId";
ALTER TABLE pharmacy_competitor_discount_observations ALTER COLUMN "presentationId" SET NOT NULL;
ALTER TABLE pharmacy_pack_levels ADD CONSTRAINT pharmacy_discount_pack_identity_key
  UNIQUE ("organizationId", id, "presentationId");
ALTER TABLE pharmacy_presentations ADD CONSTRAINT pharmacy_discount_presentation_identity_key
  UNIQUE ("organizationId", id, "medicineId");
ALTER TABLE pharmacy_competitor_discount_observations
  ADD CONSTRAINT pharmacy_discount_pack_identity_fk FOREIGN KEY ("organizationId", "packLevelId", "presentationId")
    REFERENCES pharmacy_pack_levels("organizationId", id, "presentationId") ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT pharmacy_discount_medicine_identity_fk FOREIGN KEY ("organizationId", "presentationId", "medicineId")
    REFERENCES pharmacy_presentations("organizationId", id, "medicineId") ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE FUNCTION pharmacy_discount_observation_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT p."presentationId" INTO NEW."presentationId" FROM pharmacy_pack_levels p
    JOIN pharmacy_presentations s ON s.id = p."presentationId" AND s."organizationId" = p."organizationId"
    WHERE p.id = NEW."packLevelId" AND p."organizationId" = NEW."organizationId"
      AND s."medicineId" = NEW."medicineId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid discount observation medicine/pack identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_discount_observation_identity
  BEFORE INSERT OR UPDATE ON pharmacy_competitor_discount_observations
  FOR EACH ROW EXECUTE FUNCTION pharmacy_discount_observation_identity_guard();
COMMIT;
