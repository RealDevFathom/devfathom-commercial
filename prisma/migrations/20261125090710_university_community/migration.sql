CREATE TABLE university_housing_waitlist (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, person_id text NOT NULL,
  resource_id text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL CHECK (ends_on >= starts_on),
  status text NOT NULL DEFAULT 'WAITING' CHECK(status IN ('WAITING','ALLOCATED','CANCELLED','EXPIRED')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(), allocation_id text,
  PRIMARY KEY(organization_id,id), CHECK((status='ALLOCATED')=(allocation_id IS NOT NULL)),
  FOREIGN KEY(organization_id,resource_id) REFERENCES university_service_resources(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,allocation_id) REFERENCES university_service_allocations(organization_id,id)
);
CREATE UNIQUE INDEX university_housing_active_queue ON university_housing_waitlist(organization_id,person_id,resource_id,starts_on,ends_on) WHERE status='WAITING';
CREATE INDEX university_housing_fair_order ON university_housing_waitlist(organization_id,resource_id,status,queued_at,id);
CREATE TABLE university_dining_plans (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text,campus_id text NOT NULL,
  name text NOT NULL,meals integer NOT NULL CHECK(meals>0),fee_paisa bigint NOT NULL CHECK(fee_paisa>=0),
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,campus_id,name),
  FOREIGN KEY(organization_id,campus_id) REFERENCES university_campuses(organization_id,id)
);
CREATE TABLE university_dining_memberships (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,person_id text NOT NULL,plan_id text NOT NULL,
  starts_on date NOT NULL,ends_on date NOT NULL CHECK(ends_on>=starts_on),remaining integer NOT NULL CHECK(remaining>=0),
  cancelled_at timestamptz,PRIMARY KEY(organization_id,id),UNIQUE(organization_id,person_id,plan_id,starts_on),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,plan_id) REFERENCES university_dining_plans(organization_id,id)
);
CREATE TABLE university_dining_redemptions (
  organization_id text NOT NULL,reference text NOT NULL,membership_id text NOT NULL,redeemed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,reference),
  FOREIGN KEY(organization_id,membership_id) REFERENCES university_dining_memberships(organization_id,id)
);
CREATE TABLE university_private_cases (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,person_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('ADVISING','GRIEVANCE')),message text NOT NULL,opened_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')),resolution text,resolved_at timestamptz,resolved_by text,
  PRIMARY KEY(organization_id,id),FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,resolved_by) REFERENCES users("organizationId",id),
  CHECK((status='RESOLVED')=(resolution IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX university_private_subject ON university_private_cases(organization_id,person_id,opened_at);
CREATE TABLE university_alumni_preferences (
  organization_id text NOT NULL,person_id text NOT NULL,opted_in boolean NOT NULL,changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,person_id),FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id)
);
CREATE TABLE university_career_opportunities (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,title text NOT NULL,employer text NOT NULL,
  description text NOT NULL,closes_on date NOT NULL,posted_by text NOT NULL,PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,posted_by) REFERENCES users("organizationId",id)
);
CREATE TABLE university_career_applications (
  organization_id text NOT NULL,opportunity_id text NOT NULL,person_id text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,opportunity_id,person_id),
  FOREIGN KEY(organization_id,opportunity_id) REFERENCES university_career_opportunities(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id)
);
CREATE TABLE university_verification_requests (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,person_id text NOT NULL,award_id text NOT NULL,
  recipient text NOT NULL,status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','VERIFIED','DECLINED')),
  requested_at timestamptz NOT NULL DEFAULT now(),verified_by text,decision_note text,verification_id text,PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,award_id) REFERENCES university_awards(organization_id,id),
  FOREIGN KEY(organization_id,verification_id) REFERENCES university_award_verifications(organization_id,id),
  FOREIGN KEY(organization_id,verified_by) REFERENCES users("organizationId",id),
  CHECK(status='REQUESTED' OR (verified_by IS NOT NULL AND decision_note IS NOT NULL)),
  CHECK((status='VERIFIED')=(verification_id IS NOT NULL))
);
CREATE UNIQUE INDEX university_verification_open ON university_verification_requests(organization_id,award_id,recipient) WHERE status='REQUESTED';
DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['university_housing_waitlist','university_dining_plans','university_dining_memberships',
    'university_dining_redemptions','university_private_cases','university_alumni_preferences','university_career_opportunities',
    'university_career_applications','university_verification_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR organization_id=NULLIF(current_setting(''app.current_organization_id'',true),''''))',tab);
  END LOOP;
END $$;
