BEGIN;
ALTER TABLE university_documents ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE university_applications ADD COLUMN retention_closed_at timestamptz;
-- Historical decisions have no reliable closure timestamp. Begin their retention clock at deployment.
UPDATE university_applications SET retention_closed_at=now() WHERE status IN ('REJECTED','DECLINED','MATRICULATED');
CREATE FUNCTION university_application_retention_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('REJECTED','DECLINED','MATRICULATED') THEN
    IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN NEW.retention_closed_at=now(); END IF;
  ELSE NEW.retention_closed_at=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER university_application_retention_clock BEFORE INSERT OR UPDATE OF status ON university_applications
FOR EACH ROW EXECUTE FUNCTION university_application_retention_clock();
CREATE FUNCTION university_document_retention_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE university_documents SET last_activity_at=now() WHERE organization_id=NEW.organization_id AND id=NEW.document_id;
  RETURN NEW;
END $$;
CREATE TRIGGER university_document_activity AFTER INSERT OR UPDATE ON university_document_parts
FOR EACH ROW EXECUTE FUNCTION university_document_retention_clock();
CREATE FUNCTION university_document_completion_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.last_activity_at=now(); RETURN NEW; END $$;
CREATE TRIGGER university_document_completion_activity BEFORE UPDATE OF complete ON university_documents
FOR EACH ROW WHEN (NEW.complete IS DISTINCT FROM OLD.complete) EXECUTE FUNCTION university_document_completion_clock();

CREATE TABLE university_retention_policies (
  organization_id text NOT NULL REFERENCES organizations(id), id text NOT NULL DEFAULT gen_random_uuid()::text,
  kind text NOT NULL CHECK(kind IN ('APPLICATION_DOCUMENT','INCOMPLETE_UPLOAD','EXPIRED_CHALLENGE','EXPIRED_SESSION')),
  retain_days integer NOT NULL CHECK(retain_days BETWEEN 1 AND 36500), effective_on date NOT NULL,
  authority_reference text NOT NULL, proposed_by text NOT NULL, proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text, approved_at timestamptz,
  PRIMARY KEY(organization_id,id), UNIQUE(organization_id,kind,effective_on),
  FOREIGN KEY(organization_id,proposed_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,approved_by) REFERENCES users("organizationId",id),
  CHECK((approved_by IS NULL AND approved_at IS NULL) OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND proposed_by<>approved_by))
);
CREATE TABLE university_retention_reviews (
  organization_id text NOT NULL REFERENCES organizations(id),id text NOT NULL DEFAULT gen_random_uuid()::text,
  policy_id text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PREVIEW' CHECK(status IN ('PREVIEW','APPROVED','PURGED','DISCARDED')),
  approved_by text,approved_at timestamptz,approval_reference text,finished_by text,finished_at timestamptz,
  PRIMARY KEY(organization_id,id), FOREIGN KEY(organization_id,policy_id) REFERENCES university_retention_policies(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,approved_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,finished_by) REFERENCES users("organizationId",id),
  CHECK(status NOT IN ('APPROVED','PURGED') OR (approved_by IS NOT NULL AND approved_by<>created_by AND approved_at IS NOT NULL AND approval_reference IS NOT NULL))
);
CREATE TABLE university_retention_candidates (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,review_id text NOT NULL,
  target_key text NOT NULL,reference_time timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PURGED','SKIPPED')),
  PRIMARY KEY(organization_id,id),UNIQUE(organization_id,review_id,target_key),
  FOREIGN KEY(organization_id,review_id) REFERENCES university_retention_reviews(organization_id,id)
);
CREATE TABLE university_retention_holds (
  organization_id text NOT NULL REFERENCES organizations(id),id text NOT NULL DEFAULT gen_random_uuid()::text,
  scope text NOT NULL CHECK(scope IN ('INSTITUTION','PERSON','DOCUMENT','CANDIDATE')),target_key text NOT NULL,
  authority_reference text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  released_by text,released_at timestamptz,release_reference text,PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,created_by) REFERENCES users("organizationId",id),
  FOREIGN KEY(organization_id,released_by) REFERENCES users("organizationId",id)
);
CREATE INDEX university_active_legal_holds ON university_retention_holds(organization_id,scope,target_key) WHERE released_at IS NULL;
-- Retain the document's access audit independently of the erased payload and its unneeded filename/hash.
CREATE TABLE university_retained_access_audit (
  organization_id text NOT NULL,id text NOT NULL DEFAULT gen_random_uuid()::text,candidate_id text NOT NULL,
  actor_id text NOT NULL,actor_realm text NOT NULL,read_at timestamptz NOT NULL,PRIMARY KEY(organization_id,id),
  FOREIGN KEY(organization_id,candidate_id) REFERENCES university_retention_candidates(organization_id,id)
);
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['university_retention_policies','university_retention_reviews','university_retention_candidates',
      'university_retention_holds','university_retained_access_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (organization_id=current_setting(''app.current_organization_id'',true))',t);
    EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (organization_id=current_setting(''app.current_organization_id'',true))',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['university_retention_policies','university_retention_reviews','university_retention_candidates','university_retention_holds'] LOOP
    EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (organization_id=current_setting(''app.current_organization_id'',true)) WITH CHECK (organization_id=current_setting(''app.current_organization_id'',true))',t);
  END LOOP;
