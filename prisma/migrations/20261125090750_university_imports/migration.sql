CREATE TABLE university_import_batches (
  organization_id text NOT NULL REFERENCES organizations(id),
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  source_system text NOT NULL, source_batch text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'), evidence text NOT NULL,
  manifest jsonb NOT NULL, controls jsonb NOT NULL,
  state text NOT NULL DEFAULT 'STAGED' CHECK(state IN ('STAGED','VALIDATED','FINALIZED','CANCELLED')),
  prepared_by text NOT NULL, validated_by text, finance_signed_by text, finalized_by text, cancelled_by text, cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(), validated_at timestamptz, finance_signed_at timestamptz, finalized_at timestamptz, cancelled_at timestamptz,
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,source_system,source_batch,revision),
  FOREIGN KEY(organization_id,prepared_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,validated_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,finance_signed_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,finalized_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,cancelled_by) REFERENCES users("organizationId",id),
  CHECK(validated_by IS NULL OR validated_by <> prepared_by),
  CHECK(finance_signed_by IS NULL OR (finance_signed_by <> prepared_by AND finance_signed_by <> validated_by))
);
CREATE UNIQUE INDEX university_import_one_live_revision ON university_import_batches(organization_id,source_system,source_batch) WHERE state <> 'CANCELLED';

CREATE TABLE university_import_person_links (
  organization_id text NOT NULL, source_system text NOT NULL, source_student_id text NOT NULL, person_id text NOT NULL, first_batch_id text NOT NULL,
  PRIMARY KEY(organization_id,source_system,source_student_id), UNIQUE(organization_id,source_system,person_id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,first_batch_id) REFERENCES university_import_batches(organization_id,id)
);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_import_batches','university_import_person_links'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY tenant_import_select ON %I FOR SELECT USING (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND current_setting(''app.university_staff_scope'',true) = ''institution'')', tab);
    EXECUTE format('CREATE POLICY tenant_import_insert ON %I FOR INSERT WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),'''') AND current_setting(''app.university_staff_scope'',true) = ''institution'')', tab);
  END LOOP;
END $$;
CREATE POLICY tenant_import_update ON university_import_batches FOR UPDATE
  USING (organization_id = NULLIF(current_setting('app.current_organization_id',true),'') AND current_setting('app.university_staff_scope',true)='institution')
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id',true),'') AND current_setting('app.university_staff_scope',true)='institution');

CREATE FUNCTION university_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('CANCELLED','FINALIZED') OR NEW.digest <> OLD.digest OR NEW.manifest <> OLD.manifest OR NEW.controls <> OLD.controls OR
     ROW(NEW.organization_id,NEW.id,NEW.prepared_by,NEW.source_system,NEW.source_batch,NEW.revision,NEW.evidence)
     IS DISTINCT FROM ROW(OLD.organization_id,OLD.id,OLD.prepared_by,OLD.source_system,OLD.source_batch,OLD.revision,OLD.evidence) THEN
    RAISE EXCEPTION 'Historical import source and closed batches are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER university_import_immutable BEFORE UPDATE ON university_import_batches
  FOR EACH ROW EXECUTE FUNCTION university_import_guard();
