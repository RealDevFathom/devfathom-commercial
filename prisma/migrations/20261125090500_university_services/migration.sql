CREATE TABLE university_service_resources (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, campus_id text NOT NULL,
  code text NOT NULL, label text NOT NULL, kind text NOT NULL CHECK(kind IN ('HOSTEL','TRANSPORT','ROOM')),
  capacity integer NOT NULL CHECK(capacity > 0), fee_paisa bigint NOT NULL CHECK(fee_paisa >= 0),
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,campus_id,code),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id)
);
CREATE TABLE university_service_allocations (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, resource_id text NOT NULL,
  person_id text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on >= starts_on),
  released_at timestamptz, release_reason text, charge_reference text,
  PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,resource_id) REFERENCES university_service_resources(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  CHECK((released_at IS NULL) = (release_reason IS NULL))
);
CREATE UNIQUE INDEX university_resource_active_booking_key ON university_service_allocations
  (organization_id,resource_id,person_id,starts_on) WHERE released_at IS NULL;
CREATE INDEX university_active_resource_allocations ON university_service_allocations
  (organization_id,resource_id,starts_on,ends_on) WHERE released_at IS NULL;
CREATE INDEX university_student_service_allocations ON university_service_allocations
  (organization_id,person_id) WHERE released_at IS NULL;
CREATE TABLE university_facilities_cases (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, campus_id text NOT NULL,
  location text NOT NULL, description text NOT NULL, priority text NOT NULL CHECK(priority IN ('NORMAL','URGENT')),
  raised_by text NOT NULL, assigned_to text, resolution text, closed_at timestamptz,
  opened_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY(organization_id,raised_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,assigned_to) REFERENCES users("organizationId",id),
  CHECK((closed_at IS NULL) = (resolution IS NULL)), CHECK(closed_at IS NULL OR assigned_to IS NOT NULL)
);
CREATE TABLE university_library_loans (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL,
  barcode text NOT NULL, title text NOT NULL, due_on date NOT NULL, borrowed_at timestamptz NOT NULL DEFAULT now(),
  returned_at timestamptz, PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id)
);
CREATE UNIQUE INDEX university_open_item_loan ON university_library_loans(organization_id,barcode) WHERE returned_at IS NULL;
CREATE INDEX university_open_borrower_loans ON university_library_loans(organization_id,person_id) WHERE returned_at IS NULL;
CREATE TABLE university_staff_appointments (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, user_id text NOT NULL,
  campus_id text NOT NULL, reference text NOT NULL, position text NOT NULL, starts_on date NOT NULL,
  ends_on date NOT NULL CHECK(ends_on >= starts_on), monthly_paisa bigint NOT NULL CHECK(monthly_paisa >= 0),
  load_minutes integer NOT NULL CHECK(load_minutes >= 0), PRIMARY KEY(organization_id,id), UNIQUE(organization_id,reference),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY(organization_id,user_id) REFERENCES users("organizationId",id)
);
CREATE TABLE university_teaching_loads (
  organization_id text NOT NULL, section_id text NOT NULL, appointment_id text NOT NULL,
  PRIMARY KEY(organization_id,section_id),
  FOREIGN KEY(organization_id,section_id) REFERENCES university_sections(organization_id,id),
  FOREIGN KEY(organization_id,appointment_id) REFERENCES university_staff_appointments(organization_id,id)
);
CREATE TABLE university_procurement_requests (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, reference text NOT NULL,
  campus_id text NOT NULL, grant_id text, category text NOT NULL, supplier text NOT NULL, description text NOT NULL,
  amount_paisa bigint NOT NULL CHECK(amount_paisa>0), needed_on date NOT NULL, created_by text NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','REJECTED','RECEIVED','CANCELLED')),
  decision_by text, decision_reason text, receipt_reference text, received_on date,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id), UNIQUE(organization_id,reference),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,decision_by) REFERENCES users("organizationId",id),
  CHECK(decision_by IS NULL OR decision_by <> created_by),
  CHECK(status NOT IN ('APPROVED','RECEIVED','REJECTED') OR decision_by IS NOT NULL),
  CHECK((status='RECEIVED') = (receipt_reference IS NOT NULL AND received_on IS NOT NULL))
);
CREATE INDEX university_procurement_award ON university_procurement_requests(organization_id,grant_id,status);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_service_resources','university_service_allocations','university_facilities_cases',
    'university_library_loans','university_staff_appointments','university_teaching_loads','university_procurement_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
END $$;