END $$;
CREATE VIEW university_retention_sources WITH (security_invoker=true) AS
SELECT d.organization_id,d.id AS target_key,d.person_id,'INCOMPLETE_UPLOAD'::text AS kind,d.last_activity_at AS reference_time
FROM university_documents d WHERE NOT d.complete
UNION ALL
SELECT d.organization_id,d.id,d.person_id,'APPLICATION_DOCUMENT'::text,
    greatest(d.last_activity_at,closure.last_closed,study.last_ended) AS reference_time
FROM university_documents d
LEFT JOIN LATERAL (SELECT max(a.retention_closed_at) AS last_closed,
    bool_and(a.retention_closed_at IS NOT NULL AND a.status IN ('REJECTED','DECLINED','MATRICULATED')) AS all_closed
    FROM university_applications a WHERE a.organization_id=d.organization_id AND a.person_id=d.person_id) closure ON true
LEFT JOIN LATERAL (SELECT max(sp.ended_at) AS last_ended,bool_and(sp.status<>'ACTIVE' AND sp.ended_at IS NOT NULL) AS all_ended
    FROM university_student_programs sp WHERE sp.organization_id=d.organization_id AND sp.person_id=d.person_id) study ON true
WHERE d.complete AND coalesce(closure.all_closed,true) AND coalesce(study.all_ended,true)
 AND NOT EXISTS (SELECT FROM university_application_drafts ad WHERE ad.organization_id=d.organization_id AND ad.person_id=d.person_id)
UNION ALL
SELECT c.organization_id,c.id,p.id,'EXPIRED_CHALLENGE'::text,c.expires_at
FROM university_portal_challenges c LEFT JOIN university_people p ON p.organization_id=c.organization_id AND p.email=c.email WHERE c.expires_at<=now()
UNION ALL
SELECT s.organization_id,s.token_hash,s.person_id,'EXPIRED_SESSION'::text,s.expires_at FROM university_portal_sessions s WHERE s.expires_at<=now();
CREATE VIEW university_active_retention_policies WITH (security_invoker=true) AS
SELECT DISTINCT ON (organization_id,kind) * FROM university_retention_policies
 WHERE approved_at IS NOT NULL AND effective_on<=(now() AT TIME ZONE 'Asia/Karachi')::date ORDER BY organization_id,kind,effective_on DESC;
CREATE VIEW university_retention_eligible WITH (security_invoker=true) AS
SELECT s.organization_id,s.target_key,s.kind,s.person_id,s.reference_time,p.id AS policy_id
FROM university_retention_sources s JOIN university_active_retention_policies p ON (p.organization_id,p.kind)=(s.organization_id,s.kind)
WHERE s.reference_time<=now()-p.retain_days*interval '1 day' AND NOT EXISTS (
 SELECT FROM university_retention_holds h WHERE h.organization_id=s.organization_id AND h.released_at IS NULL
 AND (h.scope='INSTITUTION' OR (h.scope='PERSON' AND h.target_key=s.person_id) OR
      (h.scope='DOCUMENT' AND s.kind IN ('INCOMPLETE_UPLOAD','APPLICATION_DOCUMENT') AND h.target_key=s.target_key) OR
      (h.scope='CANDIDATE' AND h.target_key=s.kind || '/' || s.target_key))
);
COMMIT;
