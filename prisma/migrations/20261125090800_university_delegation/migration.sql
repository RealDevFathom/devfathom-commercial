CREATE TABLE university_fee_delegations (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, student_id text NOT NULL,
  recipient_email text NOT NULL CHECK(recipient_email=lower(btrim(recipient_email))), recipient_id text,
  relationship text NOT NULL CHECK(relationship IN ('GUARDIAN','SPONSOR')),
  permission text NOT NULL CHECK(permission IN ('FINANCIAL_SUMMARY','SPECIFIC_CHALLAN')), challan_reference text,
  consent_version text NOT NULL, consented_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, PRIMARY KEY(organization_id,id), CHECK(expires_at>consented_at),
  CHECK((permission='SPECIFIC_CHALLAN')=(challan_reference IS NOT NULL)),
  CHECK(student_id IS DISTINCT FROM recipient_id),
  FOREIGN KEY(organization_id,student_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,recipient_id) REFERENCES university_people(organization_id,id),
  FOREIGN KEY(organization_id,challan_reference) REFERENCES university_challans(organization_id,reference)
);
CREATE INDEX university_delegations_student ON university_fee_delegations(organization_id,student_id,consented_at);
CREATE INDEX university_delegations_recipient ON university_fee_delegations(organization_id,recipient_email,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE university_fee_delegation_audit (
  organization_id text NOT NULL, id text NOT NULL DEFAULT gen_random_uuid()::text, grant_id text NOT NULL,
  event text NOT NULL CHECK(event IN ('CONSENTED','EXPIRY_SCHEDULED','CLAIMED','VIEWED','REVOKED','EXPIRED')), person_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(), effective_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,grant_id) REFERENCES university_fee_delegations(organization_id,id),
  FOREIGN KEY(organization_id,person_id) REFERENCES university_people(organization_id,id)
);
CREATE UNIQUE INDEX university_delegation_lifecycle_audit ON university_fee_delegation_audit(organization_id,grant_id,event) WHERE event <> 'VIEWED';
ALTER TABLE university_fee_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_fee_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON university_fee_delegations USING(organization_id = current_setting('app.current_organization_id',true))
  WITH CHECK(organization_id = current_setting('app.current_organization_id',true));
ALTER TABLE university_fee_delegation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE university_fee_delegation_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON university_fee_delegation_audit USING(organization_id = current_setting('app.current_organization_id',true))
  WITH CHECK(organization_id = current_setting('app.current_organization_id',true));
CREATE FUNCTION university_immutable_delegation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Delegation audit records are append-only'; END $$;
CREATE TRIGGER university_fee_delegation_audit_immutable BEFORE UPDATE OR DELETE ON university_fee_delegation_audit
  FOR EACH ROW EXECUTE FUNCTION university_immutable_delegation_audit();
