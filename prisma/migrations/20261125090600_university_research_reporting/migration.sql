CREATE TABLE university_research_cases (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text,
  student_program_id text NOT NULL, title text NOT NULL, supervisor_id text NOT NULL,
  status text NOT NULL DEFAULT 'PROPOSAL' CHECK (status IN
    ('PROPOSAL','ETHICS_REVIEW','RESEARCH','EXAMINATION','CORRECTIONS','DEFENSE','COMPLETE')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,student_program_id),
  FOREIGN KEY (organization_id,student_program_id) REFERENCES university_student_programs(organization_id,id),
  FOREIGN KEY (organization_id,supervisor_id) REFERENCES users("organizationId",id),
  FOREIGN KEY (organization_id,created_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_research_decisions (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text,
  case_id text NOT NULL, kind text NOT NULL, prior_status text NOT NULL, next_status text NOT NULL,
  evidence_reference text NOT NULL, recorded_by text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,case_id,kind,evidence_reference),
  FOREIGN KEY (organization_id,case_id) REFERENCES university_research_cases(organization_id,id),
  FOREIGN KEY (organization_id,recorded_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_research_grants (
  organization_id text NOT NULL REFERENCES organizations(id), id text NOT NULL DEFAULT gen_random_uuid()::text,
  code text NOT NULL, sponsor text NOT NULL, title text NOT NULL, budget_minor bigint NOT NULL CHECK (budget_minor > 0),
  currency text NOT NULL DEFAULT 'PKR' CHECK (currency='PKR'), starts_on date NOT NULL, ends_on date NOT NULL,
  restrictions text NOT NULL, allowed_categories text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), closed_by text, closed_at timestamptz, closure_reference text,
  FOREIGN KEY (organization_id,closed_by) REFERENCES users("organizationId",id),
  CHECK(status='ACTIVE' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND closure_reference IS NOT NULL)),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,code), CHECK (ends_on >= starts_on),
  FOREIGN KEY (organization_id,created_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_grant_deliverables (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, grant_id text NOT NULL,
  title text NOT NULL, due_on date NOT NULL, receipt text, accepted_at timestamptz, accepted_by text,
  PRIMARY KEY (organization_id,id), UNIQUE(organization_id,grant_id,title,due_on),
  FOREIGN KEY (organization_id,grant_id) REFERENCES university_research_grants(organization_id,id),
  FOREIGN KEY (organization_id,accepted_by) REFERENCES users("organizationId",id),
  CHECK ((receipt IS NULL AND accepted_at IS NULL AND accepted_by IS NULL)
      OR (receipt IS NOT NULL AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL))
);
CREATE TABLE university_award_verifications (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, award_id text NOT NULL,
  request_reference text NOT NULL, outcome text NOT NULL CHECK (outcome IN ('VERIFIED','DISCREPANCY')),
  university_evidence text NOT NULL, decided_by text NOT NULL, decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,request_reference), UNIQUE (organization_id,id,outcome),
  FOREIGN KEY (organization_id,award_id) REFERENCES university_awards(organization_id,id),
  FOREIGN KEY (organization_id,decided_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_hec_attestations (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, verification_id text NOT NULL,
  university_outcome text NOT NULL DEFAULT 'VERIFIED' CHECK (university_outcome='VERIFIED'),
  hec_reference text NOT NULL, issued_on date NOT NULL, recorded_by text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,verification_id), UNIQUE (organization_id,hec_reference),
  FOREIGN KEY (organization_id,verification_id,university_outcome) REFERENCES university_award_verifications(organization_id,id,outcome),
  FOREIGN KEY (organization_id,recorded_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_census_snapshots (
  organization_id text NOT NULL REFERENCES organizations(id), id text NOT NULL DEFAULT gen_random_uuid()::text,
  period_start date NOT NULL, census_date date NOT NULL CHECK (census_date >= period_start),
  revision integer NOT NULL CHECK (revision > 0), template_reference text NOT NULL, revision_note text NOT NULL,
  payload jsonb NOT NULL, sha256 text NOT NULL CHECK (length(sha256)=64),
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,id), UNIQUE (organization_id,period_start,census_date,revision),
  FOREIGN KEY (organization_id,created_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_census_approvals (
  organization_id text NOT NULL, snapshot_id text NOT NULL, approved_by text NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,snapshot_id),
  FOREIGN KEY (organization_id,snapshot_id) REFERENCES university_census_snapshots(organization_id,id),
  FOREIGN KEY (organization_id,approved_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_census_receipts (
  organization_id text NOT NULL, snapshot_id text NOT NULL, official_reference text NOT NULL,
  recorded_by text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,snapshot_id), UNIQUE (organization_id,official_reference),
  FOREIGN KEY (organization_id,snapshot_id) REFERENCES university_census_approvals(organization_id,snapshot_id),
  FOREIGN KEY (organization_id,recorded_by) REFERENCES users("organizationId",id)
);
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_research_cases','university_research_decisions','university_research_grants',
    'university_grant_deliverables','university_award_verifications','university_hec_attestations',
    'university_census_snapshots','university_census_approvals','university_census_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
  FOREACH tab IN ARRAY ARRAY['university_research_cases','university_research_grants','university_grant_deliverables'] LOOP
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
END $$;

CREATE INDEX university_research_decision_history ON university_research_decisions(organization_id,case_id,recorded_at);
CREATE INDEX university_grant_sponsor_deadlines ON university_grant_deliverables(organization_id,due_on) WHERE receipt IS NULL;
